import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AppRole, PostCollaboratorRole, PostRow, ProfileRow, TagRow } from "@/lib/db/types";

type PostAuthor = Pick<ProfileRow, "id" | "full_name" | "email" | "avatar_url" | "role">;

export interface PostWithAuthor extends PostRow {
  author: PostAuthor | null;
  tags: Pick<TagRow, "id" | "name" | "slug">[];
  /** Aggregate post_views count — populated by helpers that opt-in via `withViews`. */
  viewCount?: number;
}

const POST_SELECT = `
  id, author_id, title, slug, excerpt, content_json, content_html, status,
  week_start_date, assigned_weekday, published_at, scheduled_for, cover_media_id,
  read_time_minutes, created_at, updated_at, archived_at,
  author:profiles!posts_author_id_fkey ( id, full_name, email, avatar_url, role ),
  tags:post_tags ( tag:tags ( id, name, slug ) )
`;

function normalizeTags(raw: unknown): { id: string; name: string; slug: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const tag = (entry as { tag?: unknown })?.tag;
      if (!tag || typeof tag !== "object") return null;
      const t = tag as Record<string, unknown>;
      if (typeof t.id !== "string" || typeof t.name !== "string" || typeof t.slug !== "string") return null;
      return { id: t.id, name: t.name, slug: t.slug };
    })
    .filter((t): t is { id: string; name: string; slug: string } => t !== null);
}

function normalizeRow(row: Record<string, unknown>): PostWithAuthor {
  const tags = normalizeTags(row.tags);
  const authorRaw = row.author as unknown as Record<string, unknown> | null;
  return {
    ...(row as unknown as PostRow),
    author: authorRaw
      ? {
          id: String(authorRaw.id ?? ""),
          full_name: (authorRaw.full_name as string | null) ?? null,
          email: String(authorRaw.email ?? ""),
          avatar_url: (authorRaw.avatar_url as string | null) ?? null,
          role: ((authorRaw.role as AppRole | undefined) ?? "viewer") as AppRole,
        }
      : null,
    tags,
  };
}

export interface ListPostsParams {
  search?: string;
  tag?: string;
  authorId?: string;
  status?: PostRow["status"];
  weekStart?: string;
  mediaType?: "image" | "video" | "audio";
  limit?: number;
  offset?: number;
}

// PostgREST `or` separates filters by commas and groups by parentheses, so
// commas/parens inside a search term break parsing. The safest containment is
// to drop characters that have any meaning in PostgREST filter syntax.
function escapeSearchTerm(input: string): string {
  return input
    .replace(/[%_\\]/g, " ") // ilike wildcards
    .replace(/[(),*:]/g, " ") // PostgREST filter delimiters
    .trim();
}

export async function listPublishedPosts(params: ListPostsParams = {}): Promise<PostWithAuthor[]> {
  const supabase = await createSupabaseServerClient();
  const limit = params.limit ?? 30;
  const offset = params.offset ?? 0;

  // If filtering by tag, resolve the matching post IDs first. Two round-trips
  // beats fighting PostgREST aliasing when post_tags is already aliased in the
  // main SELECT, and it makes the post-list query a simple `id in (...)`.
  let postIdsForTag: string[] | null = null;
  if (params.tag) {
    const { data: tagRow } = await supabase
      .from("tags")
      .select("id")
      .eq("slug", params.tag)
      .maybeSingle();
    if (!tagRow) return [];
    const tagId = (tagRow as { id: string }).id;
    const { data: ptRows } = await supabase
      .from("post_tags")
      .select("post_id")
      .eq("tag_id", tagId);
    postIdsForTag = (ptRows ?? []).map((r) => (r as { post_id: string }).post_id);
    if (postIdsForTag.length === 0) return [];
  }

  let q = supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("status", params.status ?? "published")
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (postIdsForTag) q = q.in("id", postIdsForTag);
  if (params.search) {
    const term = escapeSearchTerm(params.search);
    if (term) {
      q = q.or(`title.ilike.%${term}%,excerpt.ilike.%${term}%,content_html.ilike.%${term}%`);
    }
  }
  if (params.authorId) q = q.eq("author_id", params.authorId);
  if (params.weekStart) q = q.eq("week_start_date", params.weekStart);

  const { data, error } = await q;
  if (error) {
    console.error("[listPublishedPosts]", error);
    return [];
  }
  return (data ?? []).map((r) => normalizeRow(r as unknown as Record<string, unknown>));
}

export async function getPostBySlug(slug: string): Promise<PostWithAuthor | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("slug", slug)
    .maybeSingle();
  if (error || !data) return null;
  return normalizeRow(data as unknown as Record<string, unknown>);
}

export async function getPostById(id: string): Promise<PostWithAuthor | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("posts").select(POST_SELECT).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return normalizeRow(data as unknown as Record<string, unknown>);
}

export async function listOwnPosts(authorId: string): Promise<PostWithAuthor[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("author_id", authorId)
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("[listOwnPosts]", error);
    return [];
  }
  const posts = (data ?? []).map((r) => normalizeRow(r as unknown as Record<string, unknown>));

  // Tally views for the author's posts in one extra round-trip. RLS lets
  // authors read their own post_views rows, so no service-role escalation
  // is needed here.
  if (posts.length > 0) {
    const { data: viewRows } = await supabase
      .from("post_views")
      .select("post_id")
      .in("post_id", posts.map((p) => p.id));
    const tally = new Map<string, number>();
    for (const r of (viewRows ?? []) as { post_id: string }[]) {
      tally.set(r.post_id, (tally.get(r.post_id) ?? 0) + 1);
    }
    for (const p of posts) p.viewCount = tally.get(p.id) ?? 0;
  }

  return posts;
}

/** A post the user collaborates on, tagged with their per-post role. */
export interface SharedPost extends PostWithAuthor {
  collaboratorRole: PostCollaboratorRole;
}

/**
 * Posts shared WITH this user (they're an invited collaborator, not the
 * author). Owner-trashed (archived) posts are excluded so a collaborator's
 * "Shared with me" list never shows posts the owner deleted. RLS already
 * scopes the post read to collaborators, so this is safe with the user client.
 */
export async function listSharedPosts(userId: string): Promise<SharedPost[]> {
  const supabase = await createSupabaseServerClient();
  const { data: collabRows, error: collabErr } = await supabase
    .from("post_collaborators")
    .select("post_id, role")
    .eq("user_id", userId);
  if (collabErr) {
    console.error("[listSharedPosts:collaborators]", collabErr);
    return [];
  }
  const rows = (collabRows ?? []) as { post_id: string; role: PostCollaboratorRole }[];
  if (rows.length === 0) return [];
  const roleByPost = new Map(rows.map((r) => [r.post_id, r.role]));

  const { data, error } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .in(
      "id",
      rows.map((r) => r.post_id),
    )
    .neq("status", "archived")
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("[listSharedPosts:posts]", error);
    return [];
  }
  return (data ?? []).map((r) => {
    const post = normalizeRow(r as unknown as Record<string, unknown>);
    return { ...post, collaboratorRole: roleByPost.get(post.id) ?? "reviewer" };
  });
}

export type PostRelationship = "owned" | PostCollaboratorRole;
export interface EditablePost extends PostWithAuthor {
  relationship: PostRelationship;
}

/**
 * Every post the user can open in the editor: the ones they authored plus the
 * ones shared with them, each tagged with the relationship. Used where a single
 * combined list is more convenient than the owner/shared split (e.g. dashboards).
 */
export async function listEditablePostsForUser(userId: string): Promise<EditablePost[]> {
  const [own, shared] = await Promise.all([listOwnPosts(userId), listSharedPosts(userId)]);
  const owned: EditablePost[] = own.map((p) => ({ ...p, relationship: "owned" as const }));
  const sharedTagged: EditablePost[] = shared.map((p) => ({ ...p, relationship: p.collaboratorRole }));
  return [...owned, ...sharedTagged].sort((a, b) =>
    (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );
}

export async function listPostsThisWeek(weekStart: string): Promise<PostWithAuthor[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .eq("week_start_date", weekStart)
    .eq("status", "published")
    .order("published_at", { ascending: false });
  if (error) {
    console.error("[listPostsThisWeek]", error);
    return [];
  }
  return (data ?? []).map((r) => normalizeRow(r as unknown as Record<string, unknown>));
}

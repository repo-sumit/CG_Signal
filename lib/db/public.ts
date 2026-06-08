import "server-only";
import { unstable_cache } from "next/cache";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { PostRow, ProfileRow, TagRow } from "@/lib/db/types";
import { REACTION_EMOJIS, type ReactionEmoji } from "@/lib/reactions";
import { teamDisplayOrderFor } from "@/lib/team";
import { getFirstName } from "@/lib/utils/names";
import type { PostContributorRole } from "@/lib/db/types";

/**
 * Cache tag for the public-feed queries (listPublicPosts, listPublicTags,
 * listContributorStats). Editor + admin server actions call
 * `revalidateTag(PUBLIC_FEED_TAG)` whenever a publish / unpublish / delete /
 * tag change happens, so the 60s TTL is just the fallback for non-write
 * events (view counts, reactions tallied into card footers). See
 * `docs/frontend-cache-audit.md` for the full rationale.
 */
export const PUBLIC_FEED_TAG = "public-feed";
const PUBLIC_FEED_REVALIDATE = 60;

// Re-export the reaction constants so existing callers of `@/lib/db/public`
// keep working. The real definition is in `@/lib/reactions` (no server-only),
// which lets client components import it without tainting their bundle.
export { REACTION_EMOJIS, type ReactionEmoji } from "@/lib/reactions";

/**
 * Public reading layer. These helpers use the service-role client so anyone
 * (signed-in or anonymous) can read published posts on the public landing
 * and post-detail pages, even though RLS otherwise restricts row visibility
 * to @convegenius.ai users.
 *
 * SECURITY RULES:
 *  - Every query MUST be hard-pinned to `status = 'published'`.
 *  - We only project the fields needed for public rendering — never the raw
 *    Tiptap JSON for drafts, never private metadata.
 *  - Service-role bypasses RLS, so any new helper here is responsible for its
 *    own access control. Keep the surface tight.
 */

type PublicAuthor = Pick<ProfileRow, "id" | "full_name" | "email" | "avatar_url" | "role">;

/**
 * Public-safe contributor shape — NO email or permission data. Drives the
 * multi-author byline on post detail + the "+N" hint on cards.
 */
export interface PublicPostContributor {
  id: string;
  firstName: string;
  fullName: string;
  avatarUrl: string | null;
  role: PostContributorRole;
  displayOrder: number;
}

export interface PublicPost extends PostRow {
  author: PublicAuthor | null;
  tags: Pick<TagRow, "id" | "name" | "slug">[];
  /** Owner + editor collaborators, public-safe. Back-filled by `attachContributors`. */
  contributors: PublicPostContributor[];
  /** Aggregate post_views count — server-computed, never inferred client-side. */
  viewCount: number;
  /** Aggregate reactions count — server-computed across all emojis. */
  reactionCount: number;
  /** Aggregate comments count — server-computed, excludes soft-deleted rows. */
  commentCount: number;
  /**
   * Signed thumbnail URL (1-hour TTL). `null` when the post has no
   * cover_media_id or the asset can't be signed — callers should render the
   * `<PostThumbnail>` placeholder in that case.
   */
  coverUrl: string | null;
}

const COVER_BUCKET = "blog-media";
const COVER_SIGNED_TTL_SECONDS = 60 * 60; // 1h — matches the public landing's force-dynamic cadence.

const PUBLIC_SELECT = `
  id, author_id, title, slug, excerpt, content_html,
  week_start_date, assigned_weekday, published_at, read_time_minutes,
  created_at, updated_at, status, scheduled_for, archived_at,
  cover_media_id, content_json,
  author:profiles!posts_author_id_fkey ( id, full_name, email, avatar_url, role ),
  tags:post_tags ( tag:tags ( id, name, slug ) )
`;

function normalize(row: Record<string, unknown>): PublicPost {
  const tagsRaw = Array.isArray(row.tags) ? row.tags : [];
  const tags = tagsRaw
    .map((e) => {
      const t = (e as { tag?: unknown })?.tag;
      if (!t || typeof t !== "object") return null;
      const obj = t as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.name !== "string" || typeof obj.slug !== "string") return null;
      return { id: obj.id, name: obj.name, slug: obj.slug };
    })
    .filter((t): t is { id: string; name: string; slug: string } => t !== null);
  const a = row.author as Record<string, unknown> | null;
  return {
    ...(row as unknown as PostRow),
    author: a
      ? {
          id: String(a.id ?? ""),
          full_name: (a.full_name as string | null) ?? null,
          email: String(a.email ?? ""),
          avatar_url: (a.avatar_url as string | null) ?? null,
          role: ((a.role as "manager" | "author" | "viewer" | undefined) ?? "viewer") as PublicAuthor["role"],
        }
      : null,
    tags,
    contributors: [], // back-filled by `attachContributors`.
    viewCount: 0, // back-filled by `attachViewCounts` after the join.
    reactionCount: 0, // back-filled by `attachEngagementCounts`.
    commentCount: 0, // back-filled by `attachEngagementCounts`.
    coverUrl: null, // back-filled by `attachCoverUrls` after the lookup.
  };
}

/**
 * Resolves a public-readable signed URL for each post's `cover_media_id`.
 * Two round-trips: one batch select against `media_assets`, one batch signed
 * URL call. We use the service client because the bucket is private + RLS-
 * gated; landing visitors are anonymous so they can't hit the storage API
 * directly. The signed URL is short-lived (1h), which is fine because the
 * landing page is `force-dynamic` and re-fetches per render.
 */
async function attachCoverUrls(posts: PublicPost[]): Promise<PublicPost[]> {
  const withCover = posts.filter((p) => p.cover_media_id);
  if (withCover.length === 0) return posts;

  const service = createSupabaseServiceClient();
  const mediaIds = Array.from(
    new Set(withCover.map((p) => p.cover_media_id as string)),
  );

  const { data: assets } = await service
    .from("media_assets")
    .select("id, storage_path")
    .in("id", mediaIds);
  const pathById = new Map<string, string>();
  for (const r of (assets ?? []) as { id: string; storage_path: string | null }[]) {
    if (r.storage_path) pathById.set(r.id, r.storage_path);
  }
  if (pathById.size === 0) return posts;

  const paths = Array.from(pathById.values());
  const { data: signed } = await service.storage
    .from(COVER_BUCKET)
    .createSignedUrls(paths, COVER_SIGNED_TTL_SECONDS);
  const urlByPath = new Map<string, string>();
  for (const s of (signed ?? []) as { path: string | null; signedUrl: string }[]) {
    if (s.path) urlByPath.set(s.path, s.signedUrl);
  }

  return posts.map((p) => {
    if (!p.cover_media_id) return p;
    const path = pathById.get(p.cover_media_id);
    const url = path ? (urlByPath.get(path) ?? null) : null;
    return { ...p, coverUrl: url };
  });
}

/**
 * Attaches the public contributor list to each post. Robust by design — it
 * UNIONS three sources and dedupes by user:
 *
 *   1. the post author (always present, role 'owner', even if the
 *      `post_contributors` store is empty or unsynced),
 *   2. live editor collaborators from `post_collaborators` (role='editor'),
 *   3. explicit `post_contributors` rows (the canonical credit store).
 *
 * Reviewers are never included. Only `full_name` + `avatar_url` are exposed —
 * never email. Service-role is used (same as the rest of this file), so RLS
 * doesn't block the joins; safety comes from the field projection + the
 * caller pinning `status='published'`.
 */
async function attachContributors(posts: PublicPost[]): Promise<PublicPost[]> {
  if (posts.length === 0) return posts;
  const service = createSupabaseServiceClient();
  const postIds = posts.map((p) => p.id);

  const [collabRes, contribRes] = await Promise.all([
    service.from("post_collaborators").select("post_id, user_id, role").in("post_id", postIds).eq("role", "editor"),
    service.from("post_contributors").select("post_id, user_id, role, display_order").in("post_id", postIds),
  ]);
  const collabRows = (collabRes.data ?? []) as { post_id: string; user_id: string; role: string }[];
  const contribRows = (contribRes.data ?? []) as {
    post_id: string;
    user_id: string;
    role: string;
    display_order: number;
  }[];

  // Collect every profile id we need: authors + collaborator editors + contributors.
  const userIds = new Set<string>();
  for (const p of posts) if (p.author_id) userIds.add(p.author_id);
  for (const r of collabRows) userIds.add(r.user_id);
  for (const r of contribRows) userIds.add(r.user_id);

  const profById = new Map<string, { full_name: string | null; avatar_url: string | null }>();
  if (userIds.size > 0) {
    const { data: profs } = await service
      .from("profiles")
      .select("id, full_name, avatar_url")
      .in("id", [...userIds]);
    for (const pr of (profs ?? []) as { id: string; full_name: string | null; avatar_url: string | null }[]) {
      profById.set(pr.id, { full_name: pr.full_name, avatar_url: pr.avatar_url });
    }
  }

  const contribByPost = new Map<string, typeof contribRows>();
  for (const r of contribRows) {
    const list = contribByPost.get(r.post_id) ?? [];
    list.push(r);
    contribByPost.set(r.post_id, list);
  }
  const editorsByPost = new Map<string, string[]>();
  for (const r of collabRows) {
    const list = editorsByPost.get(r.post_id) ?? [];
    list.push(r.user_id);
    editorsByPost.set(r.post_id, list);
  }

  const toContributor = (
    userId: string,
    role: PostContributorRole,
    displayOrder: number,
  ): PublicPostContributor => {
    const prof = profById.get(userId);
    const fullName = (prof?.full_name ?? "").trim();
    return {
      id: userId,
      firstName: getFirstName(fullName),
      fullName,
      avatarUrl: prof?.avatar_url ?? null,
      role,
      displayOrder,
    };
  };

  const normalizeRole = (role: string): PostContributorRole =>
    role === "owner" || role === "editor" || role === "contributor" ? role : "contributor";

  return posts.map((post) => {
    const byUser = new Map<string, PublicPostContributor>();

    // 1. Owner — always first, always present.
    if (post.author_id) byUser.set(post.author_id, toContributor(post.author_id, "owner", 0));

    // 2. Explicit contributor rows (canonical store) take precedence for non-owners.
    for (const r of contribByPost.get(post.id) ?? []) {
      if (r.user_id === post.author_id) continue; // owner already set
      byUser.set(r.user_id, toContributor(r.user_id, normalizeRole(r.role), r.display_order));
    }

    // 3. Live editor collaborators fill any gaps the store hasn't captured yet.
    let order = 10;
    for (const uid of editorsByPost.get(post.id) ?? []) {
      if (uid === post.author_id || byUser.has(uid)) continue;
      byUser.set(uid, toContributor(uid, "editor", order++));
    }

    const contributors = [...byUser.values()].sort((a, b) => {
      const ra = a.role === "owner" ? 0 : 1;
      const rb = b.role === "owner" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
      return a.firstName.localeCompare(b.firstName);
    });
    return { ...post, contributors };
  });
}

/**
 * Stitches `post_views` counts onto an already-fetched list of public posts.
 * One round-trip per call regardless of list size — we group-count in a single
 * query using Supabase's foreign-table aggregate. The counts table is RLS-
 * protected (admin + author), so we use the service client.
 */
async function attachViewCounts(posts: PublicPost[]): Promise<PublicPost[]> {
  if (posts.length === 0) return posts;
  const service = createSupabaseServiceClient();
  const ids = posts.map((p) => p.id);
  // Pull every view row for the requested posts and aggregate in JS — fine
  // for our scale (single-digit-thousands of views per post).
  const { data, error } = await service
    .from("post_views")
    .select("post_id")
    .in("post_id", ids);
  if (error) {
    console.error("[attachViewCounts]", error);
    return posts;
  }
  const tally = new Map<string, number>();
  for (const r of (data ?? []) as { post_id: string }[]) {
    tally.set(r.post_id, (tally.get(r.post_id) ?? 0) + 1);
  }
  return posts.map((p) => ({ ...p, viewCount: tally.get(p.id) ?? 0 }));
}

/**
 * Stitches `reactions` + `comments` counts onto the list. Two batched queries
 * (one per table) keep this O(1) regardless of how many posts are on screen.
 * We pull just the `post_id` column so the round-trip stays small even on
 * popular posts. Soft-deleted comments are excluded by the `deleted_at` filter
 * so the count on the card matches what readers see in the thread.
 */
async function attachEngagementCounts(posts: PublicPost[]): Promise<PublicPost[]> {
  if (posts.length === 0) return posts;
  const service = createSupabaseServiceClient();
  const ids = posts.map((p) => p.id);

  const [reactRes, commentRes] = await Promise.all([
    service.from("reactions").select("post_id").in("post_id", ids),
    service.from("comments").select("post_id").in("post_id", ids).is("deleted_at", null),
  ]);

  const reactTally = new Map<string, number>();
  if (reactRes.error) {
    console.error("[attachEngagementCounts:reactions]", reactRes.error);
  } else {
    for (const r of (reactRes.data ?? []) as { post_id: string }[]) {
      reactTally.set(r.post_id, (reactTally.get(r.post_id) ?? 0) + 1);
    }
  }

  const commentTally = new Map<string, number>();
  if (commentRes.error) {
    console.error("[attachEngagementCounts:comments]", commentRes.error);
  } else {
    for (const r of (commentRes.data ?? []) as { post_id: string }[]) {
      commentTally.set(r.post_id, (commentTally.get(r.post_id) ?? 0) + 1);
    }
  }

  return posts.map((p) => ({
    ...p,
    reactionCount: reactTally.get(p.id) ?? 0,
    commentCount: commentTally.get(p.id) ?? 0,
  }));
}

async function listPublicPostsUncached(limit = 30): Promise<PublicPost[]> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("posts")
    .select(PUBLIC_SELECT)
    .eq("status", "published") // SECURITY: never leak non-published rows.
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[listPublicPosts]", error);
    return [];
  }
  const posts = (data ?? []).map((r: unknown) => normalize(r as Record<string, unknown>));
  const withViews = await attachViewCounts(posts);
  const withEngagement = await attachEngagementCounts(withViews);
  const withCover = await attachCoverUrls(withEngagement);
  return attachContributors(withCover);
}

/**
 * Cached wrapper around `listPublicPostsUncached`. One cache key per `limit`
 * value so the landing (limit=60) and post detail's "related posts" call
 * (limit=8) don't share an undersized result. `revalidateTag(PUBLIC_FEED_TAG)`
 * from publish/delete actions invalidates every limit variant at once.
 *
 * NOTE: cover URLs returned here are signed for 1h. Even with a 60s
 * revalidate window, the URLs returned from cache are still well within
 * their TTL, so no risk of serving expired URLs to crawlers.
 */
export const listPublicPosts = unstable_cache(
  async (limit = 30) => listPublicPostsUncached(limit),
  ["lib/db/public:listPublicPosts"],
  { revalidate: PUBLIC_FEED_REVALIDATE, tags: [PUBLIC_FEED_TAG] },
);

export async function getPublicPostBySlug(slug: string): Promise<PublicPost | null> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("posts")
    .select(PUBLIC_SELECT)
    .eq("slug", slug)
    .eq("status", "published") // SECURITY: drafts are not addressable via this route.
    .maybeSingle();
  if (error || !data) return null;
  const post = normalize(data as unknown as Record<string, unknown>);
  const [withViews] = await attachViewCounts([post]);
  const [withEngagement] = await attachEngagementCounts([withViews ?? post]);
  const [withCover] = await attachCoverUrls([withEngagement ?? withViews ?? post]);
  const [withContributors] = await attachContributors([withCover ?? withEngagement ?? withViews ?? post]);
  return withContributors ?? withCover ?? withEngagement ?? withViews ?? post;
}

async function listPublicTagsUncached(): Promise<{ id: string; name: string; slug: string }[]> {
  const service = createSupabaseServiceClient();
  // Only return tags actually used by at least one published post — keeps the
  // category strip from showing empty/dead tags.
  const { data, error } = await service
    .from("post_tags")
    .select("tag:tags(id, name, slug), post:posts!inner(status)")
    .eq("post.status", "published");
  if (error) {
    console.error("[listPublicTags]", error);
    return [];
  }
  const seen = new Map<string, { id: string; name: string; slug: string }>();
  for (const row of data ?? []) {
    // Supabase may type joined relations as arrays even when they're singletons.
    // Cast through `unknown` to bypass the overlap check, then normalize.
    const raw = (row as unknown as {
      tag?: { id?: string; name?: string; slug?: string } | { id?: string; name?: string; slug?: string }[] | null;
    }).tag;
    const t = Array.isArray(raw) ? raw[0] : raw;
    if (t?.id && t.name && t.slug && !seen.has(t.id)) {
      seen.set(t.id, { id: t.id, name: t.name, slug: t.slug });
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Cached public tags. Shares the `PUBLIC_FEED_TAG` invalidation key with
 * `listPublicPosts` so an admin tag-edit or a post publish refreshes both
 * without per-call wiring.
 */
export const listPublicTags = unstable_cache(
  listPublicTagsUncached,
  ["lib/db/public:listPublicTags"],
  { revalidate: PUBLIC_FEED_REVALIDATE, tags: [PUBLIC_FEED_TAG] },
);

export async function listPublicAuthors(): Promise<PublicAuthor[]> {
  const service = createSupabaseServiceClient();
  // Authors who have at least one published post.
  const { data, error } = await service
    .from("posts")
    .select("author:profiles!posts_author_id_fkey(id, full_name, email, avatar_url, role)")
    .eq("status", "published");
  if (error) return [];
  const seen = new Map<string, PublicAuthor>();
  for (const row of data ?? []) {
    // Supabase types FK joins as arrays even when the relationship is
    // singleton; at runtime it's a single object. Normalize both shapes.
    const raw = (row as unknown as { author?: PublicAuthor | PublicAuthor[] | null }).author;
    const a = Array.isArray(raw) ? raw[0] : raw;
    if (a?.id && !seen.has(a.id)) seen.set(a.id, a);
  }
  return Array.from(seen.values());
}

// ============================================================
// Contributor stats — fuels the landing page contributor cards
// ============================================================

export interface ContributorStats {
  /** The profile (may be null if author profile is missing). */
  profile: PublicAuthor;
  /** Total number of published posts by this contributor. */
  postCount: number;
  /** Most recent published post (title + slug + published_at), or null. */
  latestPost: { title: string; slug: string; published_at: string | null } | null;
  /** Unique tag names across all their published posts (sorted by frequency). */
  topics: string[];
}

/**
 * Loads stats for every member of the team allowlist — even those with zero
 * published posts. This way the contributor section always shows the full
 * crew, not just the ones who've posted.
 *
 * Joins posts → tags → profile, aggregates per author. Cheap enough at our
 * scale that we don't bother with a SQL view.
 */
async function listContributorStatsUncached(): Promise<ContributorStats[]> {
  const service = createSupabaseServiceClient();

  // 1. All editor profiles (author + manager) from the allowlist. We pull
  // unsorted and re-order in JS using `TEAM_META.displayOrder` so the same
  // canonical order applies everywhere — contributor grid on landing,
  // dashboard team panel, admin schedule, etc. SQL `.order()` can't express
  // an editorial ranking against an in-code config without a join table.
  const { data: profileRows } = await service
    .from("profiles")
    .select("id, full_name, email, avatar_url, role")
    .in("role", ["author", "manager"]);

  const profiles = ((profileRows ?? []) as unknown as PublicAuthor[]).slice().sort((a, b) => {
    const oa = teamDisplayOrderFor(a.email);
    const ob = teamDisplayOrderFor(b.email);
    if (oa !== ob) return oa - ob;
    // Tie-break: alphabetical full_name so unknown teammates have a stable
    // order amongst themselves and don't flip on every render.
    return (a.full_name ?? a.email ?? "").localeCompare(b.full_name ?? b.email ?? "");
  });
  if (profiles.length === 0) return [];

  // 2. All published posts authored by them, with their tags.
  const authorIds = profiles.map((p) => p.id);
  const { data: postRows } = await service
    .from("posts")
    .select("id, title, slug, author_id, published_at, tags:post_tags(tag:tags(name))")
    .eq("status", "published")
    .in("author_id", authorIds)
    .order("published_at", { ascending: false });

  const posts = (postRows ?? []) as unknown as Array<{
    id: string;
    title: string;
    slug: string;
    author_id: string;
    published_at: string | null;
    tags: { tag: { name: string } | { name: string }[] | null }[] | null;
  }>;

  // 3. Aggregate per author.
  const byAuthor = new Map<string, { count: number; latest: typeof posts[number] | null; topicCounts: Map<string, number> }>();
  for (const p of profiles) byAuthor.set(p.id, { count: 0, latest: null, topicCounts: new Map() });

  for (const post of posts) {
    const slot = byAuthor.get(post.author_id);
    if (!slot) continue;
    slot.count += 1;
    if (!slot.latest) slot.latest = post; // posts are already ordered desc
    for (const t of post.tags ?? []) {
      const tagObj = Array.isArray(t.tag) ? t.tag[0] : t.tag;
      const name = tagObj?.name;
      if (name) slot.topicCounts.set(name, (slot.topicCounts.get(name) ?? 0) + 1);
    }
  }

  return profiles.map((profile) => {
    const slot = byAuthor.get(profile.id)!;
    const topics = Array.from(slot.topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .slice(0, 4);
    return {
      profile,
      postCount: slot.count,
      latestPost: slot.latest
        ? {
            title: slot.latest.title,
            slug: slot.latest.slug,
            published_at: slot.latest.published_at,
          }
        : null,
      topics,
    };
  });
}

/**
 * Cached contributor stats. Joins are expensive at this query's shape, so
 * caching the result is the highest-leverage of the three public queries.
 * Same revalidation tag as the rest of the public feed.
 */
export const listContributorStats = unstable_cache(
  listContributorStatsUncached,
  ["lib/db/public:listContributorStats"],
  { revalidate: PUBLIC_FEED_REVALIDATE, tags: [PUBLIC_FEED_TAG] },
);

// ============================================================
// Comments + reactions (public reads)
// ============================================================

export interface PublicComment {
  id: string;
  post_id: string;
  user_id: string;
  author_name: string;
  author_avatar_url: string | null;
  body: string;
  created_at: string;
}

export async function listComments(postId: string): Promise<PublicComment[]> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("comments")
    .select("id, post_id, user_id, author_name, author_avatar_url, body, created_at")
    .eq("post_id", postId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[listComments]", error);
    return [];
  }
  return (data ?? []) as unknown as PublicComment[];
}

export async function listReactionCounts(postId: string): Promise<Record<ReactionEmoji, number>> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("reactions")
    .select("emoji")
    .eq("post_id", postId);
  const out: Record<string, number> = {};
  for (const e of REACTION_EMOJIS) out[e] = 0;
  if (error) {
    console.error("[listReactionCounts]", error);
    return out as Record<ReactionEmoji, number>;
  }
  for (const r of data ?? []) {
    const e = (r as { emoji: string }).emoji;
    if ((REACTION_EMOJIS as readonly string[]).includes(e)) {
      out[e] = (out[e] ?? 0) + 1;
    }
  }
  return out as Record<ReactionEmoji, number>;
}

export async function listMyReactions(postId: string, userId: string): Promise<ReactionEmoji[]> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("reactions")
    .select("emoji")
    .eq("post_id", postId)
    .eq("user_id", userId);
  if (error) {
    console.error("[listMyReactions]", error);
    return [];
  }
  return ((data ?? []) as { emoji: string }[])
    .map((r) => r.emoji)
    .filter((e): e is ReactionEmoji => (REACTION_EMOJIS as readonly string[]).includes(e));
}

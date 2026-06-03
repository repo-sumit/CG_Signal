import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AppRole, PostCollaboratorRole, PostStatus } from "@/lib/db/types";
import {
  deriveAccess,
  isLockActive,
  type ApprovedTeammate,
  type CollaboratorView,
  type LockView,
  type PostAccess,
  type ReviewCommentView,
} from "@/lib/auth/collaboration";
import { teamDisplayOrderFor } from "@/lib/team";

// Loose client type — our Supabase clients are intentionally untyped (see
// lib/supabase/server.ts). Accepting the default-generic `SupabaseClient` lets
// callers pass either the RLS (cookie) client or the service-role client.
type DbClient = SupabaseClient;

interface ProfileLite {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: AppRole;
}

function displayName(p: { full_name?: string | null; email?: string | null }): string {
  return (p.full_name && p.full_name.trim()) || p.email || "Unknown";
}

function normalizeJoinedProfile(raw: unknown): ProfileLite | null {
  // PostgREST types FK embeds as object | object[]; normalize both.
  const obj = Array.isArray(raw) ? raw[0] : raw;
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    full_name: (r.full_name as string | null) ?? null,
    email: String(r.email ?? ""),
    avatar_url: (r.avatar_url as string | null) ?? null,
    role: ((r.role as AppRole | undefined) ?? "viewer") as AppRole,
  };
}

/** The current user's per-post collaborator role, or null. */
export async function getCollaboratorRole(
  client: DbClient,
  postId: string,
  userId: string,
): Promise<PostCollaboratorRole | null> {
  const { data } = await client
    .from("post_collaborators")
    .select("role")
    .eq("post_id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  const role = (data as { role?: string } | null)?.role;
  return role === "editor" || role === "reviewer" ? role : null;
}

export interface ResolvedPostAccess {
  access: PostAccess;
  post: { id: string; authorId: string; status: PostStatus } | null;
}

/**
 * Resolve the caller's full access to a post in one place. Reads the post row
 * (author_id + status) and the caller's collaborator role, then derives every
 * permission flag. Used by server actions + API routes that don't already have
 * the post loaded. Pass a client so the caller's RLS context is reused.
 */
export async function resolvePostAccess(
  client: DbClient,
  postId: string,
  userId: string,
  role: AppRole,
): Promise<ResolvedPostAccess> {
  const [{ data: postRow }, collaboratorRole] = await Promise.all([
    client.from("posts").select("id, author_id, status").eq("id", postId).maybeSingle(),
    getCollaboratorRole(client, postId, userId),
  ]);
  const post = postRow as { id: string; author_id: string; status: PostStatus } | null;
  const access = deriveAccess({
    authorId: post?.author_id ?? null,
    userId,
    role,
    collaboratorRole,
  });
  return {
    access,
    post: post ? { id: post.id, authorId: post.author_id, status: post.status } : null,
  };
}

/** Collaborators on a post (editors first, then reviewers; name-sorted within). */
export async function listCollaborators(
  client: DbClient,
  postId: string,
): Promise<CollaboratorView[]> {
  const { data, error } = await client
    .from("post_collaborators")
    .select(
      "user_id, role, invited_by, created_at, profile:profiles!post_collaborators_user_id_fkey ( id, full_name, email, avatar_url, role )",
    )
    .eq("post_id", postId);
  if (error) {
    console.error("[listCollaborators]", error);
    return [];
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const views: CollaboratorView[] = rows
    .map((row) => {
      const profile = normalizeJoinedProfile(row.profile);
      const role = row.role;
      if (role !== "editor" && role !== "reviewer") return null;
      return {
        userId: String(row.user_id ?? profile?.id ?? ""),
        role: role as PostCollaboratorRole,
        name: profile ? displayName(profile) : "Unknown",
        email: profile?.email ?? "",
        avatarUrl: profile?.avatar_url ?? null,
        invitedBy: (row.invited_by as string | null) ?? null,
      } satisfies CollaboratorView;
    })
    .filter((v): v is CollaboratorView => v !== null);

  return views.sort((a, b) => {
    if (a.role !== b.role) return a.role === "editor" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Draft review comments for a post, oldest first (chronological thread). */
export async function listReviewComments(
  client: DbClient,
  postId: string,
): Promise<ReviewCommentView[]> {
  const { data, error } = await client
    .from("post_review_comments")
    .select(
      "id, user_id, body, resolved_at, created_at, profile:profiles!post_review_comments_user_id_fkey ( id, full_name, email, avatar_url, role )",
    )
    .eq("post_id", postId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[listReviewComments]", error);
    return [];
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const profile = normalizeJoinedProfile(row.profile);
    return {
      id: String(row.id ?? ""),
      userId: String(row.user_id ?? ""),
      authorName: profile ? displayName(profile) : "Unknown",
      authorAvatarUrl: profile?.avatar_url ?? null,
      body: String(row.body ?? ""),
      resolvedAt: (row.resolved_at as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
    } satisfies ReviewCommentView;
  });
}

/**
 * Active edit lock for a post, or null if none / expired. Works with either
 * the RLS client (page reads — collaborators may read locks for drafts they
 * can access) or the service client (lock routes).
 */
export async function getActiveLock(client: DbClient, postId: string): Promise<LockView | null> {
  const { data, error } = await client
    .from("post_edit_locks")
    .select(
      "post_id, locked_by, locked_at, expires_at, profile:profiles!post_edit_locks_locked_by_fkey ( id, full_name, email, avatar_url, role )",
    )
    .eq("post_id", postId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const expiresAt = String(row.expires_at ?? "");
  if (!isLockActive(expiresAt)) return null;
  const profile = normalizeJoinedProfile(row.profile);
  return {
    postId: String(row.post_id ?? postId),
    lockedBy: {
      id: String(row.locked_by ?? profile?.id ?? ""),
      name: profile ? displayName(profile) : "Someone",
      email: profile?.email ?? "",
      avatarUrl: profile?.avatar_url ?? null,
    },
    lockedAt: String(row.locked_at ?? ""),
    expiresAt,
  };
}

/**
 * Active, approved teammates eligible to be invited as collaborators — every
 * profile whose role is `author` or `manager`. The caller is responsible for
 * filtering out the owner + existing collaborators in the UI. Sorted by the
 * canonical team display order so the dropdown matches every other team list.
 */
export async function listApprovedTeammates(client: DbClient): Promise<ApprovedTeammate[]> {
  const { data, error } = await client
    .from("profiles")
    .select("id, full_name, email, avatar_url, role")
    .in("role", ["author", "manager"])
    .eq("is_active", true);
  if (error) {
    console.error("[listApprovedTeammates]", error);
    return [];
  }
  const rows = (data ?? []) as ProfileLite[];
  return rows
    .map((p) => ({
      id: p.id,
      name: displayName(p),
      email: p.email,
      avatarUrl: p.avatar_url,
      role: p.role,
    }))
    .sort((a, b) => {
      const oa = teamDisplayOrderFor(a.email);
      const ob = teamDisplayOrderFor(b.email);
      if (oa !== ob) return oa - ob;
      return a.name.localeCompare(b.name);
    });
}

/** Convenience for the editor page: everything the collaboration UI needs. */
export interface EditorCollaborationData {
  collaborators: CollaboratorView[];
  reviewComments: ReviewCommentView[];
  lock: LockView | null;
  approvedTeammates: ApprovedTeammate[];
}

export async function loadEditorCollaboration(
  postId: string,
  opts: { canManageCollaborators: boolean },
): Promise<EditorCollaborationData> {
  const client = await createSupabaseServerClient();
  const [collaborators, reviewComments, lock, approvedTeammates] = await Promise.all([
    listCollaborators(client, postId),
    listReviewComments(client, postId),
    getActiveLock(client, postId),
    opts.canManageCollaborators ? listApprovedTeammates(client) : Promise.resolve([]),
  ]);
  return { collaborators, reviewComments, lock, approvedTeammates };
}

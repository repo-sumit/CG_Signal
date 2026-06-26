import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Publish-time side effects shared by the editor save flow (Post Now) and the
 * admin review queue (Approve & Publish). Both must run the SAME steps when a
 * post transitions to `published`, so they live here rather than being
 * duplicated. All use the service client — callers verify owner/manager first.
 */

/**
 * Publish-time cleanup. Review comments are draft-only feedback, so they must
 * never survive into a published post — and the edit lock is meaningless once
 * the post is live. Idempotent: safe to re-run.
 */
export async function cleanupReviewArtifactsOnPublish(postId: string): Promise<void> {
  const service = createSupabaseServiceClient();
  await Promise.all([
    service.from("post_review_comments").delete().eq("post_id", postId),
    service.from("post_edit_locks").delete().eq("post_id", postId),
  ]);
}

/**
 * Recomputes the canonical public-credit store for a post: the owner (always,
 * role 'owner') plus every current editor collaborator (role 'editor').
 * Reviewers are excluded. Stale rows (users no longer owner/editor) are pruned
 * so removing a collaborator also removes their credit. Idempotent.
 */
export async function syncPostContributors(postId: string): Promise<void> {
  const service = createSupabaseServiceClient();
  const { data: postRow } = await service
    .from("posts")
    .select("author_id")
    .eq("id", postId)
    .maybeSingle();
  const ownerId = (postRow as { author_id?: string } | null)?.author_id;
  if (!ownerId) return;

  const { data: editorRows } = await service
    .from("post_collaborators")
    .select("user_id")
    .eq("post_id", postId)
    .eq("role", "editor");
  const editorIds = ((editorRows ?? []) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter((id) => id !== ownerId);

  const rows: Array<{ post_id: string; user_id: string; role: string; display_order: number }> = [
    { post_id: postId, user_id: ownerId, role: "owner", display_order: 0 },
    ...editorIds.map((uid, i) => ({
      post_id: postId,
      user_id: uid,
      role: "editor",
      display_order: 10 + i,
    })),
  ];
  await service.from("post_contributors").upsert(rows, { onConflict: "post_id,user_id" });

  // Prune rows for users who are no longer the owner or an editor.
  const keep = new Set<string>([ownerId, ...editorIds]);
  const { data: existing } = await service
    .from("post_contributors")
    .select("user_id")
    .eq("post_id", postId);
  const stale = ((existing ?? []) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter((uid) => !keep.has(uid));
  if (stale.length > 0) {
    await service.from("post_contributors").delete().eq("post_id", postId).in("user_id", stale);
  }
}

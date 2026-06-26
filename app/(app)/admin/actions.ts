"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireManager } from "@/lib/auth/guards";
import { slugify } from "@/lib/utils/slugs";
import type { ProfileRow } from "@/lib/db/types";
import { PUBLIC_FEED_TAG } from "@/lib/db/public";
import {
  cleanupReviewArtifactsOnPublish,
  syncPostContributors,
} from "@/lib/db/publishSideEffects";
import { sendPerPostNewsletter } from "@/lib/email/newsletter";
import { notifyWriterOfReview } from "@/lib/email/reviewNotifications";

type ActionResult = { ok: boolean; error?: string };

const WeekdayInput = z.object({
  userId: z.string().uuid(),
  weekday: z.number().int().min(1).max(5).nullable(),
});

export async function setWeekday(input: z.infer<typeof WeekdayInput>): Promise<ActionResult> {
  const parsed = WeekdayInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  await requireManager();
  const supabase = await createSupabaseServerClient();

  // Advisory uniqueness — refuse if another active team member already owns
  // the requested weekday. Manager can clear the other person first, then assign.
  if (parsed.data.weekday !== null) {
    const { data: conflictRow } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .eq("weekly_post_day", parsed.data.weekday)
      .neq("id", parsed.data.userId)
      .maybeSingle();
    const conflict = conflictRow as { full_name: string | null; email: string } | null;
    if (conflict) {
      return {
        ok: false,
        error: `That day is already assigned to ${conflict.full_name ?? conflict.email}. Unassign them first.`,
      };
    }
  }

  const { error } = await supabase.rpc("assign_weekday", {
    p_user_id: parsed.data.userId,
    p_weekday: parsed.data.weekday,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/schedule");
  revalidatePath("/dashboard");
  return { ok: true };
}

const UpsertAuthorizedInput = z.object({
  email: z.string().email().max(254),
  role: z.enum(["viewer", "writer", "author", "manager"]),
  weekday: z.number().int().min(1).max(5).nullable().optional(),
});

export async function upsertAuthorizedUser(
  input: z.infer<typeof UpsertAuthorizedInput>,
): Promise<ActionResult> {
  const parsed = UpsertAuthorizedInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  await requireManager();
  const supabase = await createSupabaseServerClient();
  const email = parsed.data.email.trim().toLowerCase();

  // Refuse non-domain emails — RLS would block their first sign-in anyway,
  // but failing here gives the manager a clear error.
  const allowed = (process.env.APP_ALLOWED_EMAIL_DOMAIN ?? "convegenius.ai").toLowerCase();
  if (email.split("@")[1] !== allowed) {
    return { ok: false, error: `Email must be @${allowed}.` };
  }

  const { error } = await supabase.from("authorized_users").upsert(
    {
      email,
      role: parsed.data.role,
      weekly_post_day: parsed.data.weekday ?? null,
    },
    { onConflict: "email" },
  );
  if (error) return { ok: false, error: error.message };

  // Also sync any existing profile.
  await supabase
    .from("profiles")
    .update({ role: parsed.data.role, weekly_post_day: parsed.data.weekday ?? null })
    .eq("email", email);

  revalidatePath("/admin/users");
  return { ok: true };
}

export async function removeAuthorizedUser(email: string): Promise<ActionResult> {
  const parsed = z.string().email().max(254).safeParse(email);
  if (!parsed.success) return { ok: false, error: "Invalid email." };
  const { profile } = await requireManager();
  const supabase = await createSupabaseServerClient();
  const clean = parsed.data.trim().toLowerCase();

  // Prevent the only manager from removing themselves and locking the project
  // out of admin access.
  if (clean === profile.email.toLowerCase()) {
    return { ok: false, error: "You cannot remove yourself." };
  }
  const { count: managerCount } = await supabase
    .from("authorized_users")
    .select("email", { count: "exact", head: true })
    .eq("role", "manager");
  const { data: targetRow } = await supabase
    .from("authorized_users")
    .select("role")
    .eq("email", clean)
    .maybeSingle();
  const target = targetRow as { role?: ProfileRow["role"] } | null;
  if (target?.role === "manager" && (managerCount ?? 0) <= 1) {
    return { ok: false, error: "Cannot remove the last remaining manager." };
  }

  await supabase.from("authorized_users").delete().eq("email", clean);
  // Demote profile to writer — any @convegenius.ai employee keeps general
  // posting access (create + submit for review); they just lose author/admin
  // privileges. (Next login re-derives the same writer role.)
  await supabase
    .from("profiles")
    .update({ role: "writer", weekly_post_day: null })
    .eq("email", clean);
  revalidatePath("/admin/users");
  return { ok: true };
}

const TagInput = z.object({ name: z.string().min(1).max(40) });

export async function createTag(input: z.infer<typeof TagInput>): Promise<ActionResult> {
  const parsed = TagInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  await requireManager();
  const supabase = await createSupabaseServerClient();
  const name = parsed.data.name.trim();
  const slug = slugify(name);

  // Friendly duplicate handling — Postgres unique violations otherwise surface
  // as opaque error messages in the toast.
  const { data: existing } = await supabase
    .from("tags")
    .select("id")
    .or(`slug.eq.${slug},name.eq.${name}`)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: false, error: "A tag with this name already exists." };

  const { error } = await supabase.from("tags").insert({ name, slug });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/tags");
  revalidatePath("/");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true };
}

export async function deleteTag(id: string): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid tag id." };
  await requireManager();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("tags").delete().eq("id", parsed.data);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/tags");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true };
}

const PostStatusInput = z.object({
  postId: z.string().uuid(),
  status: z.enum(["draft", "submitted", "scheduled", "published", "archived"]),
});

export async function setPostStatus(
  postId: string,
  status: "draft" | "submitted" | "scheduled" | "published" | "archived",
): Promise<ActionResult> {
  const parsed = PostStatusInput.safeParse({ postId, status });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  await requireManager();
  const supabase = await createSupabaseServerClient();

  // Look up existing row so we can set published_at only on transition to "published"
  // (avoids overwriting the original publish timestamp on re-publish).
  const { data: existing } = await supabase
    .from("posts")
    .select("published_at")
    .eq("id", parsed.data.postId)
    .maybeSingle();

  const update: Record<string, unknown> = { status: parsed.data.status };
  if (parsed.data.status === "published" && !(existing as { published_at?: string | null } | null)?.published_at) {
    update.published_at = new Date().toISOString();
  }
  if (parsed.data.status === "archived") update.archived_at = new Date().toISOString();

  const { error } = await supabase.from("posts").update(update).eq("id", parsed.data.postId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin");
  revalidatePath("/");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true };
}

// ============================================================
// Admin review queue — approve / request changes / reject
// ============================================================

/** Slim post shape the review actions need: identity + author contact. */
interface ReviewPostRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  published_at: string | null;
  author: { email: string } | null;
}

async function loadReviewPost(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  postId: string,
): Promise<ReviewPostRow | null> {
  const { data } = await supabase
    .from("posts")
    .select("id, slug, title, status, published_at, author:profiles!posts_author_id_fkey ( email )")
    .eq("id", postId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    slug: string;
    title: string;
    status: string;
    published_at: string | null;
    author: { email: string } | { email: string }[] | null;
  };
  const author = Array.isArray(row.author) ? (row.author[0] ?? null) : row.author;
  return { ...row, author: author ? { email: author.email } : null };
}

function revalidateReviewSurfaces(): void {
  revalidatePath("/admin");
  revalidatePath("/admin/review");
  revalidatePath("/me/posts");
}

/**
 * Approve a submitted post and publish it in one step. Sets the review audit
 * fields, flips status to published, then runs the same publish side effects
 * as the editor's Post Now (contributor sync, artifact cleanup, newsletter),
 * and emails the writer. Manager-only.
 */
export async function approveAndPublishPost(postId: string): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(postId);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId } = await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data);
  if (!post) return { ok: false, error: "Post not found." };

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    review_status: "approved",
    reviewed_at: now,
    reviewed_by: userId,
    review_note: null,
    rejection_reason: null,
    status: "published",
  };
  if (!post.published_at) update.published_at = now;

  const { error } = await supabase.from("posts").update(update).eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  // Publish side effects — same as the editor's Post Now path.
  await cleanupReviewArtifactsOnPublish(post.id);
  await syncPostContributors(post.id);
  void sendPerPostNewsletter(post.id).catch((err) => {
    console.error("[approveAndPublishPost] newsletter dispatch failed", err);
  });
  if (post.author?.email) {
    void notifyWriterOfReview({
      postId: post.id,
      slug: post.slug,
      title: post.title,
      writerEmail: post.author.email,
      decision: "approved",
    }).catch((err) => console.error("[approveAndPublishPost] notify failed", err));
  }

  revalidatePath("/");
  revalidatePath(`/posts/${post.slug}`);
  updateTag(PUBLIC_FEED_TAG);
  revalidateReviewSurfaces();
  return { ok: true };
}

const ReviewFeedbackInput = z.object({
  postId: z.string().uuid(),
  note: z.string().trim().min(1, "Please add a note for the writer.").max(2000),
});

/**
 * Send a submitted post back to the writer with a note, without rejecting it.
 * Returns the post to draft so the writer regains edit control; the
 * changes_requested badge + note persist until they resubmit. Manager-only.
 */
export async function requestPostChanges(
  postId: string,
  note: string,
): Promise<ActionResult> {
  const parsed = ReviewFeedbackInput.safeParse({ postId, note });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { userId } = await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data.postId);
  if (!post) return { ok: false, error: "Post not found." };

  const { error } = await supabase
    .from("posts")
    .update({
      review_status: "changes_requested",
      status: "draft",
      review_note: parsed.data.note,
      rejection_reason: null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  if (post.author?.email) {
    void notifyWriterOfReview({
      postId: post.id,
      slug: post.slug,
      title: post.title,
      writerEmail: post.author.email,
      decision: "changes_requested",
      note: parsed.data.note,
    }).catch((err) => console.error("[requestPostChanges] notify failed", err));
  }

  revalidateReviewSurfaces();
  return { ok: true };
}

/**
 * Reject a submitted post with a required reason. Returns it to draft so the
 * writer can revise + resubmit; the rejection reason persists until then.
 * Manager-only.
 */
export async function rejectPost(postId: string, reason: string): Promise<ActionResult> {
  const parsed = z
    .object({ postId: z.string().uuid(), reason: z.string().trim().min(1, "A rejection reason is required.").max(2000) })
    .safeParse({ postId, reason });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  const { userId } = await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data.postId);
  if (!post) return { ok: false, error: "Post not found." };

  const { error } = await supabase
    .from("posts")
    .update({
      review_status: "rejected",
      status: "draft",
      rejection_reason: parsed.data.reason,
      review_note: null,
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  if (post.author?.email) {
    void notifyWriterOfReview({
      postId: post.id,
      slug: post.slug,
      title: post.title,
      writerEmail: post.author.email,
      decision: "rejected",
      note: parsed.data.reason,
    }).catch((err) => console.error("[rejectPost] notify failed", err));
  }

  revalidateReviewSurfaces();
  return { ok: true };
}

// ============================================================
// Hide / restore / delete a published post (manager-only)
// ============================================================

/**
 * Hide a published post: remove it from the public feed without deleting it.
 * Public queries pin status='published', so flipping to 'hidden' instantly
 * makes it unavailable (the post detail route 404s) while keeping it in the
 * admin review queue under the "Hidden" tab.
 */
export async function hidePost(postId: string): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(postId);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId } = await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data);
  if (!post) return { ok: false, error: "Post not found." };

  const { error } = await supabase
    .from("posts")
    .update({ status: "hidden", hidden_at: new Date().toISOString(), hidden_by: userId })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath(`/posts/${post.slug}`);
  updateTag(PUBLIC_FEED_TAG);
  revalidateReviewSurfaces();
  return { ok: true };
}

/** Restore a hidden post back to published (re-list it on the public feed). */
export async function restoreHiddenPost(postId: string): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(postId);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data);
  if (!post) return { ok: false, error: "Post not found." };
  if (post.status !== "hidden") return { ok: false, error: "Only hidden posts can be restored." };

  const { error } = await supabase
    .from("posts")
    .update({
      status: "published",
      hidden_at: null,
      hidden_by: null,
      published_at: post.published_at ?? new Date().toISOString(),
    })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath(`/posts/${post.slug}`);
  updateTag(PUBLIC_FEED_TAG);
  revalidateReviewSurfaces();
  return { ok: true };
}

/**
 * Soft-delete a post (admin). Moves it out of the public feed and the active
 * review queue into the "Deleted" tab. Reuses the existing 'archived' trash
 * state and stamps deleted_at/deleted_by for the admin audit trail. Reversible
 * until a permanent delete.
 */
export async function deletePostAdmin(postId: string): Promise<ActionResult> {
  const parsed = z.string().uuid().safeParse(postId);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId } = await requireManager();
  const supabase = await createSupabaseServerClient();

  const post = await loadReviewPost(supabase, parsed.data);
  if (!post) return { ok: false, error: "Post not found." };

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("posts")
    .update({ status: "archived", archived_at: now, deleted_at: now, deleted_by: userId })
    .eq("id", post.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/");
  revalidatePath(`/posts/${post.slug}`);
  updateTag(PUBLIC_FEED_TAG);
  revalidateReviewSurfaces();
  return { ok: true };
}

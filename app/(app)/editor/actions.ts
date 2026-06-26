"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { requireSession, requireWriter } from "@/lib/auth/guards";
import {
  getCollaboratorRole,
  getActiveLock,
  resolvePostAccess,
} from "@/lib/db/collaboration";
import { deriveAccess } from "@/lib/auth/collaboration";
import { canCreatePost } from "@/lib/auth/roles";
import type { PostStatus, ReviewStatus } from "@/lib/db/types";
import { slugify, withSuffix } from "@/lib/utils/slugs";
import { weekStartISO } from "@/lib/utils/dates";
import { readTimeFromHtml } from "@/lib/utils/read-time";
import { normalizePostHtml, normalizePostText } from "@/lib/utils/normalize-text";
import { sanitizeHtml } from "@/lib/editor/sanitize";
import { publicEnv } from "@/lib/env";
import { WEEKLY_TEMPLATE } from "@/lib/editor/template";
import { sendPerPostNewsletter } from "@/lib/email/newsletter";
import { notifyAdminsOfSubmission, notifyCollaboratorInvite } from "@/lib/email/reviewNotifications";
import {
  cleanupReviewArtifactsOnPublish,
  syncPostContributors,
} from "@/lib/db/publishSideEffects";
import { PUBLIC_FEED_TAG } from "@/lib/db/public";

const SavePostSchema = z.object({
  id: z.string().uuid().optional(),
  // Drafts may save with no title (autosave while the user is still typing);
  // the client decides whether a save can promote a draft to a publishable
  // status. We enforce a non-empty title at publish time below instead of in
  // the schema.
  title: z.string().max(160).default(""),
  excerpt: z.string().max(500).optional().nullable(),
  content_json: z.unknown(),
  content_html: z.string().default(""),
  status: z
    .enum(["draft", "submitted", "scheduled", "published", "archived", "hidden"])
    .default("draft"),
  // `scheduled_for` is now an explicit input from the Schedule Post modal.
  // The server only writes it when status === "scheduled".
  scheduled_for: z.string().datetime().nullable().optional(),
  cover_media_id: z.string().uuid().nullable().optional(),
  tag_ids: z.array(z.string().uuid()).optional(),
});

export type SavePostInput = z.infer<typeof SavePostSchema>;

/** Slim shape of the existing post row fetched before an update. */
interface ExistingPostRow {
  id: string;
  slug: string;
  author_id: string;
  status: string;
  title: string;
  review_status: ReviewStatus;
  deleted_at: string | null;
}

export interface SavePostResult {
  ok: boolean;
  id?: string;
  slug?: string;
  status?: string;
  /** ISO timestamp the post will go live at — only set when status==='scheduled'. */
  scheduledFor?: string | null;
  error?: string;
  fieldErrors?: Record<string, string>;
}

async function ensureUniqueSlug(base: string, currentId?: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  let candidate = base;
  for (let i = 0; i < 6; i++) {
    const q = supabase.from("posts").select("id").eq("slug", candidate).limit(1);
    const { data } = await q;
    const conflict = (data ?? []).find((r) => (r as { id: string }).id !== currentId);
    if (!conflict) return candidate;
    candidate = withSuffix(base, Math.random().toString(36).slice(2, 6));
  }
  return withSuffix(base, Date.now().toString(36));
}

/**
 * Lightweight timing logger gated by SAVE_POST_TIMING_LOG=1. Off by default so
 * production function logs don't fill with timing chatter. Flip the env in
 * Vercel to debug a regression — output is one line per save, no PII.
 */
function timed(label: string, startedAt: number): number {
  const elapsed = Math.round(performance.now() - startedAt);
  if (process.env.SAVE_POST_TIMING_LOG === "1") {
    console.log(`[savePost.timing] ${label}=${elapsed}ms`);
  }
  return elapsed;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const aSorted = [...a].sort();
  const bSorted = [...b].sort();
  for (let i = 0; i < aSorted.length; i++) if (aSorted[i] !== bSorted[i]) return false;
  return true;
}

export async function savePost(input: SavePostInput): Promise<SavePostResult> {
  const totalStart = performance.now();
  const parsed = SavePostSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join(".")] = issue.message;
    }
    return { ok: false, error: "Invalid input.", fieldErrors };
  }
  const data = parsed.data;
  const supabase = await createSupabaseServerClient();
  // Normalise em/en dashes BEFORE sanitisation — body, summary, and title all
  // get the same treatment so feed cards, OG metadata, and the in-page render
  // are consistent. URL text inside <a> anchors is preserved by the HTML walker.
  const html = sanitizeHtml(normalizePostHtml(data.content_html ?? ""));
  const readTime = readTimeFromHtml(html);
  const trimmedTitle = normalizePostText(data.title.trim());
  const normalizedExcerpt = data.excerpt ? normalizePostText(data.excerpt.trim()) : null;

  // PARALLELIZE three reads: session+profile, the existing post row (when
  // editing), and the post's current tag set (so we can skip the re-sync when
  // unchanged). Before this change these ran serially after each other, which
  // cost 1 round-trip per read against Supabase (~100–200ms each).
  const readStart = performance.now();

  // Supabase's query builders return `PromiseLike`, not native `Promise`. We
  // wrap each one with `Promise.resolve(...)` so `Promise.all` can accept
  // them alongside `requireSession()` (a real `Promise`). The shape of each
  // resolved value is whatever the builder returns from `.then(...)`.
  const existingPromise = data.id
    ? Promise.resolve(
        supabase
          .from("posts")
          .select("id, slug, author_id, status, title, review_status, deleted_at")
          .eq("id", data.id)
          .maybeSingle(),
      ).then((res) => ({
        data: res.data as ExistingPostRow | null,
      }))
    : Promise.resolve({ data: null as ExistingPostRow | null });

  const tagsPromise = data.id && data.tag_ids
    ? Promise.resolve(
        supabase.from("post_tags").select("tag_id").eq("post_id", data.id),
      ).then((res) => ({ data: (res.data ?? []) as { tag_id: string }[] }))
    : Promise.resolve({ data: [] as { tag_id: string }[] });

  const coverPromise = data.cover_media_id
    ? Promise.resolve(
        supabase
          .from("media_assets")
          .select("owner_id, media_type, post_id")
          .eq("id", data.cover_media_id)
          .maybeSingle(),
      ).then((res) => ({ data: res.data as { owner_id: string; media_type: string; post_id: string | null } | null }))
    : Promise.resolve({ data: null as { owner_id: string; media_type: string; post_id: string | null } | null });

  const [{ userId, profile }, existingRes, tagsRes, coverRes] = await Promise.all([
    requireSession(),
    existingPromise,
    tagsPromise,
    coverPromise,
  ]);
  timed("auth+fetch", readStart);

  if (!canCreatePost(profile.role)) {
    return { ok: false, error: "You don't have permission to author posts." };
  }
  const isGeneralWriter = profile.role === "writer";

  // Resolve the caller's relationship to an EXISTING post and enforce the edit
  // lock. A brand-new post (no id) is authored by the caller, so this is a
  // no-op for the create path. Reviewers + non-collaborators are blocked here;
  // editor collaborators may only change content, never the publish status.
  const existing = existingRes.data;
  let isCollaboratorEdit = false;
  let frozenStatus: PostStatus | null = null;
  if (data.id) {
    if (!existing) return { ok: false, error: "Post not found." };
    const [collaboratorRole, activeLock] = await Promise.all([
      getCollaboratorRole(supabase, data.id, userId),
      getActiveLock(supabase, data.id),
    ]);
    const access = deriveAccess({
      authorId: existing.author_id,
      userId,
      role: profile.role,
      collaboratorRole,
    });
    if (!access.canEdit) {
      return { ok: false, error: "You don't have permission to edit this post." };
    }
    // Never write over an active lock held by another user (one-at-a-time),
    // and require editor collaborators to actually hold the lock first.
    if (activeLock && activeLock.lockedBy.id !== userId) {
      return { ok: false, error: `This post is currently locked by ${activeLock.lockedBy.name}.` };
    }
    if (access.relationship === "editor" && !(activeLock && activeLock.lockedBy.id === userId)) {
      return {
        ok: false,
        error: "Acquire the edit lock before saving — another editor may be working on this post.",
      };
    }
    if (access.relationship === "editor") {
      isCollaboratorEdit = true;
      frozenStatus = existing.status as PostStatus;
    }
  }

  // General writers can never edit a post that's live OR under admin
  // moderation. Blocking only "published" left a hole: an admin-hidden post is
  // still authored by the writer, and a Submit-for-Review save would flip it to
  // 'submitted' (passing RLS), silently undoing the hide. Block published,
  // hidden, and admin-deleted here so moderation can't be reversed by the author.
  if (
    isGeneralWriter &&
    existing &&
    (existing.status === "published" || existing.status === "hidden" || existing.deleted_at)
  ) {
    return {
      ok: false,
      error:
        existing.status === "published"
          ? "This signal is live and can no longer be edited."
          : "This signal is under admin moderation and can no longer be edited.",
    };
  }

  // Determine desired status. The new publish flow has three explicit verbs —
  // Save Draft, Schedule Post, Post Now — which set draft / scheduled / published
  // respectively. The optional manager-review gate still demotes a Post Now to
  // "submitted" for authors.
  let desiredStatus = data.status;
  // `hidden` is an admin-only moderation state reached exclusively through the
  // audited, manager-gated hidePost action — never honor it as a client-
  // supplied save status (that would create hidden posts with no audit trail).
  if (desiredStatus === "hidden") {
    desiredStatus = (existing?.status as PostStatus) ?? "draft";
  }
  if (publicEnv.requireManagerReview && profile.role === "author" && desiredStatus === "published") {
    desiredStatus = "submitted";
  }

  // Review workflow for general writers. They have only two verbs — Save Draft
  // and Submit for Review — and can never reach published/scheduled. We track
  // the review sub-state separately from the publishing status.
  //   not_submitted  → draft, never sent
  //   under_review   → submitted, sitting in the admin queue
  //   changes_requested / rejected → back in the writer's hands (draft) with
  //                    feedback; preserved across plain draft-saves until resubmit
  let reviewStatusUpdate: ReviewStatus | null = null;
  let submittedForReviewAt: string | null | undefined; // undefined = leave column untouched
  let justSubmittedForReview = false;
  if (isGeneralWriter) {
    const currentReview: ReviewStatus = existing?.review_status ?? "not_submitted";
    if (currentReview === "under_review") {
      // Edits while under review don't pull the post out of the queue — the
      // admin always sees the latest version (product decision).
      desiredStatus = "submitted";
      reviewStatusUpdate = "under_review";
    } else if (data.status === "submitted") {
      // Explicit Submit for Review (or resubmit after changes/rejection).
      desiredStatus = "submitted";
      reviewStatusUpdate = "under_review";
      submittedForReviewAt = new Date().toISOString();
      justSubmittedForReview = true;
    } else {
      // Save Draft — keep any prior feedback state so the banner persists.
      desiredStatus = "draft";
      reviewStatusUpdate = currentReview === "not_submitted" ? "not_submitted" : currentReview;
    }
  }

  // Editor collaborators can never change the publish status — their save only
  // touches content. Freeze the status to whatever the post already has.
  if (isCollaboratorEdit && frozenStatus) {
    desiredStatus = frozenStatus;
    reviewStatusUpdate = null;
  }

  // Title is required for anything beyond a draft. Drafts may save empty so the
  // autosave doesn't keep failing while the author is still typing. Collaborator
  // edits don't change status, so they skip this gate.
  if (!isCollaboratorEdit && desiredStatus !== "draft" && trimmedTitle.length === 0) {
    return {
      ok: false,
      error: "Title is required before publishing.",
      fieldErrors: { title: "Title is required." },
    };
  }

  // Scheduling is now FULLY manual via the Schedule Post modal. We only honour
  // scheduled_for when the client explicitly set status === "scheduled", and
  // we enforce that the slot is in the future so authors can't backdate.
  let scheduledFor: string | null = null;
  if (!isCollaboratorEdit && desiredStatus === "scheduled") {
    if (!data.scheduled_for) {
      return {
        ok: false,
        error: "Pick a future date and time before scheduling.",
        fieldErrors: { scheduled_for: "Choose a future date and time." },
      };
    }
    const slot = new Date(data.scheduled_for).getTime();
    if (Number.isNaN(slot) || slot <= Date.now()) {
      return {
        ok: false,
        error: "Choose a future date and time.",
        fieldErrors: { scheduled_for: "Choose a future date and time." },
      };
    }
    scheduledFor = new Date(slot).toISOString();
  }

  // Cover validity check — the supplied media_assets row must be an image the
  // caller can legitimately use: one they uploaded, one already attached to
  // this post (so collaborators can pick an image the owner inserted), or any
  // image when the caller is a manager. Otherwise we silently null it (safer
  // than rejecting the whole save).
  let coverMediaId: string | null | undefined = data.cover_media_id;
  if (coverMediaId) {
    const c = coverRes.data;
    const belongsToThisPost = !!data.id && !!c && c.post_id === data.id;
    const usable =
      !!c &&
      c.media_type === "image" &&
      (c.owner_id === userId || belongsToThisPost || profile.role === "manager");
    if (!usable) {
      coverMediaId = null;
    }
  }

  let postId = data.id;
  let slug: string;

  if (postId && existing) {
    // Update path. Permission + edit-lock already enforced above; `existing`
    // is the row from the parallel fetch.

    // If the title changed, regenerate a unique slug — otherwise keep stable.
    slug = existing.slug;
    const existingTitle = (existing.title ?? "").trim();
    if (existingTitle !== trimmedTitle && trimmedTitle.length > 0) {
      slug = await ensureUniqueSlug(slugify(trimmedTitle), postId);
    }

    const update: Record<string, unknown> = {
      // Keep an empty draft title falling back to the existing one so the slug
      // stays valid; the schema column is NOT NULL.
      title: trimmedTitle || existingTitle || "Untitled draft",
      slug,
      excerpt: normalizedExcerpt,
      content_json: data.content_json,
      content_html: html,
      cover_media_id: coverMediaId ?? null,
      read_time_minutes: readTime,
    };
    // Editor collaborators only touch content — never status / scheduling /
    // publish timestamps. Owner + manager saves carry the full status change.
    if (!isCollaboratorEdit) {
      update.status = desiredStatus;
      update.scheduled_for = scheduledFor;
      if (desiredStatus === "published") {
        // Always stamp the publish time on "Post Now" so the public byline
        // matches the live moment, even if the post had a previous run as a
        // scheduled draft.
        update.published_at = new Date().toISOString();
      }
      // Clear published_at when a post moves back to scheduled or draft so the
      // live date reflects the next real publish, not an earlier run.
      if (desiredStatus === "scheduled" || desiredStatus === "draft") {
        update.published_at = null;
      }
      if (desiredStatus === "archived") update.archived_at = new Date().toISOString();
      // Review metadata. Writers carry an explicit review_status; for everyone,
      // a transition to published is implicitly review-approved so the badge
      // logic is uniform (published ⇒ approved).
      if (reviewStatusUpdate) update.review_status = reviewStatusUpdate;
      if (submittedForReviewAt !== undefined) update.submitted_for_review_at = submittedForReviewAt;
      if (justSubmittedForReview) {
        // Clear stale feedback from a prior review round on resubmit.
        update.review_note = null;
        update.rejection_reason = null;
      }
      if (desiredStatus === "published") update.review_status = "approved";
    }

    const updateStart = performance.now();
    const { error: updErr } = await supabase.from("posts").update(update).eq("id", postId);
    timed("update", updateStart);
    if (updErr) return { ok: false, error: updErr.message };

    // Tag re-sync — but ONLY when the incoming set actually differs from
    // what's already attached. Skipping this in the unchanged case saves two
    // writes per save (delete + insert), which used to fire on every autosave.
    if (data.tag_ids) {
      const tagStart = performance.now();
      const currentTagIds = tagsRes.data.map((r) => r.tag_id);
      const incomingTagIds = data.tag_ids;
      if (!arraysEqual(currentTagIds, incomingTagIds)) {
        await supabase.from("post_tags").delete().eq("post_id", postId);
        if (incomingTagIds.length > 0) {
          await supabase
            .from("post_tags")
            .insert(incomingTagIds.map((tag_id) => ({ post_id: postId, tag_id })));
        }
        timed("tags", tagStart);
      } else {
        timed("tags_skipped", tagStart);
      }
    }
  } else {
    // An empty draft title needs a unique placeholder slug so the NOT NULL +
    // UNIQUE constraints hold. The slug rolls over to the real title on the
    // next save (the title-change branch above re-slugs).
    const titleForInsert = trimmedTitle || "Untitled draft";
    slug = await ensureUniqueSlug(slugify(titleForInsert));
    const insert: Record<string, unknown> = {
      author_id: userId,
      title: titleForInsert,
      slug,
      excerpt: normalizedExcerpt,
      content_json: data.content_json,
      content_html: html,
      status: desiredStatus,
      week_start_date: weekStartISO(),
      // Assigned weekday is preserved for admin planning + analytics but no
      // longer drives publishing. We seed it from the author's profile so the
      // contributor board stays accurate.
      assigned_weekday: profile.weekly_post_day ?? null,
      scheduled_for: scheduledFor,
      cover_media_id: coverMediaId ?? null,
      read_time_minutes: readTime,
      published_at: desiredStatus === "published" ? new Date().toISOString() : null,
      review_status:
        desiredStatus === "published" ? "approved" : (reviewStatusUpdate ?? "not_submitted"),
      submitted_for_review_at: submittedForReviewAt ?? null,
    };
    const { data: row, error } = await supabase
      .from("posts")
      .insert(insert)
      .select("id, slug")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Insert failed." };
    postId = (row as { id: string }).id;
    slug = (row as { slug: string }).slug;

    if (data.tag_ids && data.tag_ids.length > 0) {
      await supabase
        .from("post_tags")
        .insert(data.tag_ids.map((tag_id) => ({ post_id: postId, tag_id })));
    }
  }

  // Publish-only side effects. Skipped for collaborator content edits (they
  // can't change status, so a published post they touch is already live and
  // these have already run). The owner of record is the existing author, or
  // the caller for a brand-new post.
  if (desiredStatus === "published" && postId && !isCollaboratorEdit) {
    // Draft review comments + the edit lock must not survive into a live post.
    await cleanupReviewArtifactsOnPublish(postId);
    // Public co-author credit (owner + editor collaborators).
    await syncPostContributors(postId);
    // Per-post newsletter — fired once when a post becomes "published". The DB
    // column newsletter_sent_at gates duplicates so re-saves never re-send.
    // Fire-and-forget: never block the editor on the email round-trip. The
    // function itself is idempotent so a missed/retried call is safe.
    void sendPerPostNewsletter(postId).catch((err) => {
      console.error("[savePost] newsletter dispatch failed", err);
    });
  }

  // A general writer just submitted (or resubmitted) for review — notify the
  // admins so they can pick it up from the review queue. Fire-and-forget: a
  // missed email must never fail the save.
  if (justSubmittedForReview && postId) {
    void notifyAdminsOfSubmission({
      postId,
      title: trimmedTitle || "Untitled draft",
      authorName: profile.full_name || profile.email,
    }).catch((err) => {
      console.error("[savePost] review-submission notify failed", err);
    });
    revalidatePath("/admin");
    revalidatePath("/admin/review");
  }

  // Conditional revalidation — drafts aren't public, so revalidating `/` or
  // `/posts/<slug>` on a draft save thrashes the cache for no benefit. We
  // only invalidate the surfaces a status actually affects.
  const revalStart = performance.now();
  if (desiredStatus === "published") {
    // Post just became public on Post Now.
    revalidatePath("/");
    revalidatePath(`/posts/${slug}`);
    // Bust the public-feed unstable_cache entries (posts list, tags,
    // contributor stats) so the new post shows up on the next read.
    updateTag(PUBLIC_FEED_TAG);
  }
  // Authored-side surfaces always reflect the new status / updated_at.
  revalidatePath("/me/posts");
  if (desiredStatus === "published" || desiredStatus === "scheduled" || desiredStatus === "submitted") {
    revalidatePath("/dashboard");
  }
  timed("revalidate", revalStart);
  timed("total", totalStart);

  return {
    ok: true,
    id: postId,
    slug,
    status: desiredStatus,
    scheduledFor: desiredStatus === "scheduled" ? scheduledFor : null,
  };
}

export async function createDraftFromTemplate(): Promise<SavePostResult> {
  return savePost({
    title: "Weekly Update",
    content_json: WEEKLY_TEMPLATE,
    content_html: "",
    status: "draft",
  });
}

/**
 * Author-callable tag creator. The existing `createTag` in admin/actions.ts
 * is gated to managers because the underlying RLS policy is `tags_manager`.
 * Authors writing a post often want to add a fresh tag inline without an
 * admin handoff — we bypass RLS via the service client AFTER verifying the
 * caller is an author/manager. The resulting row is identical to one
 * created via the admin UI.
 */
const TagInputSchema = z.object({
  name: z.string().min(1, "Tag name is required").max(30, "Tag name max 30 chars"),
});

export interface CreateTagResult {
  ok: boolean;
  tag?: { id: string; name: string; slug: string };
  error?: string;
}

export async function createTagAsAuthor(input: {
  name: string;
}): Promise<CreateTagResult> {
  const parsed = TagInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { profile } = await requireSession();
  if (profile.role !== "author" && profile.role !== "manager") {
    return { ok: false, error: "You don't have permission to add tags." };
  }
  const name = parsed.data.name.trim();
  const slug = slugify(name);
  if (!slug) {
    return { ok: false, error: "Tag name must include at least one letter or number." };
  }

  const service = createSupabaseServiceClient();

  // Friendly duplicate handling — return the existing row when slug or name
  // already exists so the editor can select it without a second round-trip.
  const { data: existing } = await service
    .from("tags")
    .select("id, name, slug")
    .or(`slug.eq.${slug},name.eq.${name}`)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      tag: existing as { id: string; name: string; slug: string },
    };
  }

  const { data: inserted, error } = await service
    .from("tags")
    .insert({ name, slug })
    .select("id, name, slug")
    .single();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? "Could not create tag." };
  }
  revalidatePath("/admin/tags");
  revalidatePath("/");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true, tag: inserted as { id: string; name: string; slug: string } };
}

/**
 * Soft delete: mark as archived. The post stays in /me/posts → Trash forever
 * (or until the author/admin permanently deletes it via `permanentDeletePost`).
 */
export async function softDeletePost(id: string): Promise<SavePostResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId, profile } = await requireSession();
  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from("posts")
    .select("author_id, slug, status")
    .eq("id", parsed.data)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Post not found." };
  if ((existing as { author_id: string }).author_id !== userId && profile.role !== "manager") {
    return { ok: false, error: "You can only delete your own posts." };
  }
  const { error } = await supabase
    .from("posts")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", parsed.data);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/");
  revalidatePath("/me/posts");
  revalidatePath("/dashboard");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true, id: parsed.data, slug: (existing as { slug: string }).slug };
}

/** Restore a soft-deleted post back to draft state. */
export async function restorePost(id: string): Promise<SavePostResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId, profile } = await requireSession();
  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from("posts")
    .select("author_id, slug, status, deleted_at")
    .eq("id", parsed.data)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Post not found." };
  const row = existing as { author_id: string; slug: string; status: string; deleted_at: string | null };
  if (row.author_id !== userId && profile.role !== "manager") {
    return { ok: false, error: "You can only restore your own posts." };
  }
  if (row.status !== "archived") {
    return { ok: false, error: "Post is not archived." };
  }
  // An admin-deleted post (deleted_at stamped) is moderation, not the author's
  // own trash — only a manager may bring it back, and we clear the delete stamps
  // so it doesn't linger in the admin "Deleted" tab in a contradictory state.
  if (row.deleted_at && profile.role !== "manager") {
    return { ok: false, error: "This post was removed by an admin and can't be restored here." };
  }
  const { error } = await supabase
    .from("posts")
    .update({ status: "draft", archived_at: null, deleted_at: null, deleted_by: null })
    .eq("id", parsed.data);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/me/posts");
  revalidatePath("/dashboard");
  return { ok: true, id: parsed.data, slug: (existing as { slug: string }).slug };
}

/**
 * Permanent delete. The post owner can wipe their own archived posts from
 * trash, and managers can wipe anyone's. Archived posts live in trash
 * indefinitely — this is the only way they leave the database.
 */
export async function permanentDeletePost(id: string): Promise<SavePostResult> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid post id." };
  const { userId, profile } = await requireSession();
  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from("posts")
    .select("author_id, status")
    .eq("id", parsed.data)
    .maybeSingle();
  if (!existing) return { ok: false, error: "Post not found." };
  const row = existing as { author_id: string; status: string };
  if (row.author_id !== userId && profile.role !== "manager") {
    return { ok: false, error: "You can only delete your own posts." };
  }
  if (row.status !== "archived" && profile.role !== "manager") {
    return { ok: false, error: "Move the post to trash first." };
  }
  // Cascade: post_tags rows are deleted by FK on cascade; media_assets keep
  // their rows but post_id becomes null (FK is on delete set null).
  const { error } = await supabase.from("posts").delete().eq("id", parsed.data);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/");
  revalidatePath("/me/posts");
  updateTag(PUBLIC_FEED_TAG);
  return { ok: true, id: parsed.data };
}

/**
 * @deprecated Use softDeletePost — kept as an alias so old callers keep
 * compiling. Will be removed in a follow-up.
 */
export const archivePost = softDeletePost;

// ============================================================
// Collaboration — invite / remove / role, and draft review comments.
// All of these enforce permission server-side (owner/manager for collaborator
// management; anyone who can review for comments) on top of RLS.
// ============================================================

export interface CollaboratorActionResult {
  ok: boolean;
  error?: string;
}

const PostUserSchema = z.object({
  postId: z.string().uuid(),
  userId: z.string().uuid(),
});

const PostUserRoleSchema = PostUserSchema.extend({
  role: z.enum(["editor", "reviewer"]),
});

/** Owner / manager invites an approved teammate as editor or reviewer. */
export async function inviteCollaborator(input: {
  postId: string;
  userId: string;
  role: "editor" | "reviewer";
}): Promise<CollaboratorActionResult> {
  const parsed = PostUserRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { postId, userId: inviteeId, role } = parsed.data;
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canManageCollaborators) {
    return { ok: false, error: "Only the post owner or an admin can manage collaborators." };
  }
  if (inviteeId === post.authorId) {
    return { ok: false, error: "The owner is already on this post." };
  }

  // Any active ConveGenius user who can author content (writer/author/manager)
  // can be invited — never a `viewer` (external commenter).
  const { data: inviteeRow } = await supabase
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", inviteeId)
    .maybeSingle();
  const invitee = inviteeRow as { id: string; role: string; is_active: boolean } | null;
  if (!invitee || !invitee.is_active || !canCreatePost(invitee.role as Parameters<typeof canCreatePost>[0])) {
    return { ok: false, error: "You can only invite ConveGenius teammates." };
  }

  const { error } = await supabase.from("post_collaborators").insert({
    post_id: postId,
    user_id: inviteeId,
    role,
    invited_by: userId,
  });
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That teammate is already a collaborator." };
    }
    return { ok: false, error: error.message };
  }
  // Keep the public-credit store in sync (editor invites become contributors).
  await syncPostContributors(postId);
  revalidatePath(`/editor/${postId}`);
  revalidatePath("/me/posts");
  return { ok: true };
}

const InviteByEmailSchema = z.object({
  postId: z.string().uuid(),
  email: z.string().email().max(254),
  role: z.enum(["editor", "reviewer"]),
});

/**
 * Owner / manager invites a collaborator by email. If a profile with that email
 * already exists, they're added immediately; otherwise a pending invite is
 * stored and activated on the invitee's next login (see activatePendingInvites).
 * External (non-ConveGenius) emails are blocked.
 */
export async function inviteCollaboratorByEmail(input: {
  postId: string;
  email: string;
  role: "editor" | "reviewer";
}): Promise<CollaboratorActionResult> {
  const parsed = InviteByEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { postId, role } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  const { userId, profile } = await requireWriter();

  // Block external collaborators — only ConveGenius emails may be invited.
  const allowedDomain = (process.env.APP_ALLOWED_EMAIL_DOMAIN ?? "convegenius.ai").toLowerCase();
  if (email.split("@")[1] !== allowedDomain) {
    return { ok: false, error: `Only @${allowedDomain} emails can be invited as collaborators.` };
  }

  const supabase = await createSupabaseServerClient();
  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canManageCollaborators) {
    return { ok: false, error: "Only the post owner or an admin can manage collaborators." };
  }

  // If the user already exists, add them directly (skip the pending flow).
  const { data: existingRow } = await supabase
    .from("profiles")
    .select("id, role, is_active, email")
    .ilike("email", email)
    .maybeSingle();
  const existing = existingRow as
    | { id: string; role: string; is_active: boolean; email: string }
    | null;
  if (existing) {
    if (existing.id === post.authorId) {
      return { ok: false, error: "The owner is already on this post." };
    }
    return inviteCollaborator({ postId, userId: existing.id, role });
  }

  // No profile yet — store a pending invite, activated on their first login.
  const { error } = await supabase
    .from("post_collaborator_invites")
    .upsert(
      { post_id: postId, email, role, invited_by: userId },
      { onConflict: "post_id,email" },
    );
  if (error) return { ok: false, error: error.message };

  // Best-effort invite email (no-op if Resend unconfigured).
  void notifyCollaboratorInvite({ email, postId }).catch((err) =>
    console.error("[inviteCollaboratorByEmail] notify failed", err),
  );

  revalidatePath(`/editor/${postId}`);
  return { ok: true };
}

/** Owner / manager cancels a pending email invite. */
export async function cancelPendingInvite(input: {
  postId: string;
  inviteId: string;
}): Promise<CollaboratorActionResult> {
  const parsed = z
    .object({ postId: z.string().uuid(), inviteId: z.string().uuid() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const { postId, inviteId } = parsed.data;
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canManageCollaborators) {
    return { ok: false, error: "Only the post owner or an admin can manage collaborators." };
  }

  const { error } = await supabase
    .from("post_collaborator_invites")
    .delete()
    .eq("id", inviteId)
    .eq("post_id", postId)
    .is("accepted_at", null);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/editor/${postId}`);
  return { ok: true };
}

/** Owner / manager removes a collaborator (and releases any lock they hold). */
export async function removeCollaborator(input: {
  postId: string;
  userId: string;
}): Promise<CollaboratorActionResult> {
  const parsed = PostUserSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { postId, userId: targetId } = parsed.data;
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canManageCollaborators) {
    return { ok: false, error: "Only the post owner or an admin can manage collaborators." };
  }

  const { error } = await supabase
    .from("post_collaborators")
    .delete()
    .eq("post_id", postId)
    .eq("user_id", targetId);
  if (error) return { ok: false, error: error.message };
  // Free their edit lock so a removed editor can't keep the post locked.
  await supabase.from("post_edit_locks").delete().eq("post_id", postId).eq("locked_by", targetId);
  // Drop their public credit (removed collaborators are no longer contributors).
  await syncPostContributors(postId);

  revalidatePath(`/editor/${postId}`);
  revalidatePath("/me/posts");
  return { ok: true };
}

/** Owner / manager changes a collaborator's role. */
export async function updateCollaboratorRole(input: {
  postId: string;
  userId: string;
  role: "editor" | "reviewer";
}): Promise<CollaboratorActionResult> {
  const parsed = PostUserRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { postId, userId: targetId, role } = parsed.data;
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canManageCollaborators) {
    return { ok: false, error: "Only the post owner or an admin can manage collaborators." };
  }

  const { error } = await supabase
    .from("post_collaborators")
    .update({ role })
    .eq("post_id", postId)
    .eq("user_id", targetId);
  if (error) return { ok: false, error: error.message };
  // A reviewer can't hold the edit lock — release it on downgrade.
  if (role === "reviewer") {
    await supabase.from("post_edit_locks").delete().eq("post_id", postId).eq("locked_by", targetId);
  }
  // Role change flips public credit (editor ⇄ reviewer adds/removes contributor).
  await syncPostContributors(postId);

  revalidatePath(`/editor/${postId}`);
  revalidatePath("/me/posts");
  return { ok: true };
}

const ReviewCommentSchema = z.object({
  postId: z.string().uuid(),
  body: z.string().trim().min(1, "Comment can't be empty.").max(500, "Comment is too long (max 500)."),
});

/** Anyone who can review the draft (owner/manager/collaborator) leaves a note. */
export async function addReviewComment(input: {
  postId: string;
  body: string;
}): Promise<CollaboratorActionResult> {
  const parsed = ReviewCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { postId, body } = parsed.data;
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const { access, post } = await resolvePostAccess(supabase, postId, userId, profile.role);
  if (!post) return { ok: false, error: "Post not found." };
  if (!access.canComment) {
    return { ok: false, error: "You don't have access to review this post." };
  }

  const { error } = await supabase
    .from("post_review_comments")
    .insert({ post_id: postId, user_id: userId, body });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/editor/${postId}`);
  return { ok: true };
}

const CommentIdSchema = z.object({ commentId: z.string().uuid() });

async function loadReviewComment(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  commentId: string,
): Promise<{ id: string; post_id: string; user_id: string; resolved_at: string | null } | null> {
  const { data } = await supabase
    .from("post_review_comments")
    .select("id, post_id, user_id, resolved_at")
    .eq("id", commentId)
    .maybeSingle();
  return (data as { id: string; post_id: string; user_id: string; resolved_at: string | null } | null) ?? null;
}

/** Comment author, post owner, or manager deletes a review comment. */
export async function deleteReviewComment(input: {
  commentId: string;
}): Promise<CollaboratorActionResult> {
  const parsed = CommentIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid comment id." };
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const comment = await loadReviewComment(supabase, parsed.data.commentId);
  if (!comment) return { ok: false, error: "Comment not found." };
  const { access } = await resolvePostAccess(supabase, comment.post_id, userId, profile.role);
  if (comment.user_id !== userId && !access.isOwner && !access.isManager) {
    return { ok: false, error: "You can't delete this comment." };
  }

  const { error } = await supabase
    .from("post_review_comments")
    .delete()
    .eq("id", parsed.data.commentId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/editor/${comment.post_id}`);
  return { ok: true };
}

/** Toggle a review comment's resolved state (author / owner / manager). */
export async function resolveReviewComment(input: {
  commentId: string;
}): Promise<CollaboratorActionResult> {
  const parsed = CommentIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid comment id." };
  const { userId, profile } = await requireWriter();
  const supabase = await createSupabaseServerClient();

  const comment = await loadReviewComment(supabase, parsed.data.commentId);
  if (!comment) return { ok: false, error: "Comment not found." };
  const { access } = await resolvePostAccess(supabase, comment.post_id, userId, profile.role);
  if (comment.user_id !== userId && !access.isOwner && !access.isManager) {
    return { ok: false, error: "You can't resolve this comment." };
  }

  const nextResolvedAt = comment.resolved_at ? null : new Date().toISOString();
  const { error } = await supabase
    .from("post_review_comments")
    .update({ resolved_at: nextResolvedAt })
    .eq("id", parsed.data.commentId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/editor/${comment.post_id}`);
  return { ok: true };
}

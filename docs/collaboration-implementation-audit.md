# Collaboration Implementation Audit

This document records the root-cause analysis that preceded the collaboration
implementation pass and the fixes applied. The feature lets a post owner invite
approved teammates to co-edit a draft (editor role) or comment on it (reviewer
role), with a one-person-at-a-time edit lock and draft-only review comments.

Approved writing team (the only users who may be invited): Aditya, Sumit, Om,
Insha, Aryan — i.e. any active profile whose role is `author` or `manager`.

## Summary table

| Area | Current behavior (before) | Problem | Fix applied | Remaining risk |
|------|---------------------------|---------|-------------|----------------|
| DB tables | No `post_collaborators`, `post_edit_locks`, `post_review_comments`, `post_contributors`. | Collaboration has nowhere to store invitations, locks, comments, or co-author credit. | `supabase/migrations/0013_collaboration.sql` adds all four tables + indexes. | Migration must be applied to each environment (Supabase SQL editor / `supabase db push`). |
| RLS — read drafts | `posts_read_published` allowed read only for published / own / manager. | Invited collaborators could not see the draft they were invited to. | `posts_read_published` extended with `public.is_post_collaborator(posts.id)` (security-definer, recursion-safe). | None — collaborators are still `@convegenius.ai` users gated by `is_convegenius_user()`. |
| RLS — edit drafts | `posts_update_own` allowed update only for the author / manager. | Editor collaborators could not update post content. | New `posts_update_collaborator` policy keyed on `public.is_post_editor_collaborator(posts.id)`; ownership protected by `tg_posts_protect_author` trigger so `author_id` can never be reassigned by a non-manager. | Reviewers correctly cannot update (policy requires `role='editor'`). |
| Editor page access | `app/(app)/editor/[id]/page.tsx` gated on `post.author_id === userId || profile.role === "manager"`. | Collaborators were redirected away from drafts they should be able to open. | Gate replaced with `resolvePostAccess()`; reviewers open read-only, editors open with lock, owner/manager unchanged. | None. |
| `savePost()` | Allowed save only for `existing.author_id === userId || manager`. No lock awareness. | Collaborators could not save; no protection against two people saving at once. | `savePost()` resolves caller relationship, enforces the edit lock, blocks reviewers, freezes status for editor collaborators, and on publish clears review comments + lock + writes contributor credit. | Lock is advisory at the RLS layer (enforced in the server action) — acceptable per spec, and the action is the only write path. |
| `listOwnPosts()` | Listed only `author_id = authorId`. | Collaborators never saw shared drafts in My Posts. | Added `listEditablePostsForUser()` returning owned + shared posts with a relationship tag; `me/posts` now renders a "Shared with me" section. | None. |
| Edit lock | No lock mechanism. | Concurrent edits silently overwrite each other. | `post_edit_locks` table + `/api/posts/[id]/lock`, `/heartbeat`, `/unlock` routes; 5-minute TTL, 60s heartbeat; client acquires/refreshes/releases. | A crashed tab holds the lock until TTL expiry (5 min) — by design; manager/owner can force-unlock. |
| Review comments | None. | No structured draft feedback. | `post_review_comments` table + server actions + `ReviewCommentsPanel`. Deleted automatically on publish so they never leak publicly. | None — comments are draft-only and RLS-gated to people who can review the draft. |
| Media for collaborators | `media_read` allowed only owner / manager / published-post media. | Collaborators could not see a shared draft's cover or pick an inserted image. | `media_read` extended with `public.can_read_draft_post(post_id)`. Upload route blocks reviewers from uploading into a shared post. | Editor collaborators upload under their own `{uid}/{postId}/...` path (existing storage RLS already permits authors). |
| Collaborator UI | `PostEditor.tsx` had no panel, invite UI, lock UI, or comments UI. | No way to manage collaboration from the editor. | Added `CollaboratorsPanel` + `ReviewCommentsPanel`, lock banners, reviewer read-only mode. | None. |

## Security model (enforced server-side)

* Drafts are **never** public. Review comments are **never** public (and are
  deleted on publish).
* Only active `author` / `manager` profiles can be invited — random viewers /
  Gmail commenters cannot.
* The owner cannot be added as a collaborator of their own post; duplicate
  collaborator rows are blocked by a `unique(post_id, user_id)` constraint.
* Reviewers cannot edit content or upload media. Editor collaborators cannot
  publish, schedule, archive, change ownership, or permanently delete.
* Permissions are enforced in RLS **and** in the server actions / API routes —
  not just in the UI. The service-role key is used only server-side for the
  narrow lock/comment lookups that need it.

See `docs/collaboration-feature.md` for the full product + technical reference.

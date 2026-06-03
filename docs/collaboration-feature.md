# Collaboration Feature

Real collaborative draft editing for CG SIGNAL: a post owner invites approved
teammates to co-write (editor) or comment (reviewer) on a draft, with a
one-person-at-a-time edit lock and draft-only review comments that are cleared
when the post publishes.

Shipped in migration `supabase/migrations/0013_collaboration.sql`.

## Product behavior

- A post is owned by its author. The owner (or any manager/admin) can invite
  **1–4** additional teammates — up to all five of the writing team
  (Aditya, Sumit, Om, Insha, Aryan).
- Each collaborator is either an **editor** (can co-write) or a **reviewer**
  (read + comment only).
- Only **active `author`/`manager` profiles** can be invited. Viewers / external
  Gmail commenters cannot be added.
- Invited collaborators see the draft under **My Posts → Shared with me**.
- Only one person edits at a time, enforced by an edit lock.
- Reviewers and editors leave **review comments** on the draft. These are
  **deleted automatically when the post is published** so they never leak.
- On publish, the owner + editor collaborators are recorded as
  **contributors** (`post_contributors`) for future public co-author credit.

## Roles

| Capability | Owner | Manager/Admin | Editor collaborator | Reviewer collaborator |
|---|---|---|---|---|
| Open the draft | ✅ | ✅ (any post) | ✅ | ✅ (read-only) |
| Edit content (with lock) | ✅ | ✅ | ✅ | ❌ |
| Leave review comments | ✅ | ✅ | ✅ | ✅ |
| Resolve/delete any comment | ✅ | ✅ | own only | own only |
| Invite/remove collaborators | ✅ | ✅ | ❌ | ❌ |
| Publish / schedule / archive | ✅ | ✅ | ❌ | ❌ |
| Force-unlock | ✅ | ✅ | ❌ | ❌ |
| Upload media to the post | ✅ | ✅ | ✅ | ❌ |

## Database tables (migration 0013)

- **`post_collaborators`** `(post_id, user_id, role ∈ {editor,reviewer}, invited_by, created_at)` — `unique(post_id, user_id)`.
- **`post_edit_locks`** `(post_id pk, locked_by, locked_at, expires_at)`.
- **`post_review_comments`** `(id, post_id, user_id, body ≤500, resolved_at, created_at)`.
- **`post_contributors`** `(post_id, user_id, role ∈ {owner,editor,contributor}, display_order)` — `unique(post_id, user_id)`; owner rows backfilled.

## RLS model

All cross-table checks are **security-definer** functions so policies never
recurse:

- `is_post_owner(post_id)`, `is_post_collaborator(post_id)`, `is_post_editor_collaborator(post_id)`
- `can_read_draft_post(post_id)` — owner / manager / any collaborator
- `can_edit_draft_post(post_id)` — owner / manager / **editor** collaborator
- `can_review_draft_post(post_id)` — owner / manager / any collaborator
- `can_manage_post_collaborators(post_id)` — owner / manager

Policy changes:

- `posts_read_published` += `is_post_collaborator(posts.id)` (invited collaborators read drafts).
- New `posts_update_collaborator` (editor collaborators update content).
- `tg_posts_protect_author` trigger: only managers may change `author_id`, so the
  collaborator-update policy can't be abused to hijack ownership.
- `post_tags_write` += editor collaborators.
- `media_read` += `can_read_draft_post(post_id)` (collaborators see shared-draft media).
- `post_collaborators` / `post_edit_locks` / `post_review_comments` / `post_contributors`
  each get read/write policies keyed on the helpers above.

## Edit lock lifecycle

- **Acquire** — `POST /api/posts/[id]/lock`. Free/expired → take it; held by you → refresh; held by another active user → `409` with the holder's identity.
- **Heartbeat** — `POST /api/posts/[id]/lock/heartbeat` every **60s**; extends TTL. `409` if you lost the lock.
- **Unlock** — `POST /api/posts/[id]/lock/unlock`. Lock holder releases; manager/owner can force-release ("Take over editing"); already-unlocked silently succeeds.
- TTL is **5 minutes**. The client acquires on mount, heartbeats while open, and releases via `sendBeacon`/`keepalive` fetch on unload.
- `savePost` is the server backstop: it refuses to write over another user's
  active lock and requires editor collaborators to hold the lock.

## Review comments

- Anyone who can review the draft (owner/manager/editor/reviewer) can add a
  ≤500-char note. Authors, the owner, and managers can resolve/delete.
- Comments are **draft-only** and **deleted on publish**
  (`cleanupReviewArtifactsOnPublish`).

## Server actions (`app/(app)/editor/actions.ts`)

`inviteCollaborator`, `removeCollaborator`, `updateCollaboratorRole`,
`addReviewComment`, `deleteReviewComment`, `resolveReviewComment` — all Zod-validated,
permission-checked server-side, and `revalidatePath`-aware. `savePost` resolves the
caller's relationship, enforces the lock, freezes status for editor collaborators,
and on publish clears comments + lock and writes contributor credit.

## UI

- `components/editor/CollaboratorsPanel.tsx` — owner row, collaborator list with
  role badges, invite dropdown (approved teammates only), role change + remove
  (owner/manager). Empty state: *"No collaborators yet. Invite a teammate to
  review or co-write this signal."*
- `components/editor/ReviewCommentsPanel.tsx` — comment thread + composer; resolve/delete.
- `PostEditor` banners: **Review mode** (reviewer), **Editing unlocked for you**
  (editor), **"{name} is editing this post"** (locked) with a Take-over button for
  owner/manager. Reviewers get a read-only editor with publish/upload/tag controls hidden.
- My Posts gains a **Shared with me** section listing invited drafts with an
  Editor/Reviewer badge.

## Known limitations

- The edit lock is **advisory at the RLS layer** — it's enforced in `savePost` +
  the lock API (the only write paths), not by a DB constraint. This is intentional
  (RLS can't express "you hold the lock" cleanly).
- A crashed/closed tab holds the lock until the 5-minute TTL expires; owner/manager
  can force-unlock immediately.
- `post_contributors` data is captured on publish, but the **public co-author
  byline** (post cards / detail / OG metadata) is a follow-up — the credit data
  now exists to drive it.
- A brand-new post (`/editor/new`) must be saved once before collaborators can be
  invited; the panel prompts for this and the approved-teammate list populates on
  the next load of `/editor/[id]`.

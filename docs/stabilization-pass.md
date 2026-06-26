# Stabilization Pass — Review Queue, Hide/Delete, Collaboration, Auto-Subscribe, Layout

Follow-up to [open-posting-review-workflow.md](./open-posting-review-workflow.md). Adds admin moderation of live posts, broadens collaboration, auto-subscribes users on login, and unifies layout.

## Migrations — apply in order

`0017` adds an enum value and **must commit before** `0018`/`0019` reference it.

| File | What it does |
|------|--------------|
| `0017_add_hidden_post_status.sql` | Adds `hidden` to the `post_status` enum (own migration). |
| `0018_stabilization_pass.sql` | Posts: `hidden_at/by`, `deleted_at/by`. Subscribers: `user_id`, `welcome_sent_at`. New `post_collaborator_invites` table + RLS. |
| `0019_writer_update_guard.sql` | Tightens `posts_update_own` RLS: a general writer may only UPDATE rows currently in `draft`/`submitted` (can't un-publish/un-hide their own post via the raw API). Authors/managers unaffected. |

Run them in the SQL Editor as **separate runs**, in numeric order.

## Behavior changes

**Admin moderation of live posts** (`app/(app)/admin/actions.ts`):
- `hidePost` → `status='hidden'` (+ audit). Public queries pin `status='published'`, so a hidden post 404s instantly; it stays in the review queue under **Hidden** and can be restored.
- `restoreHiddenPost` → back to `published`.
- `deletePostAdmin` → soft-delete (`status='archived'` + `deleted_at/by`), lands in the **Deleted** tab.
- Moderation can't be reversed by the author: the writer save-guard blocks editing `published`/`hidden`/admin-deleted posts (`editor/actions.ts`), `restorePost` rejects author-restore of admin-deleted posts and clears delete stamps on manager restore, and admin-deleted posts don't appear in the author's Trash. `'hidden'` is never accepted as a client save status.

**Review queue** (`components/admin/ReviewQueue.tsx`): actions are status-aware — published→`Hide/Delete`, hidden→`Restore/Delete`, approved-unpublished→`Publish` (+ send-back), under-review→`Approve & Publish / Request Changes / Reject`, changes-requested→`Approve & Publish / Reject`. Deleted/rejected are read-only. Tabs: All / Under Review / Changes Requested / Approved / Rejected / Published / Hidden / Deleted.

**Collaboration** (`lib/db/collaboration.ts`, `components/editor/CollaboratorsPanel.tsx`): invite **any** active ConveGenius user (writer/author/manager) with name+email search, or **invite by email** — unregistered invitees get a `post_collaborator_invites` row that activates on their next login (`activatePendingInvites` in the auth callback). External emails are blocked.

**Auto-subscribe on login** (`app/api/auth/callback/route.ts`): every login upserts a `subscribers` row (`source=login_auto_subscribe`, linked `user_id`) and sends the welcome email exactly once (atomic `welcome_sent_at` claim). A prior unsubscribe is respected — never silently re-subscribed.

**Newsletter**: unchanged delivery (fires on editor Post Now, admin Approve & Publish, and the scheduled-publish cron). The "no emails" symptom is almost always the **Resend sandbox sender** (`onboarding@resend.dev` only delivers to the account owner) or **zero subscribers** — both now surfaced in admin diagnostics. Set `RESEND_FROM="CG Signal <signal@verified-domain>"` to reach everyone.

**Admin subscriber diagnostics** (`app/(app)/admin/subscribers/page.tsx`): Welcome-sent count, last-newsletter dispatch, a Resend not-configured / sandbox / OK banner, and a Welcome column.

**Nav** (`components/layout/TopNav.tsx`): `Signal Feed` + `Transmit` removed (the dashboard keeps "Open Signal Feed" + "New Transmission"); routes unchanged.

**Dashboard** (`app/(app)/dashboard/page.tsx`): the weekly schedule shows only for core authors/admins; general writers get a review-status summary card (incl. a "Hidden by admin" count when applicable).

**Layout** (`app/globals.css`): shared `.content-container` (1280px) + `.feed-container` (1440px) with fluid `clamp()` gutters; applied to authenticated pages, top nav, and footer for consistent width/padding across breakpoints.

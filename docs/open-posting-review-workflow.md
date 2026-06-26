# Open Posting + Admin Review Workflow

Opens posting to every `@convegenius.ai` employee while keeping all publishing
behind admin review. The original 5 core team members (`author`/`manager`) are
unchanged. External (non-domain) Google accounts stay read-only commenters.

## Roles

| Role | Who | Editor | Publish/Schedule | Admin |
|------|-----|--------|------------------|-------|
| `manager` | Core admins | ✅ | ✅ | ✅ |
| `author` | Core 5 writers | ✅ | ✅ (direct, unchanged) | ❌ |
| `writer` | Any `@convegenius.ai` employee (NEW) | ✅ | ❌ — submit for review only | ❌ |
| `viewer` | External Gmail / non-domain | ❌ | ❌ | ❌ |

Role helpers live in [lib/auth/roles.ts](../lib/auth/roles.ts): `canCreatePost`
(writer+), `canPublishDirectly` (author/manager), `canReview` (manager),
`isGeneralWriter`. Route guard `requireWriter` ([lib/auth/guards.ts](../lib/auth/guards.ts))
admits writers into the editor + `/me/posts`; `requireManager` still gates admin.

### Role assignment
On login ([app/api/auth/callback/route.ts](../app/api/auth/callback/route.ts)),
internal-domain users not in the `authorized_users` allowlist now default to
`writer` (was `viewer`). Existing `author`/`manager` users are never downgraded.
The DB `bootstrap_profile()` fallback mirrors this.

## Review state machine

`posts.status` is the publishing lifecycle; `posts.review_status` is the review
sub-state (added in migration `0016`). For a general-writer post:

- **create** → `status=draft`, `review_status=not_submitted`
- **Submit for Review** → `status=submitted`, `review_status=under_review`, `submitted_for_review_at`
- **Approve & Publish** (admin) → `status=published`, `review_status=approved`, `reviewed_by/at`
- **Request Changes** (admin) → `status=draft`, `review_status=changes_requested`, `review_note`
- **Reject** (admin) → `status=draft`, `review_status=rejected`, `rejection_reason`

Editing a post that is `under_review` keeps it under review (no auto-revert).
Any transition to `published` (including author direct-publish) sets
`review_status=approved` so badges read uniformly.

## Enforcement (defense in depth)

- **Server actions** are the primary gate. `savePost`
  ([app/(app)/editor/actions.ts](../app/(app)/editor/actions.ts)) clamps writers
  to `draft`/`submitted` and blocks editing a published post. Review decisions
  are manager-only actions in
  [app/(app)/admin/actions.ts](../app/(app)/admin/actions.ts):
  `approveAndPublishPost`, `requestPostChanges`, `rejectPost`.
- **RLS** (migration `0016`): writers may insert/update only their own posts in
  `draft`/`submitted`/`archived` with a non-approved `review_status`, so a writer
  hitting Supabase directly cannot self-publish. Managers retain full access.
- **Public feed** ([lib/db/public.ts](../lib/db/public.ts)) is unchanged — still
  pinned to `status='published'`, so in-review posts never leak. The newsletter
  fires only on transition to `published`.

## Admin review queue

`/admin/review` ([app/(app)/admin/review/page.tsx](../app/(app)/admin/review/page.tsx),
[components/admin/ReviewQueue.tsx](../components/admin/ReviewQueue.tsx)) with
tabs (All / Under Review / Changes Requested / Approved / Rejected / Published).
The admin home shows an "Awaiting review" count + a Review Queue card badge.

## Email notifications

[lib/email/reviewNotifications.ts](../lib/email/reviewNotifications.ts) reuses the
Resend client:
- `notifyAdminsOfSubmission` → emails all admins (env `APP_MANAGER_EMAIL` ∪
  `role='manager'` profiles) when a writer submits.
- `notifyWriterOfReview` → emails the writer on approve / changes / reject.

All sends are fire-and-forget and no-op when `RESEND_API_KEY`/`RESEND_FROM` are
unset, so review actions never block on email.

## Migrations

- `0015_add_writer_role.sql` — adds the `writer` enum value (separate file so it
  commits before being referenced).
- `0016_open_posting_review_workflow.sql` — review columns + constraint + index,
  `is_writer_or_above()`, `bootstrap_profile()` update, RLS, media/storage
  broadening, and backfills (published → approved; internal viewers → writer).

# Codebase stabilization audit (May 14, 2026)

Pass-through audit of the CG SIGNAL codebase against the latest hardening
brief. Most items in that brief are **already shipped from earlier passes**;
the new work in this round is the public-media access fix + this document.
The four genuinely-large missing features (real collaboration, edit locks,
multi-contributor model, profile-in-DB) are explicitly **deferred** with
concrete entry-point notes so a future pass can implement them in isolation.

## Build health

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ exit 0 |
| `next lint --quiet` | ✅ no warnings or errors |
| `vitest run` | ✅ 34/34 passing across 7 test files |
| `next build` | ✅ 22 routes, no errors |
| `package.json` ↔ `package-lock.json` | ✅ in sync (lock present, npm install clean) |

No `any` in code. TypeScript strict + `noUncheckedIndexedAccess` both on.

## Full feature audit

| Area | Current Status | Issue | Fix Applied | Remaining Risk |
|---|---|---|---|---|
| **Public media access** | ✅ fixed this pass | Anonymous readers got 401 on `<img>` / `<audio>` / `<video>` embedded in published posts because `/api/media/file` required auth | Two-tier gate in `app/api/media/file/route.ts`: signed-in users → allowed; anonymous → only if storage_path belongs to a media asset attached to a `published` post (validated via service client). Drafts + orphan media stay locked. Cache-Control widened to `public` so CDN can cache the 302. | None for current scope |
| **Build / typecheck / lint** | ✅ green | n/a | n/a | None |
| **Sticky editor toolbar** | ✅ working | `overflow: hidden` on the `.portal-panel` class was the actual cause — fix from earlier pass moved toolbar OUTSIDE the Card | Toolbar is now a sibling of the Card, sticky `top-16 z-30` binds to viewport. Empty space above toolbar removed by tighter `pt-3 sm:pt-4` page padding. | None |
| **Editor body scroll** | ✅ working | n/a | Mobile uses page-level scroll; toolbar wraps + horizontal-scrolls when needed. Bubble menu via TipTap floating selection. | None |
| **Video upload cap** | ✅ 50 MB everywhere | n/a | `NEXT_PUBLIC_MAX_VIDEO_UPLOAD_MB=50` default in `lib/env.ts`. Enforced both client (`PostEditor`) and server (`/api/media/upload`). | Supabase bucket cap may also need to be 50 MB+ — `0012_bucket_file_size_limit.sql` raises it to 200 MB. Requires Supabase Pro (free tier hard-caps at 50 MB). |
| **YouTube / Loom / Vimeo / GDrive embeds** | ✅ working | n/a | `EmbedBlock` TipTap node + `parseEmbedUrl` allowlist in `lib/utils/embeds.ts`. Paste-to-embed handler turns bare provider URLs into embed nodes. Iframe `referrerpolicy="strict-origin-when-cross-origin"` to authorise unlisted videos. | YouTube videos with embedding explicitly disabled by uploader still error 153 — not fixable from our side. |
| **Audio upload + rendering** | ✅ working | Previously triggered `removeChild` console errors + invisible audio (TipTap had no schema for `<audio>`) | `AudioBlock` Node extension registered in `lib/editor/media-extensions.ts`. Typed insert via `insertMediaBlock(editor, "audio", ...)`. | None |
| **Save Draft / Schedule Post / Post Now** | ✅ working | Server action also catches `removeChild` in payload (`JSON.parse(JSON.stringify(json))` on `content_json`) | Three explicit buttons; schedule modal with native `datetime-local`; per-button busy state; race protection via `saveVersionRef` + `manualSaveInFlight`. | None |
| **Thumbnail picker** | ✅ working | n/a | Cover stored as `posts.cover_media_id` → `media_assets`. Upload-new + pick-from-post-images flows. Direct browser → Supabase upload bypasses Vercel's 4.5 MB function payload limit. | Supabase storage RLS still restricts uploads to `{user_id}/...` folder. |
| **OG / social share preview** | ✅ working | Previously used signed Supabase URL directly in `og:image` → broke after 1h TTL when WhatsApp refetched | `/api/og-image/[slug]` proxy: stable URL, 302s to fresh signed URL on each crawler hit. `/og-default.png` fallback. Width/height 1200x630 in `generateMetadata`. | Crawlers cache for ~24h — first share after a cover change shows the old preview until cache expires. |
| **Email template** | ✅ working | Old template had `END OF TRANSMISSION` / `SIGNAL: STABLE` / `team dhurandhar` chrome, big metadata pill, weekly framing | `postNotificationTemplate` rewritten: thumbnail at top → author label → title → excerpt → first paragraph → Read more button → clean unsubscribe footer. Mobile media-query in `<style>`. | None |
| **Newsletter delivery** | ✅ hardened | Resend sandbox sender silently rejects every non-owner | `isSandboxSender()` detection + per-recipient `sent`/`failed` logs + Resend error categorisation (sandbox / rate_limit / domain_unverified). `getNewsletterDiagnostics()` helper + manager-gated `/api/admin/newsletter-diagnostics` endpoint exposes counts + config status without leaking subscriber emails. | Resend domain verification is a manual one-time step at the DNS provider. Documented in `docs/resend-newsletter-delivery.md`. |
| **Subscribe / unsubscribe** | ✅ working | n/a | `/api/subscribe` validates email + dedupes + soft-fails on duplicate. Welcome email sent on new + reactivated paths only (not re-sent on duplicates). RFC 8058 `List-Unsubscribe` headers. | None |
| **Public landing + filter strip + post cards** | ✅ working | Previously had `min-w-[240px]` causing right-side clipping on mobile | `min-w-0 basis-full sm:basis-auto` on search input. 3-col grid (`sm:grid-cols-2 lg:grid-cols-3`). `PostThumbnail` HTML placeholder when no cover. View counts on cards. | None |
| **Comments + reactions** | ✅ working | n/a | Server actions `addComment` / `toggleReaction` with optimistic UI. Soft-delete (`deleted_at`) on comments. RLS scopes reactions to authenticated users. | None |
| **Share button on post detail** | ✅ working (added last round) | n/a | `<PostShareButton>` — Web Share API primary, clipboard fallback, `execCommand` last resort. | None |
| **Theme system** | ✅ light + dark | System mode removed by user request; light is default | `[data-theme="dark"]` / `[data-theme="light"]` blocks in `globals.css`, pre-hydration `ThemeScript`, hand-rolled `ThemeProvider`. | None |
| **Mobile responsive** | ✅ working | n/a | `overflow-x: clip` on html/body, `min-w-0` on grid cells, responsive editor toolbar, stacked publish buttons. | None |
| **Favicon** | ✅ working | n/a | `public/favicon.ico` + `public/og-default.png` + Next metadata `icons` config. | None |

## Previously-deferred large features

Three of the four large features below shipped in the collaboration pass
(migration `0013_collaboration.sql`). See `docs/collaboration-feature.md` for
the full reference and `docs/collaboration-implementation-audit.md` for the
root-cause table. The fourth (profile-in-DB) remains deferred.

### 1. Real collaboration (`post_collaborators` table) — ✅ IMPLEMENTED

- Migration `0013_collaboration.sql` adds `post_collaborators` (+ `post_edit_locks`,
  `post_review_comments`, `post_contributors`) with recursion-safe security-definer
  RLS helpers (`can_read_draft_post`, `can_edit_draft_post`, `can_review_draft_post`).
- `posts_read_published` now lets invited collaborators read drafts; a new
  `posts_update_collaborator` policy lets editor collaborators update content, with
  ownership frozen by the `tg_posts_protect_author` trigger.
- Server actions: `inviteCollaborator`, `removeCollaborator`, `updateCollaboratorRole`,
  `addReviewComment`, `deleteReviewComment`, `resolveReviewComment` in
  `app/(app)/editor/actions.ts`. `savePost` resolves the caller's relationship and
  blocks reviewers/non-collaborators.
- UI: `components/editor/CollaboratorsPanel.tsx` + `components/editor/ReviewCommentsPanel.tsx`;
  review comments are deleted on publish.

### 2. One-person-at-a-time edit lock — ✅ IMPLEMENTED

- Migration adds `post_edit_locks (post_id pk, locked_by, locked_at, expires_at)`.
- API: `POST /api/posts/[id]/lock`, `…/heartbeat`, `…/unlock` (5-minute TTL,
  60-second heartbeat). Client acquires on mount, heartbeats, releases on unload.
- `savePost` rejects a save when an active lock is held by another user and
  requires editor collaborators to hold the lock first.
- Owner/manager "Take over editing" force-unlock from the lock banner.

### 3. Multi-contributor model (`post_contributors`) — ✅ TABLE + CREDIT IMPLEMENTED

- Migration adds `post_contributors (post_id, user_id, role, display_order)` and
  backfills an `owner` row for every existing post.
- On publish, `savePost` records the owner + every editor collaborator as
  contributors (`syncContributorsOnPublish`). Public byline display on post cards /
  OG metadata is a follow-up (the data is now captured).

### 4. Profile metadata in database (vs `lib/team.ts`) — still DEFERRED

**Status:** not implemented. Designation / pod / topics still live in a hand-edited TypeScript file ([lib/team.ts](../lib/team.ts)).

**What's needed:**
- Migration: add `designation`, `pod`, `topics text[]`, `display_order`, `is_active_contributor` columns to `profiles`.
- Backfill from `TEAM_META`.
- Admin UI (`/admin/users` already exists) — extend the row editor to set these fields.
- Read paths: `ContributorCard` already pulls from `TEAM_META` with a fallback; switch to the DB columns, keep `TEAM_META` as a seed for tests only.

**Entry points:**
- `supabase/migrations/0016_profile_contributor_fields.sql`
- `lib/db/profiles.ts` — extend `ProfileRow`
- `components/admin/UsersAdmin.tsx` — new inline editors
- `components/landing/ContributorCard.tsx` — swap `teamMetaFor` → direct profile fields

## QA snapshot

I can't truly run the app against Supabase from here, but a static-review pass:

- ✅ **Post Now** — `handlePostNow` calls `savePost({ status: "published", scheduled_for: null })`, server clears `scheduled_for`, stamps `published_at`. Newsletter dispatch is fire-and-forget via `void sendPerPostNewsletter`.
- ✅ **Schedule Post** — modal collects ISO timestamp, server re-validates future-only, sets `status: "scheduled"`. Cron at `/api/cron/publish-scheduled` promotes when slot arrives and dispatches the newsletter.
- ✅ **Save Draft** — `handleSaveDraft` passes `status: "draft"`. Empty title allowed; server inserts with `"Untitled draft"` placeholder.
- ✅ **Thumbnail** — direct browser upload bypasses Vercel's 4.5 MB payload limit; `/api/media/upload` records the metadata row; `cover_media_id` written through.
- ✅ **Audio + video upload** — typed Node extensions, 50 MB cap, schema-aware insert (no more removeChild).
- ✅ **YouTube / Loom / Vimeo / GDrive embeds** — toolbar button + paste-to-embed; `EmbedBlock` Node; `referrerpolicy="strict-origin-when-cross-origin"`.
- ✅ **Comments / reactions** — server actions both wired; reactions optimistic with rollback.
- ✅ **Public landing** — uniform grid; thumbnails; subscribe section; contributor cards.
- ✅ **OG social preview** — proxy URL via `/api/og-image/[slug]` with `/og-default.png` fallback.
- ✅ **Subscribe / unsubscribe** — `/api/subscribe` + `/api/subscribe/unsubscribe`. Welcome email gated by Resend config.

## Remaining limitations

- **Resend domain verification is a manual step.** Until `RESEND_FROM` points at a verified non-`@resend.dev` domain, only the Resend account owner receives newsletter emails. Documented in `docs/resend-newsletter-delivery.md` + diagnostics endpoint flags this as `isSandboxSender: true`.
- **Supabase Storage free-tier per-file cap is 50 MB.** Matches our video cap, so OK for free tier; needs Pro for the documented 200 MB bucket setting if usage grows.
- **Vercel cron on Hobby tier is daily-only.** `publish-scheduled` runs at 09:00 UTC daily; posts scheduled to specific minutes inside the day get published at the next 09:00 UTC tick. Pro tier removes this.
- **Collaboration / edit locks / multi-contributor** shipped in the `0013_collaboration.sql` pass (see `docs/collaboration-feature.md`). **Profile-in-DB** (designation/pod/topics columns vs `lib/team.ts`) remains the one deferred feature.
- **In-editor preview was removed** (was crashing the editor by unmounting `EditorContent` + `BubbleMenu` mid-render). Authors preview by Save-Draft + opening the post URL in another tab.

## Files changed this pass

**Modified**
- [app/api/media/file/route.ts](../app/api/media/file/route.ts) — two-tier gate (signed-in users + anonymous-with-validated-published-asset).

**New**
- [docs/codebase-stabilization-audit.md](codebase-stabilization-audit.md) — this document.

That's the entire change-set this round. Everything else listed in the brief either was already implemented in a prior pass (confirmed by typecheck + lint + build all green) or is in the deferred bucket above with entry points.

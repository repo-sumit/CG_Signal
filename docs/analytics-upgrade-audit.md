# CG Signal — Analytics Upgrade Audit

Snapshot of the analytics layer **before** the v2 upgrade and the plan for
extending it into a proper admin intelligence system. Companion to
[`analytics-system-v2.md`](./analytics-system-v2.md).

## Current footprint

| Area | File | Notes |
| ---- | ---- | ----- |
| DB: post views | `supabase/migrations/0010_post_views.sql` | `(post_id, viewer_id, session_id, user_agent, referrer, ip_hash, created_at)`. RLS: manager + post author can read; service role writes. |
| DB: comments / reactions | `supabase/migrations/0007_comments_reactions.sql` | Drives engagement counts; analytics page currently selects raw rows. |
| API: post-view | `app/api/analytics/post-view/route.ts` | Server-side dedupe (30 min per session/post), HMAC-hashed IP, anonymous-tolerant. |
| Client tracker | `components/analytics/PostViewTracker.tsx` | Vercel `track("post_view")` every nav + Supabase POST throttled to once / 30 min via `localStorage`. |
| Vercel wrapper | `lib/analytics/track.ts` | Typed allow-list of event names. |
| Admin dashboard | `app/(app)/admin/analytics/page.tsx` | 8 cards + 2 tables (top posts, audience mix, engagement by post, by-author). |
| Public data layer | `lib/db/public.ts` | `attachViewCounts`/`attachEngagementCounts` populate post cards. |

## Audit findings

| Area | Current status | Missing data | Risk | Fix plan |
| ---- | -------------- | ------------ | ---- | -------- |
| Page views | Per-post insert into `post_views` | Path, device, browser, OS, viewport, locale, timezone, time spent, scroll depth | Cannot answer "how do mobile readers behave" or "what % finish the post" | Extend `post_views` with new columns, add server-side UA parse, push richer payload from the client. |
| Sessions | Implicit via `session_id` text in `post_views` | No first-seen / last-seen, no landing path, no logged-in linkage | Cannot count unique visitors or compare returning vs new | New `analytics_sessions` table; upsert from API on first event in a session. |
| Events | Only "view" exists in DB | No scroll, reaction, share, comment, subscribe, login events captured server-side | Cannot build funnels or per-user reading history | New `analytics_events` table fed by `/api/analytics/event`. |
| Time spent | Not captured | — | Cannot measure read completion | Visibility-aware timer in the client; final beacon via `navigator.sendBeacon`. |
| Scroll depth | Not captured | — | Cannot measure quartile drop-off | Throttled `scroll` listener emits 25/50/75/100 events once per session/post. |
| Device / browser | Raw UA stored, never parsed | Bucketed device/browser/os fields | Admin can't see "60% mobile" without manual grep | `ua-parser-js` on the server, parse on insert. |
| Geo | Not captured | Country / city | Cannot map readership | Read Vercel headers (`x-vercel-ip-country`, `x-vercel-ip-city`) — never store raw IP. |
| Identity (logged-in) | `viewer_id` stamped on view | No aggregated last-seen, no reading history | Admin user-detail view impossible | Aggregate via `analytics_sessions` + `analytics_events`. New `/admin/analytics/users/[userId]` page. |
| Identity (anonymous) | `session_id` per browser | No device summary, no returning-visitor concept | Cannot show "10 anonymous returning readers" | `analytics_sessions` rows update `last_seen_at` on every event. |
| Admin dashboard | Single-page summary | No tabs, no filters, no per-post drilldown, no traffic-source view, no device view | Hard to find specifics; mixed audience metrics inline with completion gauges | Tabbed UI: Overview / Posts / Users / Reactions / Comments / Traffic / Devices / Subscribers. |
| Per-post detail | None | View count is the only post-level metric reachable from UI | Authors / admins can't see who reacted / commented on a specific post | New `app/api/admin/analytics/post/[postId]` + per-post drilldown view in the Posts tab. |
| Privacy | Hashed IP, no email in Vercel `track()` | Documentation gaps (geo, ua parse, time-spent) | Compliance posture must be explicit | Add privacy policy section in v2 doc; never store raw IP, raw geo coords, draft content, or keystrokes. |
| Performance | One blocking server-side `track` POST | New trackers must not multiply that | Risk of N requests/page from naive scroll handlers | Throttle scroll listeners, debounce time-spent updates, `sendBeacon` on `pagehide`, batch optional. |
| RLS | Strict on `post_views` (manager / author) | Same posture required on new tables | Default-allow would leak per-user history | Mirror the manager-read pattern, never expose to anon. |
| Cron / cleanup | No retention job | Analytics tables will grow unbounded | Future cost, not blocking now | Document retention recommendation in v2 doc; no migration needed yet. |

## Out of scope for v2

- A full BI tool / per-tenant export.
- Fingerprinting (canvas, font, etc.) — explicitly forbidden by the prompt.
- Real-time WebSocket dashboards — admin reads are dynamic-rendered, that's enough.
- A retention/cleanup cron — flagged here but deferred until the tables exceed ~1 GB.

## Acceptance summary

After v2:

1. Admin dashboard surfaces total + unique + logged-in / anonymous views.
2. Admin can drill into any post, any user, any reaction, any comment.
3. Devices / browsers / referrers / traffic sources tab is live.
4. Time spent + scroll depth are tracked client-side, persisted server-side.
5. No raw IPs land in the DB. RLS keeps non-admins out.
6. Builds + lint + typecheck still pass.

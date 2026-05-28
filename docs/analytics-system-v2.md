# CG Signal — Analytics System v2

This document describes the upgraded admin analytics surface for CG Signal.
v1 is the existing `post_views` insert pipeline + the single-page admin
dashboard. v2 layers sessions, events, time-spent, scroll depth, device /
browser / OS, traffic-source, and per-user reading history onto that same
foundation — without breaking any existing tracking.

Companion doc: [`analytics-upgrade-audit.md`](./analytics-upgrade-audit.md) —
the pre-upgrade audit that catalogues what each table and component was
missing.

---

## 1. What we collect

### Page / post views

For every post detail page hit, `post_views` records:

- post id, viewer id (if logged in), session id
- path, referrer (raw URL string)
- viewport width / height, language, time zone
- device type (desktop / mobile / tablet / bot / unknown)
- browser family, operating system
- coarse geo (country, city) — Vercel header-derived only
- hashed IP (`hashIp` salts with `CRON_SECRET`)
- time spent (seconds, visible-time only), scroll depth (0–100)
- `read_complete` boolean (true at ≥80 % scroll OR 60 % of estimated read time)

### Sessions

`analytics_sessions` upserts one row per `session_id`:

- `session_id`, `user_id` (set once a logged-in event arrives)
- `first_seen_at`, `last_seen_at`
- device / browser / os, country / city
- `referrer`, `landing_path`, `user_agent`, `ip_hash`
- `event_count`, `page_view_count`

The row promotes from anonymous → logged-in the moment we observe a `user_id`
on any event for the same session. We never demote — once linked, the
session belongs to that user.

### Events

`analytics_events` captures the behaviour stream. Each row has:

- `event_name` (one of 20 allow-listed names; CHECK-constrained at the DB)
- `session_id`, `user_id`, `post_id`, `path`
- `metadata` (jsonb, ≤2 KB) for emoji / depth / time / channel etc.

Events tracked today:

| Name | Source |
| ---- | ------ |
| `page_view` | `AnalyticsTracker` (every navigation) |
| `post_view` | `PostViewTracker` (also writes a `post_views` row) |
| `post_read_start` | `PostAnalyticsTracker` (mount) |
| `post_read_complete` | `PostAnalyticsTracker` (≥80 % scroll OR dwell ≥0.6× estimated) |
| `scroll_25 / 50 / 75 / 100` | `PostAnalyticsTracker` (once each per session/post) |
| `time_spent_update` | `PostAnalyticsTracker` (every 30 s + final beacon) |
| `reaction_added / removed` | `ReactionsBar` |
| `comment_added` | `CommentForm` |
| `share_clicked` | `PostShareButton` |
| `subscribe_submit / success` | existing subscribe flow (Vercel only for now) |
| `login_started / success` | existing auth flow (Vercel only for now) |
| `post_published / scheduled` | existing editor flow (Vercel only for now) |

---

## 2. What we do **not** collect

Hard rules enforced by the schema, the API routes, and code review:

- **No raw IP addresses.** Only `hashIp(ip)` (HMAC-SHA-256, 32 hex chars).
- **No passwords, tokens, draft content, or editor JSON.**
- **No keystrokes or clipboard content.**
- **No precise geo coordinates** — only the country/city Vercel surfaces.
- **No fingerprinting beyond UA family / OS / device type.**
- **No third-party trackers** other than Vercel Analytics + Speed Insights
  (both first-party scripts, no ad-tech mixing).

The Vercel `track()` wrapper in [`lib/analytics/track.ts`](../lib/analytics/track.ts)
maintains a separate hard allow-list of payload shapes — emails, raw text
fields, and tokens are not part of any `TrackEvents` interface and would
fail to compile.

---

## 3. Tables

| Table | New in v2? | Writer | RLS |
| ----- | ---------- | ------ | --- |
| `post_views` | extended | `/api/analytics/post-view` (service role) | manager + author read; no write via session client |
| `analytics_sessions` | yes | both analytics routes via `upsertAnalyticsSession` | manager read only |
| `analytics_events` | yes | `/api/analytics/event` (service role) | manager read; author can read events on own posts |
| `subscribers` | unchanged | `/api/subscribe` (existing) | manager read |
| `comments` | unchanged | server action (existing) | published-post reads |
| `reactions` | unchanged | server action (existing) | published-post reads |

Migration: [`supabase/migrations/0012_analytics_v2.sql`](../supabase/migrations/0012_analytics_v2.sql).

---

## 4. APIs

### `POST /api/analytics/post-view`

Public. Records a `post_views` row OR patches the most recent one in the
session-dedupe window with updated time-spent / scroll-depth / read-complete
values. Body fields:

```jsonc
{
  "postId": "uuid",            // OR `slug`
  "slug": "string",
  "sessionId": "string",
  "referrer": "string|null",
  "path": "string",
  "viewportWidth": 1280,
  "viewportHeight": 800,
  "timeZone": "Asia/Kolkata",
  "language": "en-IN",
  "isLoggedIn": true,
  "timeSpentSeconds": 124,     // optional — only set on patch / final beacon
  "scrollDepth": 87,           // optional
  "readComplete": true         // optional
}
```

Server-side: derives browser/OS/device from the UA, country/city from
Vercel headers, IP hash from the salted secret. Never blocks reads — any
internal error returns `{ ok: true, recorded: false }`.

### `POST /api/analytics/event`

Public. Writes one row into `analytics_events`. The event name must be a
member of the schema allow-list. Body fields:

```jsonc
{
  "eventName": "scroll_75",
  "sessionId": "string",
  "postId": "uuid|null",
  "path": "string",
  "metadata": { "depth": 75 }    // ≤2 KB
}
```

### `GET /api/admin/analytics/post/[postId]`

Manager-only. Returns:

- post header (title / slug / author / publish date)
- aggregate stats (views, unique, logged-in, anonymous, avg time, avg
  scroll, read-complete rate, share clicks)
- breakdowns: devices / browsers / sources / countries
- last 50 reactions with user identity (name / email / avatar)
- last 50 comments with user identity

### `GET /api/admin/analytics/users?window=30d`

Manager-only. Returns the logged-in user activity rollup
(`UserActivityRow[]`) for the selected window preset.

---

## 5. Admin dashboard

`/admin/analytics?tab=<tab>&window=<window>` with these tabs:

- **Overview** — totals, weekly completion, top posts, top referrers.
- **Posts** — per-post engagement table; click any row to drill into the
  same page with a header card summarising that post.
- **Users** — logged-in user rollup. Clicking a row opens
  `/admin/analytics/users/[userId]`.
- **Reactions** — chronological feed of recent reactions with user
  identity. Filter by `?postId=` from the Posts tab.
- **Comments** — chronological feed of recent comments with user identity.
  Filter by `?postId=` from the Posts tab.
- **Traffic Sources** — bucketed referrer counts (WhatsApp / LinkedIn /
  Twitter / Facebook / Instagram / Google / Email / Direct / Other).
- **Devices** — three columns: device type, browser family, OS.
- **Subscribers** — totals + recent subscribers + deep-link to
  `/admin/subscribers`.

Window presets: 24h / 7 days / 30 days / All time. Custom date pickers
were intentionally left out — the four presets cover 95 % of admin use
cases without adding a date-picker dependency.

---

## 6. Client tracking strategy

The post detail page mounts two trackers (non-contributor readers only —
editorial team isn't part of their own metrics):

1. **`PostViewTracker`** — fires Vercel's `post_view` event on every
   navigation. Records one Supabase row per (browser, post) in the 30 min
   dedupe window. Records `device_type`, `browser`, `os`, viewport,
   timezone, language, country/city.

2. **`PostAnalyticsTracker`** — observes reader behaviour:
   - emits `post_read_start` on mount,
   - listens to `scroll` (throttled via `requestAnimationFrame`) and emits
     `scroll_25/50/75/100` once per session/post,
   - maintains a visible-time accumulator (pauses when `document.hidden`),
     emits `time_spent_update` every 30 s,
   - emits `post_read_complete` once at ≥80 % scroll OR when visible
     time crosses 60 % of `posts.read_time_minutes`,
   - on `pagehide`, sends a `sendBeacon` to both `/api/analytics/event`
     and `/api/analytics/post-view` with the final time + max scroll
     so the `post_views` row can be patched.

The site-wide `AnalyticsTracker` (mounted in `(app)/layout.tsx`) emits a
`page_view` on every navigation for logged-in editors so their cross-app
journey is captured even outside post detail.

---

## 7. Privacy / safety summary

| Concern | Posture |
| ------- | ------- |
| Raw IP | Never stored. Hashed via salted HMAC, ≤32 hex chars. |
| Email | Stored on subscribers + auth users; never inside `metadata`. |
| Draft content | Never persisted to analytics tables. |
| Keystrokes / clipboard | Never captured. |
| Geo precision | Country / city only (Vercel headers). |
| Anonymous identity | Sessions only — no cross-site linkage. |
| Admin reach | RLS limits raw reads to managers (and authors for their own posts). |
| Service role usage | Server-only; never reaches client bundles. |

---

## 8. Future improvements

These are out of scope for v2 but a natural follow-up:

- Retention / archive cron once the events table exceeds ~1 GB.
- Funnel report (subscribe → first view → second view → reaction).
- Heat-map style scroll-depth histogram per post.
- A CSV export of any analytics tab.
- Hourly aggregation table so the admin queries don't scan raw rows.

---

## 9. Acceptance checklist

After v2 ships, the admin can:

1. See total views, unique visitors, total sessions.
2. See logged-in vs anonymous split.
3. See logged-in users' names + reading histories (per-user page).
4. Open any post and see who reacted / commented and how long they read.
5. See aggregate device / browser / OS / country mix.
6. See bucketed traffic-source counts.
7. See per-post time spent, scroll depth, read-complete rate.
8. Filter every tab by date window (24h / 7 / 30 / all).
9. Confirm no raw IPs leave the request boundary.
10. Confirm public users hit RLS blocks if they try to read analytics tables.

-- Analytics v2 — sessions + events + richer post_views.
--
-- 0010_post_views.sql introduced raw view rows. v2 adds two sibling tables —
-- analytics_sessions (one row per browser session) and analytics_events
-- (one row per behaviour event). All three tables are written by the
-- /api/analytics/* routes using the service-role client, so RLS only needs
-- to allow READ for managers (and for view counts, the post author).
--
-- Raw IPs are never stored. We keep a salted HMAC of the IP only when the
-- caller's environment provides CRON_SECRET (used as the salt source in
-- /api/analytics/post-view). Country / city come from Vercel-set request
-- headers (x-vercel-ip-country / city) — coarse geo, no coordinates.

-- ============================================================
-- post_views — extend with richer columns
-- ============================================================
alter table public.post_views
  add column if not exists path text,
  add column if not exists device_type text,
  add column if not exists browser text,
  add column if not exists os text,
  add column if not exists country text,
  add column if not exists city text,
  add column if not exists viewport_width integer,
  add column if not exists viewport_height integer,
  add column if not exists time_zone text,
  add column if not exists language text,
  add column if not exists is_logged_in boolean not null default false,
  add column if not exists time_spent_seconds integer,
  add column if not exists scroll_depth integer,
  add column if not exists read_complete boolean not null default false;

-- Allowed device buckets. Anything outside the set is rejected at the
-- application layer; the CHECK is a belt-and-braces defence.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'post_views_device_type_allowed'
  ) then
    alter table public.post_views
      add constraint post_views_device_type_allowed
      check (
        device_type is null
        or device_type in ('desktop', 'mobile', 'tablet', 'bot', 'unknown')
      );
  end if;
end $$;

create index if not exists post_views_device_idx
  on public.post_views (device_type);
create index if not exists post_views_country_idx
  on public.post_views (country);

-- ============================================================
-- analytics_sessions — one row per (session_id), upserted on each event
-- ============================================================
create table if not exists public.analytics_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  device_type text,
  browser text,
  os text,
  country text,
  city text,
  referrer text,
  landing_path text,
  user_agent text,
  ip_hash text,
  event_count integer not null default 0,
  page_view_count integer not null default 0,
  constraint analytics_sessions_device_type_allowed
    check (device_type is null or device_type in ('desktop', 'mobile', 'tablet', 'bot', 'unknown'))
);

create index if not exists analytics_sessions_user_idx
  on public.analytics_sessions (user_id);
create index if not exists analytics_sessions_last_seen_idx
  on public.analytics_sessions (last_seen_at desc);
create index if not exists analytics_sessions_device_idx
  on public.analytics_sessions (device_type);

alter table public.analytics_sessions enable row level security;

drop policy if exists analytics_sessions_manager_read on public.analytics_sessions;
create policy analytics_sessions_manager_read on public.analytics_sessions
  for select using (public.is_manager());

-- ============================================================
-- analytics_events — generic behaviour stream
-- ============================================================
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  user_id uuid references auth.users(id) on delete set null,
  event_name text not null,
  post_id uuid references public.posts(id) on delete cascade,
  path text,
  -- Free-form JSON for the call-site to pass typed payload (scroll depth %,
  -- time spent seconds, reaction emoji, etc.). Caller is responsible for
  -- never embedding PII or secrets — see /api/analytics/event for the
  -- server-side allow-list / sanitization.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint analytics_events_event_name_known check (
    event_name in (
      'page_view',
      'post_view',
      'post_read_start',
      'post_read_complete',
      'scroll_25',
      'scroll_50',
      'scroll_75',
      'scroll_100',
      'time_spent_update',
      'reaction_added',
      'reaction_removed',
      'comment_added',
      'comment_deleted',
      'share_clicked',
      'subscribe_submit',
      'subscribe_success',
      'login_started',
      'login_success',
      'post_published',
      'post_scheduled'
    )
  )
);

create index if not exists analytics_events_post_idx
  on public.analytics_events (post_id, created_at desc);
create index if not exists analytics_events_session_idx
  on public.analytics_events (session_id, created_at desc);
create index if not exists analytics_events_user_idx
  on public.analytics_events (user_id, created_at desc);
create index if not exists analytics_events_name_idx
  on public.analytics_events (event_name, created_at desc);

alter table public.analytics_events enable row level security;

drop policy if exists analytics_events_manager_read on public.analytics_events;
create policy analytics_events_manager_read on public.analytics_events
  for select using (public.is_manager());

-- Authors can read events on their own posts (used by the per-post drilldown
-- when a non-manager author views their analytics surface).
drop policy if exists analytics_events_author_read on public.analytics_events;
create policy analytics_events_author_read on public.analytics_events
  for select using (
    post_id is not null
    and exists (
      select 1 from public.posts p
      where p.id = analytics_events.post_id and p.author_id = auth.uid()
    )
  );

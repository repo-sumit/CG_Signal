-- Stabilization pass (part 2/2): admin hide/delete audit columns, subscriber
-- linkage for auto-subscribe-on-login, and the pending collaborator-invite
-- table. Depends on 0017 (the `hidden` enum value) being committed first.

-- ============================================================
-- 1. Posts: admin hide/delete audit trail
-- ============================================================
alter table public.posts
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by uuid references public.profiles(id) on delete set null,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete set null;

-- ============================================================
-- 2. Subscribers: link to the signed-in user + one-time welcome gate
--    (auto-subscribe-on-login). `source` already exists.
-- ============================================================
alter table public.subscribers
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists welcome_sent_at timestamptz;

create index if not exists subscribers_user_idx on public.subscribers (user_id);

-- ============================================================
-- 3. Pending collaborator invites (invite-by-email before the
--    invitee has ever logged in). Activated on their next login.
-- ============================================================
create table if not exists public.post_collaborator_invites (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor', 'reviewer')),
  invited_by uuid references public.profiles(id) on delete set null,
  accepted_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (post_id, email)
);
create index if not exists post_collab_invites_email_idx
  on public.post_collaborator_invites (lower(email)) where accepted_at is null;
create index if not exists post_collab_invites_post_idx
  on public.post_collaborator_invites (post_id);

alter table public.post_collaborator_invites enable row level security;

-- Read/write limited to the post owner or a manager (same gate as
-- post_collaborators). Activation on login runs via the service client, which
-- bypasses RLS, so no invitee-facing policy is needed here.
drop policy if exists post_collab_invites_read on public.post_collaborator_invites;
create policy post_collab_invites_read on public.post_collaborator_invites
  for select using (
    public.can_manage_post_collaborators(post_collaborator_invites.post_id)
  );

drop policy if exists post_collab_invites_write on public.post_collaborator_invites;
create policy post_collab_invites_write on public.post_collaborator_invites
  for all using (
    public.can_manage_post_collaborators(post_collaborator_invites.post_id)
  ) with check (
    public.can_manage_post_collaborators(post_collaborator_invites.post_id)
  );

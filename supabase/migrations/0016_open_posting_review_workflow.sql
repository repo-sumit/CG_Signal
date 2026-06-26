-- Open posting (part 2/2): admin review workflow for general writers.
--
-- Depends on 0015 (the `writer` enum value) being committed first.
--
-- Adds a `review_status` column + review metadata to posts, the helper +
-- RLS so general writers can author drafts and submit for review but can
-- never self-publish, and backfills existing data. Core authors/managers are
-- untouched — their policies still match via is_author_or_manager().

-- ============================================================
-- 1. Posts: review_status + review metadata
-- ============================================================
alter table public.posts
  add column if not exists review_status text not null default 'not_submitted',
  add column if not exists submitted_for_review_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists review_note text,
  add column if not exists rejection_reason text;

do $$ begin
  alter table public.posts add constraint posts_review_status_chk
    check (review_status in (
      'not_submitted','under_review','changes_requested','approved','rejected'
    ));
exception when duplicate_object then null; end $$;

-- Partial index — the admin review queue only ever scans the "waiting" set.
create index if not exists posts_review_status_idx on public.posts (review_status)
  where review_status = 'under_review';

-- Backfill: anything already public is implicitly review-approved so existing
-- published posts (incl. the core team's) read correctly in the new UI.
update public.posts set review_status = 'approved'
  where status = 'published' and review_status = 'not_submitted';

-- ============================================================
-- 2. Helper: writer-or-above (defense-in-depth for RLS)
-- ============================================================
create or replace function public.is_writer_or_above()
returns boolean language sql stable security definer set search_path = public, auth as $$
  select coalesce(public.current_user_role() in ('writer', 'author', 'manager'), false);
$$;
grant execute on function public.is_writer_or_above() to authenticated;

-- ============================================================
-- 3. bootstrap_profile: default internal-domain users to `writer`
--    (was `viewer`). The domain gate above still rejects external
--    accounts, so this fallback only fires for @convegenius.ai users
--    who are not in the allowlist. Managers are never downgraded.
-- ============================================================
create or replace function public.bootstrap_profile()
returns public.profiles
language plpgsql security definer set search_path = public, auth as $$
declare
  v_user auth.users%rowtype;
  v_email text;
  v_domain text;
  v_allowed_domain text;
  v_role app_role;
  v_weekday smallint;
  v_full_name text;
  v_avatar text;
  v_profile public.profiles%rowtype;
begin
  select * into v_user from auth.users where id = auth.uid();
  if not found then
    raise exception 'not authenticated';
  end if;

  v_email := lower(v_user.email);
  v_domain := split_part(v_email, '@', 2);
  select lower(allowed_domain) into v_allowed_domain from public.app_settings where id = 1;
  if v_domain <> v_allowed_domain then
    raise exception 'domain_not_allowed' using errcode = '42501';
  end if;

  -- Determine role from allowlist; fallback to writer (general employee).
  select role, weekly_post_day
    into v_role, v_weekday
    from public.authorized_users
    where lower(email) = v_email;
  if v_role is null then
    v_role := 'writer';
  end if;

  v_full_name := coalesce(
    v_user.raw_user_meta_data ->> 'full_name',
    v_user.raw_user_meta_data ->> 'name',
    split_part(v_email, '@', 1)
  );
  v_avatar := coalesce(
    v_user.raw_user_meta_data ->> 'avatar_url',
    v_user.raw_user_meta_data ->> 'picture'
  );

  insert into public.profiles (id, email, full_name, avatar_url, role, weekly_post_day)
  values (v_user.id, v_email, v_full_name, v_avatar, v_role, v_weekday)
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(public.profiles.full_name, excluded.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        -- Re-sync role from allowlist on every login, but never downgrade an
        -- already-elevated user (manager/author) — protects the core team.
        role = case
          when public.profiles.role in ('manager', 'author') then public.profiles.role
          else excluded.role
        end,
        weekly_post_day = coalesce(excluded.weekly_post_day, public.profiles.weekly_post_day)
  returning * into v_profile;

  return v_profile;
end $$;

revoke all on function public.bootstrap_profile() from public;
grant execute on function public.bootstrap_profile() to authenticated;

-- Backfill: promote stale internal-domain viewers to writer so existing
-- employees who logged in before this change can now post. External Gmail
-- viewers (domain mismatch) are intentionally left as viewer.
update public.profiles
  set role = 'writer'
  where role = 'viewer'
    and split_part(lower(email), '@', 2) =
        (select lower(allowed_domain) from public.app_settings where id = 1);

-- ============================================================
-- 4. RLS — let writers author + submit, but never self-publish.
--    Permissive policies are OR'd, so authors/managers keep matching
--    via is_author_or_manager() and the collaborator/manager policies
--    are untouched.
-- ============================================================

-- INSERT: writers may create only draft/under_review posts; authors/managers
-- are unrestricted (preserves the core team's direct-publish flow).
drop policy if exists posts_insert_self on public.posts;
create policy posts_insert_self on public.posts
  for insert with check (
    public.is_convegenius_user()
    and author_id = auth.uid()
    and public.is_writer_or_above()
    and (
      public.is_author_or_manager()
      or (
        status in ('draft', 'submitted')
        and review_status in ('not_submitted', 'under_review')
      )
    )
  );

-- UPDATE (own): authors/managers unrestricted; writers may only keep a post in
-- draft/submitted/archived and a non-approved review_status — so they can never
-- flip status to published/scheduled or self-approve, even via the raw API.
drop policy if exists posts_update_own on public.posts;
create policy posts_update_own on public.posts
  for update using (
    author_id = auth.uid() and public.is_writer_or_above()
  ) with check (
    author_id = auth.uid()
    and (
      public.is_author_or_manager()
      or (
        status in ('draft', 'submitted', 'archived')
        and review_status in ('not_submitted', 'under_review')
      )
    )
  );

-- ============================================================
-- 5. Media + storage — writers upload cover images / inline media too.
-- ============================================================
drop policy if exists media_insert_self on public.media_assets;
create policy media_insert_self on public.media_assets
  for insert with check (
    owner_id = auth.uid() and public.is_writer_or_above()
  );

drop policy if exists storage_blog_media_insert_own on storage.objects;
create policy storage_blog_media_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'blog-media'
    and public.is_writer_or_above()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Collaboration: invited collaborators (editor / reviewer), one-at-a-time edit
-- locks, draft review comments, and public co-author credit.
--
-- Design notes:
--  * All cross-table access checks live in SECURITY DEFINER helper functions
--    so RLS policies never recurse (a policy on `posts` that reads
--    `post_collaborators` whose own policy reads `posts` would otherwise throw
--    "infinite recursion detected in policy"). The helpers bypass RLS for the
--    lookup and we re-impose the real rule in the policy/server layer.
--  * Ownership is immutable for non-managers (tg_posts_protect_author) so the
--    new "editor collaborator can UPDATE posts" policy can't be abused to
--    reassign `author_id` and hijack a post.

-- ============================================================
-- Tables
-- ============================================================
create table if not exists public.post_collaborators (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('editor', 'reviewer')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(post_id, user_id)
);
create index if not exists post_collaborators_post_idx on public.post_collaborators(post_id);
create index if not exists post_collaborators_user_idx on public.post_collaborators(user_id);

create table if not exists public.post_edit_locks (
  post_id uuid primary key references public.posts(id) on delete cascade,
  locked_by uuid not null references public.profiles(id) on delete cascade,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists post_edit_locks_expires_idx on public.post_edit_locks(expires_at);

create table if not exists public.post_review_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) <= 500),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists post_review_comments_post_idx on public.post_review_comments(post_id, created_at desc);

-- Public co-author credit. Owner rows are backfilled below; editor
-- collaborators are recorded on publish (see savePost). Reviewers are not
-- credited as contributors.
create table if not exists public.post_contributors (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'contributor')),
  display_order int not null default 100,
  created_at timestamptz not null default now(),
  unique(post_id, user_id)
);
create index if not exists post_contributors_post_idx on public.post_contributors(post_id, display_order);

-- ============================================================
-- Security-definer helpers (recursion-safe; locked search_path)
-- ============================================================

-- True when the current user authored the post. Bypasses RLS so it can be
-- referenced from post_collaborators / lock / comment policies without
-- triggering the posts policy (which itself references post_collaborators).
create or replace function public.is_post_owner(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post_id and p.author_id = auth.uid()
  );
$$;

-- True when the current user is any collaborator (editor OR reviewer).
create or replace function public.is_post_collaborator(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.post_collaborators pc
    where pc.post_id = p_post_id and pc.user_id = auth.uid()
  );
$$;

-- True when the current user is specifically an EDITOR collaborator. Used by
-- the posts UPDATE policy — reviewers must never pass this.
create or replace function public.is_post_editor_collaborator(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.post_collaborators pc
    where pc.post_id = p_post_id and pc.user_id = auth.uid() and pc.role = 'editor'
  );
$$;

create or replace function public.can_read_draft_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and (
        p.author_id = auth.uid()
        or public.is_manager()
        or exists (
          select 1 from public.post_collaborators pc
          where pc.post_id = p.id and pc.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.can_edit_draft_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and (
        p.author_id = auth.uid()
        or public.is_manager()
        or exists (
          select 1 from public.post_collaborators pc
          where pc.post_id = p.id and pc.user_id = auth.uid() and pc.role = 'editor'
        )
      )
  );
$$;

create or replace function public.can_review_draft_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and (
        p.author_id = auth.uid()
        or public.is_manager()
        or exists (
          select 1 from public.post_collaborators pc
          where pc.post_id = p.id and pc.user_id = auth.uid()
        )
      )
  );
$$;

-- Owner or manager — the only people allowed to manage the collaborator list.
create or replace function public.can_manage_post_collaborators(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public, auth as $$
  select public.is_post_owner(p_post_id) or public.is_manager();
$$;

grant execute on function public.is_post_owner(uuid) to authenticated;
grant execute on function public.is_post_collaborator(uuid) to authenticated;
grant execute on function public.is_post_editor_collaborator(uuid) to authenticated;
grant execute on function public.can_read_draft_post(uuid) to authenticated;
grant execute on function public.can_edit_draft_post(uuid) to authenticated;
grant execute on function public.can_review_draft_post(uuid) to authenticated;
grant execute on function public.can_manage_post_collaborators(uuid) to authenticated;

-- ============================================================
-- Ownership-immutability trigger
-- Non-managers can never change a post's author_id. This is what makes the
-- "editor collaborator can UPDATE posts" RLS policy safe.
-- ============================================================
create or replace function public.tg_posts_protect_author()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.author_id is distinct from old.author_id and not public.is_manager() then
    raise exception 'author_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists posts_protect_author on public.posts;
create trigger posts_protect_author before update on public.posts
  for each row execute procedure public.tg_posts_protect_author();

-- ============================================================
-- RLS — enable
-- ============================================================
alter table public.post_collaborators   enable row level security;
alter table public.post_edit_locks       enable row level security;
alter table public.post_review_comments  enable row level security;
alter table public.post_contributors     enable row level security;

-- ----------------------------------------------------------------
-- posts — extend read + add collaborator update policy
-- ----------------------------------------------------------------
drop policy if exists posts_read_published on public.posts;
create policy posts_read_published on public.posts
  for select using (
    public.is_convegenius_user()
    and (
      status = 'published'
      or author_id = auth.uid()
      or public.is_manager()
      or public.is_post_collaborator(posts.id)
    )
  );

-- Editor collaborators may UPDATE the post body. Reviewers cannot (the helper
-- requires role='editor'). author_id reassignment is blocked by the trigger
-- above, so we don't need to re-check it in the WITH CHECK.
drop policy if exists posts_update_collaborator on public.posts;
create policy posts_update_collaborator on public.posts
  for update using (
    public.is_post_editor_collaborator(posts.id)
  ) with check (
    public.is_post_editor_collaborator(posts.id)
  );

-- ----------------------------------------------------------------
-- post_tags — let editor collaborators re-sync tags
-- ----------------------------------------------------------------
drop policy if exists post_tags_write on public.post_tags;
create policy post_tags_write on public.post_tags
  for all using (
    exists (
      select 1 from public.posts p where p.id = post_tags.post_id and (
        p.author_id = auth.uid() or public.is_manager()
      )
    )
    or public.is_post_editor_collaborator(post_tags.post_id)
  ) with check (
    exists (
      select 1 from public.posts p where p.id = post_tags.post_id and (
        p.author_id = auth.uid() or public.is_manager()
      )
    )
    or public.is_post_editor_collaborator(post_tags.post_id)
  );

-- ----------------------------------------------------------------
-- media_assets — let collaborators read media on shared drafts
-- ----------------------------------------------------------------
drop policy if exists media_read on public.media_assets;
create policy media_read on public.media_assets
  for select using (
    public.is_convegenius_user()
    and (
      owner_id = auth.uid()
      or public.is_manager()
      or exists (
        select 1 from public.posts p
        where p.id = media_assets.post_id and p.status = 'published'
      )
      or (media_assets.post_id is not null and public.can_read_draft_post(media_assets.post_id))
    )
  );

-- ----------------------------------------------------------------
-- post_collaborators
-- ----------------------------------------------------------------
drop policy if exists post_collaborators_read on public.post_collaborators;
create policy post_collaborators_read on public.post_collaborators
  for select using (
    user_id = auth.uid()
    or public.is_post_owner(post_collaborators.post_id)
    or public.is_manager()
  );

drop policy if exists post_collaborators_write on public.post_collaborators;
create policy post_collaborators_write on public.post_collaborators
  for all using (
    public.can_manage_post_collaborators(post_collaborators.post_id)
  ) with check (
    public.can_manage_post_collaborators(post_collaborators.post_id)
  );

-- ----------------------------------------------------------------
-- post_edit_locks
-- ----------------------------------------------------------------
drop policy if exists post_edit_locks_read on public.post_edit_locks;
create policy post_edit_locks_read on public.post_edit_locks
  for select using (public.can_read_draft_post(post_edit_locks.post_id));

-- Anyone who can edit may create/refresh a lock; managers may force-release
-- (delete) any lock. App logic prevents stealing an *active* lock from
-- another editor — RLS only gates who may touch the table at all.
drop policy if exists post_edit_locks_write on public.post_edit_locks;
create policy post_edit_locks_write on public.post_edit_locks
  for all using (
    public.can_edit_draft_post(post_edit_locks.post_id)
  ) with check (
    public.can_edit_draft_post(post_edit_locks.post_id)
  );

-- ----------------------------------------------------------------
-- post_review_comments
-- ----------------------------------------------------------------
drop policy if exists post_review_comments_read on public.post_review_comments;
create policy post_review_comments_read on public.post_review_comments
  for select using (public.can_review_draft_post(post_review_comments.post_id));

drop policy if exists post_review_comments_insert on public.post_review_comments;
create policy post_review_comments_insert on public.post_review_comments
  for insert with check (
    user_id = auth.uid() and public.can_review_draft_post(post_review_comments.post_id)
  );

drop policy if exists post_review_comments_update on public.post_review_comments;
create policy post_review_comments_update on public.post_review_comments
  for update using (
    user_id = auth.uid()
    or public.is_post_owner(post_review_comments.post_id)
    or public.is_manager()
  ) with check (
    user_id = auth.uid()
    or public.is_post_owner(post_review_comments.post_id)
    or public.is_manager()
  );

drop policy if exists post_review_comments_delete on public.post_review_comments;
create policy post_review_comments_delete on public.post_review_comments
  for delete using (
    user_id = auth.uid()
    or public.is_post_owner(post_review_comments.post_id)
    or public.is_manager()
  );

-- ----------------------------------------------------------------
-- post_contributors — readable by anyone who can read the post (public
-- byline relies on this for published posts); writes go through the service
-- role in server actions only.
-- ----------------------------------------------------------------
drop policy if exists post_contributors_read on public.post_contributors;
create policy post_contributors_read on public.post_contributors
  for select using (
    exists (
      select 1 from public.posts p
      where p.id = post_contributors.post_id
        and (
          p.status = 'published'
          or p.author_id = auth.uid()
          or public.is_manager()
          or public.is_post_collaborator(p.id)
        )
    )
  );

-- ============================================================
-- Backfill — every existing post gets an owner contributor row.
-- ============================================================
insert into public.post_contributors (post_id, user_id, role, display_order)
select p.id, p.author_id, 'owner', 0
from public.posts p
on conflict (post_id, user_id) do nothing;

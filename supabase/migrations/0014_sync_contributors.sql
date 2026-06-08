-- Backfill public co-author credit for posts that already had collaborators
-- before the contributor-display fix. 0013 backfilled owner rows; this also
-- credits existing EDITOR collaborators so the public byline shows them.
--
-- Idempotent: `on conflict do nothing` keeps re-runs safe and never downgrades
-- an existing owner row to editor.

-- 1. Ensure every post still has an owner contributor row.
insert into public.post_contributors (post_id, user_id, role, display_order)
select id, author_id, 'owner', 0
from public.posts
where author_id is not null
on conflict (post_id, user_id) do nothing;

-- 2. Credit existing editor collaborators as contributors.
insert into public.post_contributors (post_id, user_id, role, display_order)
select pc.post_id, pc.user_id, 'editor', 50
from public.post_collaborators pc
join public.posts p on p.id = pc.post_id
where pc.role = 'editor'
  and pc.user_id <> p.author_id
on conflict (post_id, user_id) do nothing;

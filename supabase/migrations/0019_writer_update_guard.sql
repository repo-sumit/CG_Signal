-- Stabilization hardening: stop a general writer from mutating a post that has
-- already left their hands.
--
-- The 0016 writer UPDATE policy restricted the NEW row (WITH CHECK) so writers
-- can't self-publish/self-approve, but its USING clause didn't restrict the
-- EXISTING row — so a writer could hit the PostgREST API directly and flip
-- their own already-published/hidden post back to draft, silently pulling it
-- from the public feed or undoing an admin hide. The server action blocks this,
-- but RLS is the last line of defense and should too.
--
-- Fix: the writer branch may only target rows currently in draft/submitted.
-- Authors/managers (is_author_or_manager) keep full access so they can still
-- edit live posts.

drop policy if exists posts_update_own on public.posts;
create policy posts_update_own on public.posts
  for update using (
    author_id = auth.uid()
    and public.is_writer_or_above()
    and (
      public.is_author_or_manager()
      or status in ('draft', 'submitted')
    )
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

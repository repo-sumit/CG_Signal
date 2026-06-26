-- Stabilization pass (part 1/2): add the `hidden` post status.
--
-- Must be its own migration, separate from the migration that uses the value:
-- Postgres requires a newly added enum value to be committed before it can be
-- referenced in a `::post_status` cast or check. The stabilization migration
-- (0018) that references 'hidden' runs only after this commits.
--
-- `hidden` = an admin took a previously-published post out of the public feed
-- (soft hide). Distinct from `archived` (the author's trash). Hidden posts are
-- never public (the public queries pin status='published'), but stay visible to
-- admins in the review queue and can be restored.

alter type post_status add value if not exists 'hidden';

-- Open posting (part 1/2): add the `writer` app role.
--
-- This MUST be its own migration, separate from the migration that uses the
-- value. Postgres requires a newly added enum value to be committed before it
-- can be referenced in a function body or `::app_role` cast — so the review
-- workflow migration (0016) that builds helpers/policies/backfills using
-- 'writer' runs only after this file has committed.
--
-- Role meaning after this change:
--   viewer  — external (non-domain) account: read + comment + react only
--   writer  — any @convegenius.ai employee: create/edit own posts, submit for
--             review; CANNOT publish/schedule directly (NEW)
--   author  — core team member: full create + direct publish (unchanged)
--   manager — admin: review queue, publish, manage everything (unchanged)

alter type app_role add value if not exists 'writer';

# Post Contributor Display — Debug & Fix

The public post detail page (`/posts/[slug]`) showed only the original
author/owner in the byline ("Sumit / Admin") even when the post had multiple
editor collaborators (e.g. "Decoding Claude" → Sumit + Aryan + Insha). This
documents the root cause and the data-level fix.

| Area checked | Current behavior | Root cause | Fix applied | Remaining risk |
|---|---|---|---|---|
| `app/posts/[slug]/page.tsx` byline | Rendered `post.author` only (single avatar + name + app-role label). | The page never had a contributor array to render — only the single author. | Renders the new `contributors[]`: a multi-contributor row when >1, the existing single-author layout when exactly 1. | None — single-author posts look identical to before. |
| `getPublicPostBySlug` / `listPublicPostsUncached` (`lib/db/public.ts`) | Selected only `author:profiles!posts_author_id_fkey`. Never queried `post_collaborators` or `post_contributors`. | **This is the real bug.** Collaborators existed in the DB but were never fetched for public rendering. | New `attachContributors()` fetches contributors and attaches `contributors: PublicPostContributor[]` to every public post. | None. |
| Contributor source | `post_contributors` is written on publish + collaborator changes (canonical store). | Relying on it alone is fragile if a post was published before editors were added (store not yet synced). | `attachContributors` **unions** three sources and dedupes: post author (owner), `post_collaborators` where `role='editor'` (live), and `post_contributors` rows. Owner is always present even if the store is empty. | A removed editor loses public credit (matches "remove credit on removal" rule). |
| RLS / public read | `media_read` etc. are RLS-gated; public pages render anonymously. | Not the blocker — `lib/db/public.ts` uses the **service-role** client by design (every query is hard-pinned to `status='published'`). | `attachContributors` selects only `id, full_name, avatar_url` from `profiles` — **no email**, no permissions, no draft data. Reviewers (`role='reviewer'`) are never selected, so they're never shown publicly. | None. |
| `post_contributors` freshness | Written only on publish (`syncContributorsOnPublish`). | An editor invited/removed AFTER publish wouldn't update the store. | Replaced with `syncPostContributors(postId)` called on publish **and** on invite / remove / role-change. Plus migration `0014_sync_contributors.sql` backfills editor collaborators into the store for already-published posts. | Drafts get contributor rows too, but drafts are never public, so no leak. |
| Email exposure | Byline fallback used `post.author?.email`. | — | The contributor row uses **first name only** (from `full_name`, fallback `"CG"`); full name in the `title` tooltip. No email is rendered for contributors. | None. |

## Exact root cause

`lib/db/public.ts` fetched a post's single `author_id` join and nothing else.
`post_collaborators` / `post_contributors` rows existed in the database but were
never selected, so the page had no contributor data and rendered only the owner.
The fix is at the **data-query level** (`attachContributors`), not a UI hardcode.

## Privacy safeguards

- Service-role queries stay pinned to `status='published'`.
- Only `full_name` + `avatar_url` are exposed for contributors — never email.
- Reviewer collaborators are excluded from the public contributor list.
- Draft collaborator lists are never rendered on public pages.

## Testing

- **Unit:** `tests/unit/names.test.ts` covers `getFirstName` (first token, whitespace, `"CG"` fallback — never an email).
- **E2E:** `tests/e2e/post-contributors.spec.ts` (Playwright, against a live instance). Set `AUTH_TEST_BASE_URL`, `CONTRIBUTORS_TEST_SLUG` (a published multi-contributor post, e.g. `decoding-claude`), and optionally `CONTRIBUTORS_TEST_NAMES="Sumit,Aryan,Insha"`. Asserts all first names appear, no `@convegenius.ai` email in the byline, no mobile horizontal overflow, and avatars/initials render. Run: `npx playwright test post-contributors`.

### Manual QA (do on the live instance)

1. Open `/posts/decoding-claude`. The byline must show **Sumit, Aryan, Insha** (avatars + first names), not just Sumit.
2. Open any single-author post — byline must look exactly as before (one avatar + name + role).
3. Confirm no email address appears anywhere in the byline.
4. Resize to a 375px-wide mobile viewport — contributor row wraps, no horizontal scroll.
5. Toggle light/dark theme (top-right) — names + avatars stay readable in both.
6. As an owner, remove an editor in the editor's Collaborators panel, re-open the public post — the removed person no longer appears.

> Playwright **MCP** is available in this environment, but driving it requires a
> running app wired to a Supabase project that contains the published
> multi-contributor post. Run the steps above (or the e2e spec) against your
> deployed/staging instance.

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Eye, Heart, MessageSquare, Search } from "lucide-react";
import {
  listPublicPosts,
  listPublicTags,
  listContributorStats,
} from "@/lib/db/public";
import { PublicNav } from "@/components/layout/PublicNav";
import { PortalFooter } from "@/components/layout/PortalFooter";
import { ContributorsSection } from "@/components/landing/ContributorsSection";
import { SubscribeSection } from "@/components/landing/SubscribeSection";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";
import { Input } from "@/components/ui/Input";
import { PostThumbnail } from "@/components/landing/PostThumbnail";
import { publicEnv } from "@/lib/env";
import { getAbsoluteImageUrl } from "@/lib/seo/get-og-image-url";
import { cn } from "@/lib/utils/cn";

// Landing page caching strategy: ISR with a 60-second window.
// • Publish / unpublish / tag changes all call `revalidatePath("/")` from
//   the editor + admin server actions, so user-visible writes invalidate
//   the cache immediately — the 60s TTL only applies to non-write events
//   (a fresh view count, a new reaction tallied into the card footer).
// • Reduces the public landing's Supabase round-trips dramatically: a single
//   render is reused across all visitors within the window.
// • See `docs/frontend-cache-audit.md` for the full reasoning.
export const revalidate = 60;

// Full OG + Twitter block so the root URL also unfurls with a thumbnail when
// shared on WhatsApp / Slack / LinkedIn. Falls back to the same brand image
// the post pages use when a post has no cover.
const landingTitle = "CG SIGNAL · Team Blog Newsletter";
const landingDescription =
  "Daily work signals, product notes, design logs, engineering updates, and team reflections from ConveGenius.";
const landingImage = getAbsoluteImageUrl(null);

export const metadata: Metadata = {
  title: landingTitle,
  description: landingDescription,
  alternates: { canonical: publicEnv.appUrl },
  openGraph: {
    title: landingTitle,
    description: landingDescription,
    url: publicEnv.appUrl,
    siteName: "CG SIGNAL",
    type: "website",
    images: [
      {
        url: landingImage,
        width: 1200,
        height: 630,
        alt: "CG SIGNAL · Team Blog Newsletter",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: landingTitle,
    description: landingDescription,
    images: [landingImage],
  },
};

interface SearchParams {
  tag?: string;
  q?: string;
}

export default async function PublicLandingPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  // OAuth fallthrough — forward stray ?code= to the real callback.
  if ("code" in searchParams) {
    const code = (searchParams as { code?: string }).code;
    if (code) redirect(`/api/auth/callback?code=${encodeURIComponent(code)}`);
  }

  const [allPosts, tags, contributors] = await Promise.all([
    listPublicPosts(60),
    listPublicTags(),
    listContributorStats(),
  ]);

  // Apply filters (tag + free-text). Tag pinned in the dataset; search is a
  // lightweight in-memory match against title/excerpt because the catalog
  // is small.
  let filtered = allPosts;
  if (searchParams.tag) {
    filtered = filtered.filter((p) => p.tags.some((t) => t.slug === searchParams.tag));
  }
  if (searchParams.q) {
    const needle = searchParams.q.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.title.toLowerCase().includes(needle) ||
        (p.excerpt ?? "").toLowerCase().includes(needle),
    );
  }

  // Uniform feed — every post is rendered with the same card chrome, like
  // YouTube's homepage. We previously hoisted the first post into a big
  // "featured" panel; authors found it inconsistent and the placeholder
  // gradient was confusing. Now the first card is just the first card, with
  // only a `LATEST` badge on the freshest item as a subtle editorial cue.
  const totalAuthors = contributors.length;
  const totalPosts = allPosts.length;

  return (
    <div className="flex min-h-screen flex-col">
      <PublicNav />

      <main className="flex-1">
        {/* ============ Hero ============ */}
        {/* `py-16 sm:py-24` gives the hero more breathing room than the rest of
            the page — section rhythm is deliberate: hero > feed > subscribe. */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="absolute inset-0 grid-overlay opacity-40" />
          <div className="feed-container relative py-16 sm:py-24">
            <div className="grid gap-12 lg:grid-cols-[1.35fr_1fr] lg:items-end">
              <div className="max-w-3xl">
                {/* System eyebrow — a single deliberate kicker. Pulsing dot +
                    mono label ties the hero into the design system's signal
                    grammar without restating the page title. */}
                <div className="inline-flex items-center gap-2 font-ui text-[11px] uppercase tracking-[0.22em] text-portal-text-muted">
                  <span
                    aria-hidden
                    className="signal-dot inline-block h-1.5 w-1.5 rounded-full bg-portal-green"
                  />
                  Live · Mon — Fri · 09:00 IST
                </div>
                <h1 className="mt-6 font-hero text-5xl font-bold uppercase leading-[0.92] tracking-tighter text-portal-text sm:text-7xl lg:text-[5.5rem]">
                  ConveGenius
                  <br />
                  signal feed.
                </h1>
                <p className="mt-6 max-w-xl text-base leading-relaxed text-portal-text sm:text-lg">
                  Daily product, design, and engineering signals from the
                  team building ConveGenius.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Button asChild>
                    <Link href="#feed">
                      Read latest <ArrowRight className="h-4 w-4" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="#contributors">Meet the team</Link>
                  </Button>
                </div>
              </div>

              {/* Stats readout — surfaces from `md` so tablet readers see the
                  identity moment instead of an empty column. 4-up horizontal
                  row separated by hairline dividers, not a 2×2 card grid. */}
              <div className="hidden md:block">
                <div className="relative rounded-md border border-portal-border-soft bg-portal-panel-soft/60 p-6 backdrop-blur-sm">
                  <div className="mb-4 flex items-center justify-between font-ui text-[10px] uppercase tracking-[0.22em] text-portal-text-soft">
                    <span>System readout</span>
                    <span className="text-portal-orange">{"// 00"}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
                    <StatReadout label="Transmissions" value={totalPosts} />
                    <StatReadout label="Contributors" value={totalAuthors} />
                    <StatReadout label="Channels" value={tags.length} />
                    <StatReadout label="Cadence" valueText="Mon — Fri" sub="As signals are ready" />
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============ Filter strip ============ */}
        {/* Sits immediately under the hero with a tight pb so the feed below
            it reads as continuous, not three stacked sections. */}
        <section className="feed-container" id="feed">
          <div className="rounded-md border border-portal-border-soft bg-portal-panel-soft p-4">
            <form className="flex flex-wrap items-center gap-3" action="/" method="get">
              {/* min-w-0 is critical — without it the flex parent can't shrink
                  below the input's intrinsic width on narrow phones (~360 px),
                  which was pushing the whole page wider than the viewport. */}
              <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-portal-text-muted" />
                <Input
                  name="q"
                  defaultValue={searchParams.q ?? ""}
                  placeholder="Search transmissions…"
                  className="pl-10"
                />
              </div>
              {searchParams.tag && <input type="hidden" name="tag" value={searchParams.tag} />}
              <Button type="submit" variant="outline">Search</Button>
              {(searchParams.q || searchParams.tag) && (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/">Clear</Link>
                </Button>
              )}
            </form>

            {tags.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-portal-border-soft pt-3">
                {/* `// CHANNEL` in-system kicker — matches the brand's section
                    grammar (PostThumbnail uses the `001 // SIGNAL` idiom). */}
                <span className="mr-2 inline-flex items-center gap-1 font-ui text-[10px] uppercase tracking-[0.22em] text-portal-text-muted">
                  <span className="text-portal-orange">{"//"}</span> Channel
                </span>
                <Link
                  href={{ pathname: "/", query: { ...searchParams, tag: undefined } }}
                  className={cn(
                    "rounded-pill border px-3 py-0.5 font-ui text-[10px] uppercase tracking-wider transition-colors",
                    !searchParams.tag
                      ? "border-portal-orange bg-portal-orange text-white"
                      : "border-portal-border-soft text-portal-text-muted hover:border-portal-border-muted hover:text-portal-text",
                  )}
                >
                  All
                </Link>
                {tags.map((t) => (
                  <Link
                    key={t.id}
                    href={{ pathname: "/", query: { ...searchParams, tag: t.slug } }}
                    className={cn(
                      "rounded-pill border px-3 py-0.5 font-ui text-[10px] uppercase tracking-wider transition-colors",
                      searchParams.tag === t.slug
                        ? "border-portal-orange bg-portal-orange text-white"
                        : "border-portal-border-soft text-portal-text-muted hover:border-portal-border-muted hover:text-portal-text",
                    )}
                  >
                    {t.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ============ Uniform post feed ============ */}
        <section className="feed-container py-10 sm:py-14">
          {filtered.length === 0 ? (
            <EmptyTransmissions filtered={!!(searchParams.q || searchParams.tag)} />
          ) : (
            <>
              <SectionEyebrow
                number="01"
                label="Signal feed"
                tail={`${filtered.length} ${filtered.length === 1 ? "transmission" : "transmissions"}`}
              />
              {/* Fluid auto-fit grid (`.post-grid` in globals.css) — reflows by
                  available width instead of hard breakpoints, so the card
                  count tracks browser zoom and ultra-wide displays alike. */}
              <div className="post-grid">
                {filtered.map((p, i) => (
                  <PublicPostCard key={p.id} post={p} isFirst={i === 0} />
                ))}
              </div>
            </>
          )}
        </section>

        {/* ============ Contributors ============ */}
        {/* Wrap the section with a `02` eyebrow so the editorial rhythm runs
            consistently through the page. The internal ContributorsSection
            still owns its own heading + grid; this row is a deliberate
            running-head, not a duplicate H2. */}
        <section className="feed-container pt-6" id="contributors">
          <SectionEyebrow number="02" label="The crew" tail={`${totalAuthors} active`} />
        </section>
        <ContributorsSection contributors={contributors} />

        {/* ============ Subscribe ============ */}
        <section className="feed-container pt-6">
          <SectionEyebrow number="03" label="Receive the next signal" tail="No spam" />
        </section>
        <SubscribeSection />
      </main>

      <PortalFooter />
    </div>
  );
}

// ---------- helpers ----------

/**
 * Editorial section running-head. Two mono labels separated by a hairline
 * that fills the remaining width — the brand voice's recurring `// 01`
 * section-number motif lifted to page level. Replaces ad-hoc "Latest
 * transmissions" labels with a single, consistent grammar so the whole
 * page reads as one document, not three stacked widgets.
 */
function SectionEyebrow({
  number,
  label,
  tail,
}: {
  number: string;
  label: string;
  tail?: string;
}) {
  return (
    <div className="mb-5 flex items-center gap-3 sm:mb-6">
      <span className="font-ui text-[10px] uppercase tracking-[0.22em] text-portal-orange">
        {`// `}
        {number}
      </span>
      <span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-portal-text">
        {label}
      </span>
      <span aria-hidden className="h-px flex-1 bg-portal-border-soft" />
      {tail ? (
        <span className="shrink-0 font-ui text-[10px] uppercase tracking-[0.18em] text-portal-text-muted">
          {tail}
        </span>
      ) : null}
    </div>
  );
}

function StatReadout({
  label,
  value,
  valueText,
  sub,
}: {
  label: string;
  value?: number;
  valueText?: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.22em] text-portal-text-soft">{label}</dt>
      <dd className="mt-1 font-hero text-3xl font-bold leading-none tracking-tighter text-portal-text sm:text-4xl">
        {value !== undefined ? value : valueText}
      </dd>
      {sub ? (
        <div className="mt-1 truncate text-[9px] uppercase tracking-[0.2em] text-portal-text-soft">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function EmptyTransmissions({ filtered }: { filtered: boolean }) {
  return (
    <div className="rounded-md border border-dashed border-portal-border-soft p-12 text-center sm:p-16">
      <div className="mb-4 inline-flex items-center gap-2 font-ui text-[10px] uppercase tracking-[0.22em] text-portal-text-muted">
        <span aria-hidden className="signal-dot inline-block h-1.5 w-1.5 rounded-full bg-portal-yellow" />
        Signal idle
      </div>
      <h2 className="font-hero text-2xl font-bold uppercase tracking-tighter text-portal-text">
        {filtered ? "Nothing matches" : "No transmissions yet"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-portal-text-muted">
        {filtered
          ? "Try clearing the filter, or pick a different channel."
          : "The team broadcasts Mon — Fri. Check back soon, or subscribe to get the next signal in your inbox."}
      </p>
    </div>
  );
}

function PublicPostCard({
  post,
  isFirst,
}: {
  post: Awaited<ReturnType<typeof listPublicPosts>>[number];
  isFirst: boolean;
}) {
  return (
    <article
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-md border bg-portal-panel",
        "border-portal-border-soft transition-[transform,border-color,box-shadow] duration-200",
        "ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-0.5 hover:border-portal-orange/50 hover:shadow-[0_8px_30px_-12px_rgba(255,90,31,0.18)]",
      )}
    >
      <Link href={`/posts/${post.slug}`} className="flex flex-1 flex-col">
        {/* Thumbnail — real cover if the author picked one, otherwise a
            slug-deterministic placeholder that still feels on-brand. */}
        <div className="relative">
          <PostThumbnail url={post.coverUrl} title={post.title} slug={post.slug} />
          {isFirst ? (
            <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-pill bg-portal-orange px-2 py-0.5 font-ui text-[9px] font-bold uppercase tracking-[0.22em] text-white shadow-[0_4px_12px_-2px_rgba(255,90,31,0.45)]">
              <span aria-hidden className="signal-dot inline-block h-1 w-1 rounded-full bg-white" />
              Latest
            </span>
          ) : null}
          {post.tags.length > 0 && (
            <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex flex-wrap gap-1.5">
              {post.tags.slice(0, 2).map((t) => (
                <Badge key={t.id} variant="secondary" className="pointer-events-auto">
                  {t.name}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Body — title, summary, engagement row. */}
        <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
          <h3 className="line-clamp-2 font-hero text-lg font-bold uppercase leading-snug tracking-tighter text-portal-text transition-colors group-hover:text-portal-orange">
            {post.title}
          </h3>
          {post.excerpt ? (
            <p className="line-clamp-2 text-sm leading-relaxed text-portal-text-muted">
              {post.excerpt}
            </p>
          ) : (
            <p className="text-xs italic text-portal-text-soft">No summary yet.</p>
          )}

          {/* Footer — engagement counts on the left, first-name + avatar on
              the right. Read time intentionally absent (lives on the post
              detail page) to keep the row to a single line on narrow widths. */}
          <div className="mt-auto flex items-center gap-3 border-t border-portal-border-soft pt-3">
            <span className="inline-flex shrink-0 items-center gap-2.5 text-[11px] tracking-wider text-portal-text-muted">
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Eye className="h-3.5 w-3.5" aria-hidden /> {post.viewCount}
              </span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Heart className="h-3.5 w-3.5" aria-hidden /> {post.reactionCount}
              </span>
              <span className="inline-flex items-center gap-1 tabular-nums">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden /> {post.commentCount}
              </span>
            </span>
            <span className="ml-auto inline-flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate font-ui text-xs font-bold text-portal-text">
                {firstNameOrFallback(post.author?.full_name, post.author?.email)}
              </span>
              <Avatar
                src={post.author?.avatar_url}
                name={post.author?.full_name}
                email={post.author?.email}
                size="sm"
              />
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

/**
 * Returns just the first token of the contributor's name (e.g. "Insha" from
 * "Insha Kazi") so post cards stay scannable. Falls back to the email prefix,
 * and finally to the brand wordmark when nothing is set — the fallback string
 * was specced as `CG SIGNAL` so empty author slots still read on-brand.
 */
function firstNameOrFallback(fullName?: string | null, email?: string | null): string {
  const name = (fullName ?? "").trim();
  if (name) return name.split(/\s+/)[0] ?? name;
  const e = (email ?? "").trim();
  if (e) {
    const local = e.split("@")[0] ?? "";
    if (local) return local.split(/[._-]+/)[0] ?? local;
  }
  return "CG SIGNAL";
}

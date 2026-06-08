import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Clock, Eye } from "lucide-react";
import { publicEnv } from "@/lib/env";
import { getPostOgImageUrl } from "@/lib/seo/get-og-image-url";
import {
  getPublicPostBySlug,
  listPublicPosts,
  listComments,
  listReactionCounts,
  listMyReactions,
} from "@/lib/db/public";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelBody } from "@/components/portal/Panel";
import { PublicNav } from "@/components/layout/PublicNav";
import { PortalFooter } from "@/components/layout/PortalFooter";
import { CommentsSection } from "@/components/comments/CommentsSection";
import { ReactionsBar } from "@/components/reactions/ReactionsBar";
import { PostViewTracker } from "@/components/analytics/PostViewTracker";
import { PostAnalyticsTracker } from "@/components/analytics/PostAnalyticsTracker";
import { PostShareButton } from "@/components/posts/PostShareButton";
import { PostContributorsRow } from "@/components/posts/PostContributorsRow";
import { SubscribeSection } from "@/components/landing/SubscribeSection";
import { SubscribeMiniCta } from "@/components/landing/SubscribeMiniCta";
import { formatPostDate } from "@/lib/utils/dates";
import { roleLabel } from "@/lib/auth/roles";
import { sanitizeHtml } from "@/lib/editor/sanitize";
import { getSessionContext } from "@/lib/auth/guards";

export const dynamic = "force-dynamic";

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const post = await getPublicPostBySlug(params.slug);
  if (!post) return { title: "Not found" };

  // Build absolute URLs — WhatsApp / Slack / LinkedIn crawlers reject
  // relative paths in `og:image` / `og:url`. NEXT_PUBLIC_APP_URL must be set
  // to the canonical production host.
  const base = (publicEnv.appUrl || "").replace(/\/$/, "");
  const url = `${base}/posts/${post.slug}`;

  // OG image — centralised in `lib/seo/get-og-image-url.ts`. Posts with a
  // cover image route through the stable `/api/og-image/[slug]` proxy; the
  // proxy 302s to a fresh Supabase signed URL on each crawler hit. Posts
  // without a cover get `/og-default.png`. Crawlers cache image BYTES after
  // the redirect resolves so signed-URL TTL never matters past first share.
  const ogImage = getPostOgImageUrl(post);

  const description = post.excerpt ?? `New signal from ${post.author?.full_name ?? "team Dhurandhar"}`;
  const authorName = post.author?.full_name ?? post.author?.email ?? undefined;

  return {
    title: post.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: post.title,
      description,
      url,
      type: "article",
      siteName: "CG Signal",
      // Explicit 1200×630 dimensions — LinkedIn / Slack / Facebook use them
      // to choose the large-card layout. The proxy serves whatever aspect
      // the original cover has; the hint is metadata, not a transform.
      images: [{ url: ogImage, width: 1200, height: 630, alt: post.title }],
      publishedTime: post.published_at ?? undefined,
      authors: authorName ? [authorName] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description,
      images: [ogImage],
    },
  };
}

export default async function PublicPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const post = await getPublicPostBySlug(params.slug);
  if (!post) notFound();

  // Fetch the rest in parallel — none depend on each other.
  const session = await getSessionContext();
  const [related, comments, reactionCounts, myReactions] = await Promise.all([
    listPublicPosts(8).then((all) =>
      all.filter((p) => p.id !== post.id && p.author_id === post.author_id).slice(0, 3),
    ),
    listComments(post.id),
    listReactionCounts(post.id),
    session ? listMyReactions(post.id, session.userId) : Promise.resolve([]),
  ]);

  const safeHtml = sanitizeHtml(post.content_html);
  const isAdmin = session?.profile.role === "manager";

  // BlogPosting JSON-LD — drives Google rich snippets and knowledge-graph
  // integration. `JSON.stringify` is XSS-safe here because every interpolated
  // value comes from our own DB, never raw user input.
  const base = (publicEnv.appUrl || "").replace(/\/$/, "");
  const postUrl = `${base}/posts/${post.slug}`;
  const authorName = post.author?.full_name ?? post.author?.email ?? "ConveGenius Team";
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt ?? undefined,
    image: [getPostOgImageUrl(post)],
    datePublished: post.published_at ?? undefined,
    dateModified: post.updated_at ?? post.published_at ?? undefined,
    author: {
      "@type": "Person",
      name: authorName,
    },
    publisher: {
      "@type": "Organization",
      name: "ConveGenius",
      logo: { "@type": "ImageObject", url: `${base}/cg.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": postUrl },
  };
  // Contributors (authors + managers) don't need to be pitched the newsletter
  // — they are the people producing it. Hide the in-post subscribe surfaces
  // for them so the editorial flow stays clean.
  const isContributor =
    session?.profile.role === "author" || session?.profile.role === "manager";
  // Split long articles at a paragraph boundary so the mini CTA sits at a
  // natural editorial break rather than mid-sentence. Returns null when the
  // article is too short to warrant a mid-article nudge.
  const split = isContributor ? null : splitArticleForMidCta(safeHtml);

  return (
    <div className="flex min-h-screen flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <PublicNav />

      <main className="flex-1">
        <div className="container mx-auto max-w-3xl px-4 py-10">
          <Button asChild variant="ghost" size="sm" className="mb-6">
            <Link href="/">
              <ChevronLeft className="h-4 w-4" /> All posts
            </Link>
          </Button>

          <article>
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {post.tags.map((t) => (
                <Badge key={t.id} variant="secondary">{t.name}</Badge>
              ))}
            </div>

            <h1 className="font-hero text-4xl font-bold uppercase leading-[1] tracking-tighter text-portal-text sm:text-5xl lg:text-6xl">
              {post.title}
            </h1>
            {post.excerpt && (
              <p className="mt-5 text-lg leading-relaxed text-portal-text-muted">{post.excerpt}</p>
            )}

            <div className="mt-8 border-y border-portal-border-soft py-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  {post.contributors.length > 1 ? (
                    // Multi-author byline — owner + editor collaborators.
                    <PostContributorsRow contributors={post.contributors} />
                  ) : (
                    // Single author — original byline, unchanged.
                    <div className="flex items-center gap-4">
                      <Avatar
                        src={post.author?.avatar_url}
                        name={post.author?.full_name}
                        email={post.author?.email}
                        size="lg"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-ui text-sm font-bold text-portal-text">
                          {post.author?.full_name || post.author?.email}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                          {roleLabel(post.author?.role)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-4 sm:justify-end">
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                      {post.published_at ? formatPostDate(post.published_at) : ""}
                    </div>
                    <div className="mt-1 inline-flex items-center gap-2 text-[10px] uppercase tracking-wider text-portal-text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3 w-3" /> {post.viewCount} views
                      </span>
                      <span aria-hidden className="text-portal-text-soft">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {post.read_time_minutes} min read
                      </span>
                    </div>
                  </div>
                  {/* Desktop share — sits right of the meta block. Hidden on
                      mobile in favour of the full-width row below. */}
                  <div className="hidden sm:block">
                    <PostShareButton
                      postId={post.id}
                      title={post.title}
                      slug={post.slug}
                      authorName={post.author?.full_name ?? post.author?.email ?? null}
                    />
                  </div>
                </div>
              </div>
              {/* Mobile share — full-width row below the byline. */}
              <div className="mt-3 sm:hidden">
                <PostShareButton
                  postId={post.id}
                  title={post.title}
                  slug={post.slug}
                  authorName={post.author?.full_name ?? post.author?.email ?? null}
                />
              </div>
            </div>

            {split ? (
              <>
                <div
                  className="article-body mt-8"
                  dangerouslySetInnerHTML={{ __html: split.first }}
                />
                <SubscribeMiniCta postSlug={post.slug} />
                <div
                  className="article-body"
                  dangerouslySetInnerHTML={{ __html: split.second }}
                />
              </>
            ) : (
              <div
                className="article-body mt-8"
                dangerouslySetInnerHTML={{ __html: safeHtml }}
              />
            )}
          </article>

          {/* Tracks one Supabase row per session per post (30-min throttle)
              and a Vercel `post_view` event on every navigation. */}
          <PostViewTracker
            postId={post.id}
            slug={post.slug}
            title={post.title}
            author={post.author?.full_name ?? post.author?.email ?? null}
            isLoggedIn={!!session}
          />

          {/* Behavioural tracking — scroll depth, time spent, read completion.
              Fires its own events stream into analytics_events. Mounted only
              for non-contributor readers so the editorial team isn't part of
              their own engagement metrics. */}
          {!isContributor && (
            <PostAnalyticsTracker
              postId={post.id}
              slug={post.slug}
              isLoggedIn={!!session}
              estimatedReadMinutes={post.read_time_minutes ?? null}
            />
          )}

          {/* Subscribe — sits after the article body so readers see it at
              peak engagement, but before reactions/comments so it doesn't
              compete with the social proof + discussion below. Hidden for
              logged-in contributors who already drive the newsletter. */}
          {!isContributor && (
            <div className="mt-10 -mx-4 sm:mx-0">
              <SubscribeSection source="post" postSlug={post.slug} compact />
            </div>
          )}

          {/* Reactions */}
          <div className="mt-12 border-t border-portal-border-soft pt-8">
            <div className="mb-5 font-ui text-[11px] font-semibold uppercase tracking-[0.18em] text-portal-text-muted">
              Reactions
            </div>
            <ReactionsBar
              postId={post.id}
              postSlug={post.slug}
              counts={reactionCounts}
              myReactions={myReactions}
              isAuthenticated={!!session}
            />
          </div>

          {/* Comments */}
          <CommentsSection
            postId={post.id}
            postSlug={post.slug}
            postAuthorId={post.author_id}
            comments={comments}
            currentUserId={session?.userId ?? null}
            isManager={isAdmin}
          />

          {related.length > 0 && (
            <section className="mt-16">
              <div className="mb-3 text-[11px] uppercase tracking-wider text-portal-text-muted">
                More from {post.author?.full_name || post.author?.email}
              </div>
              <div className="post-grid-tight">
                {related.map((p) => (
                  <Panel key={p.id} variant="raised">
                    <PanelBody className="p-4">
                      <Link
                        href={`/posts/${p.slug}`}
                        className="block font-ui font-bold text-portal-text hover:text-portal-orange"
                      >
                        {p.title}
                      </Link>
                      <div className="mt-2 text-[10px] uppercase tracking-wider text-portal-text-muted">
                        {p.published_at ? formatPostDate(p.published_at) : ""} · {p.read_time_minutes} min
                      </div>
                    </PanelBody>
                  </Panel>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      <PortalFooter />
    </div>
  );
}

/**
 * Splits sanitized article HTML at the paragraph/heading boundary closest to
 * ~55% of the document so the mid-article subscribe nudge lands at a natural
 * editorial break. Returns `null` for short articles where a mid-article CTA
 * would compete with the bottom subscribe block rather than complement it.
 *
 * Heuristic instead of DOM parsing: keeps this on the server (no jsdom),
 * splits on closing tags so we never bisect an open element, and only fires
 * when there are enough breaks for the math to be meaningful (>=4).
 */
function splitArticleForMidCta(html: string): { first: string; second: string } | null {
  const wordCount = html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 400) return null;

  const breaks: number[] = [];
  const re = /<\/p>|<\/h[1-6]>|<\/blockquote>|<\/ul>|<\/ol>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) breaks.push(m.index + m[0].length);
  if (breaks.length < 4) return null;

  const target = Math.floor(html.length * 0.55);
  const splitAt = breaks.reduce(
    (best, b) => (Math.abs(b - target) < Math.abs(best - target) ? b : best),
    breaks[0]!,
  );
  return { first: html.slice(0, splitAt), second: html.slice(splitAt) };
}

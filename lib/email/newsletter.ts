import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";
import { sendEmail } from "@/lib/email/resend";
import { postNotificationTemplate } from "@/lib/email/templates";

interface NewsletterResult {
  ok: boolean;
  skipped?: "already_sent" | "not_published" | "no_subscribers" | "not_configured";
  attempted?: number;
  sent?: number;
  failed?: number;
  failures?: { email: string; error: string }[];
  /** Set when we detected Resend's sandbox-only delivery mode. */
  sandboxDetected?: boolean;
  /** Set when Resend returned a 429 / rate-limit error on any recipient. */
  rateLimitDetected?: boolean;
  error?: string;
}

/** True for any sandbox `from` address — Resend's onboarding domain + any
 *  `name <something@resend.dev>` formatted sender. */
export function isSandboxSender(from: string | undefined | null): boolean {
  if (!from) return false;
  return /@resend\.dev>?\s*$/i.test(from.trim());
}

type ResendErrorCategory = "sandbox" | "rate_limit" | "domain_unverified" | "other";

/** Classify a Resend API error string so callers can show actionable copy. */
function categoriseResendError(err: string | undefined | null): ResendErrorCategory {
  if (!err) return "other";
  const lower = err.toLowerCase();
  // The exact sandbox guard message Resend emits.
  if (lower.includes("you can only send testing emails to your own email")) return "sandbox";
  if (lower.includes("verify a domain")) return "domain_unverified";
  // Rate-limit shapes: HTTP 429, or text containing "rate limit"/"too many".
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return "rate_limit";
  }
  return "other";
}

/**
 * Extracts the first paragraph of plain text from a Tiptap-generated HTML
 * body. Strips tags, collapses whitespace, takes everything up to the first
 * empty line (a paragraph break in our renderer is `</p><p>`).
 *
 * Lossy by design — newsletter previews want the gist, not the formatting.
 */
function extractFirstParagraph(html: string, maxChars = 320): string | null {
  if (!html) return null;
  // Pull the first `<p>…</p>` block; ProseMirror wraps paragraphs that way.
  const match = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!match) return null;
  const raw = match[1] ?? "";
  const text = raw
    .replace(/<[^>]+>/g, "") // strip nested tags (strong, em, etc.)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Sends the per-post newsletter to every active subscriber, EXACTLY ONCE.
 *
 * Idempotency: we claim the dispatch by stamping `newsletter_sent_at` BEFORE
 * sending, using a conditional update. If another worker stamps it first, the
 * UPDATE affects 0 rows and we bail out — preventing duplicate emails when
 * Post Now and the publish-scheduled cron race on the same post.
 *
 * Delivery is per-recipient: one Resend call per subscriber so each gets a
 * unique `unsubscribe_token` in their email + List-Unsubscribe header. We
 * never short-circuit on a single failure — failures get logged and the loop
 * carries on so a bad address doesn't block deliveries to everyone else.
 *
 * IMPORTANT: Resend's free tier with `onboarding@resend.dev` as `from` only
 * delivers to the email that owns the Resend account. Mail to every other
 * subscriber gets returned as a 403 — that's why "only I receive the email"
 * happens when domain verification isn't done. See
 * docs/newsletter-delivery-debug.md for the fix.
 */
export async function sendPerPostNewsletter(postId: string): Promise<NewsletterResult> {
  const from = process.env.RESEND_FROM;
  if (!process.env.RESEND_API_KEY || !from) {
    // No-op when Resend isn't configured. The publish flow keeps working.
    console.warn(
      `[newsletter:${postId}] skipped — Resend not configured (set RESEND_API_KEY + RESEND_FROM).`,
    );
    return { ok: true, skipped: "not_configured" };
  }

  // Early, prominent warning when the `from` address is Resend's sandbox
  // sender. In that mode Resend will silently reject every recipient that
  // isn't the account owner, so the dispatch *looks* successful while only
  // one person actually gets the email. We still try to send (the owner
  // does want their copy) but log the warning so ops can see what's wrong.
  if (isSandboxSender(from)) {
    console.warn(
      `[newsletter:${postId}] Resend is using sandbox sender (${from}). Only the Resend account owner may receive emails. Verify a domain and set RESEND_FROM. See docs/resend-newsletter-delivery.md.`,
    );
  }

  const service = createSupabaseServiceClient();

  // Fetch the post + author + cover media path so the email can show a
  // thumbnail. Single query — Supabase resolves the FK joins.
  const { data: postRow } = await service
    .from("posts")
    .select(
      "id, title, slug, excerpt, content_html, status, published_at, read_time_minutes, newsletter_sent_at, cover_media_id, author:profiles!posts_author_id_fkey(full_name, email)",
    )
    .eq("id", postId)
    .maybeSingle();

  type AuthorJoin = { full_name: string | null; email: string };
  const post = postRow as
    | {
        id: string;
        title: string;
        slug: string;
        excerpt: string | null;
        content_html: string | null;
        status: string;
        published_at: string | null;
        read_time_minutes: number;
        newsletter_sent_at: string | null;
        cover_media_id: string | null;
        author: AuthorJoin | AuthorJoin[] | null;
      }
    | null;

  if (!post) return { ok: false, error: "Post not found." };
  if (post.status !== "published") return { ok: true, skipped: "not_published" };
  if (post.newsletter_sent_at) return { ok: true, skipped: "already_sent" };

  // CRITICAL: stamp newsletter_sent_at as a conditional update BEFORE we
  // send. If two callers race (Post Now + cron), only the first wins.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await service
    .from("posts")
    .update({ newsletter_sent_at: claimedAt })
    .eq("id", postId)
    .is("newsletter_sent_at", null)
    .select("id");
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed || claimed.length === 0) {
    return { ok: true, skipped: "already_sent" };
  }

  // Pull EVERY active subscriber. We deliberately fetch the full list rather
  // than streaming — at our scale (single/double digits today, low-100s on
  // the projected growth curve) the round-trip cost is negligible and a
  // single batch keeps logs simple.
  const { data: subs, error: subsErr } = await service
    .from("subscribers")
    .select("email, unsubscribe_token")
    .is("unsubscribed_at", null);
  if (subsErr) return { ok: false, error: subsErr.message };
  const subscribers = (subs ?? []) as { email: string; unsubscribe_token: string }[];
  console.log(`[newsletter:${postId}] starting · ${subscribers.length} subscribers`);
  if (subscribers.length === 0) return { ok: true, skipped: "no_subscribers" };

  // Cover URL — point at the public /api/og-image proxy. The proxy stays at
  // a stable URL forever; on each crawler / email-client fetch it 302s to a
  // fresh Supabase signed URL behind the scenes. Email clients cache the
  // image bytes after first load, so subsequent opens read from their cache
  // and never hit a stale TTL. When the post has no cover, the proxy itself
  // 302s to `/og-default.png` so we don't have to branch here.
  const coverUrl = post.cover_media_id
    ? `${publicEnv.appUrl}/api/og-image/${encodeURIComponent(post.slug)}`
    : `${publicEnv.appUrl}/og-default.png`;

  // Author display name. Supabase types FK joins as arrays even when singleton.
  const a = Array.isArray(post.author) ? post.author[0] : post.author;
  const authorHandle = a?.email?.split("@")[0] ?? "ConveGenius team";
  const authorName = a?.full_name?.trim() || authorHandle;

  const firstParagraph = extractFirstParagraph(post.content_html ?? "");

  let sent = 0;
  const failures: { email: string; error: string }[] = [];
  let sandboxDetected = false;
  let rateLimitDetected = false;

  for (const sub of subscribers) {
    const unsubscribeUrl = `${publicEnv.appUrl}/api/subscribe/unsubscribe?t=${sub.unsubscribe_token}`;
    const tpl = postNotificationTemplate({
      appUrl: publicEnv.appUrl,
      unsubscribeUrl,
      post: {
        title: post.title,
        slug: post.slug,
        excerpt: post.excerpt,
        firstParagraph,
        authorName,
        readTimeMinutes: post.read_time_minutes,
        coverUrl,
      },
    });
    // Per-recipient send. We DON'T short-circuit on failure — a bad
    // address shouldn't block delivery to everyone else.
    const res = await sendEmail({
      to: sub.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (res.ok) {
      sent++;
      console.log(`[newsletter:${postId}] sent · email=${sub.email}`);
    } else {
      const errMsg = res.error ?? "unknown";
      console.error(`[newsletter:${postId}] failed · email=${sub.email} · error=${errMsg}`);
      const category = categoriseResendError(errMsg);
      // Surface actionable hints alongside the raw error. Log once per
      // category — we don't need to spam the same hint for every failed
      // recipient when the cause is global (e.g. sandbox mode).
      if (category === "sandbox" && !sandboxDetected) {
        sandboxDetected = true;
        console.error(
          `[newsletter:${postId}] Resend test mode detected. Verify a domain and update RESEND_FROM. See docs/resend-newsletter-delivery.md.`,
        );
      } else if (category === "rate_limit" && !rateLimitDetected) {
        rateLimitDetected = true;
        console.error(
          `[newsletter:${postId}] Resend free-tier rate/usage limit reached (100/day, 3000/month).`,
        );
      } else if (category === "domain_unverified") {
        console.error(
          `[newsletter:${postId}] Resend domain not verified yet. Check the Domains tab in your Resend dashboard.`,
        );
      }
      failures.push({ email: sub.email, error: errMsg });
    }
  }

  console.log(
    `[newsletter:${postId}] done · attempted=${subscribers.length} sent=${sent} failed=${failures.length}`,
  );
  return {
    ok: true,
    attempted: subscribers.length,
    sent,
    failed: failures.length,
    failures: failures.length > 0 ? failures : undefined,
    sandboxDetected: sandboxDetected || undefined,
    rateLimitDetected: rateLimitDetected || undefined,
  };
}

// ============================================================
// Diagnostics — server-only helper that returns delivery-pipeline health.
// Used by /api/admin/newsletter-diagnostics so managers can verify Resend
// is set up correctly without grepping Vercel logs. Returns COUNTS ONLY —
// never subscriber emails.
// ============================================================

export interface NewsletterDiagnostics {
  resendConfigured: boolean;
  resendFromDomain: string | null;
  isSandboxSender: boolean;
  totalSubscribers: number;
  activeSubscribers: number;
  unsubscribedSubscribers: number;
  appUrl: string;
  publicAppUrlIsLocalhost: boolean;
}

export async function getNewsletterDiagnostics(): Promise<NewsletterDiagnostics> {
  const from = process.env.RESEND_FROM ?? null;
  // Pull just the email domain out of either "name@domain" or "Name <name@domain>".
  const domainMatch = from?.match(/@([A-Za-z0-9.\-]+)/);
  const resendFromDomain = domainMatch?.[1]?.toLowerCase() ?? null;

  const service = createSupabaseServiceClient();
  const [total, active, unsubscribed] = await Promise.all([
    service.from("subscribers").select("id", { count: "exact", head: true }),
    service
      .from("subscribers")
      .select("id", { count: "exact", head: true })
      .is("unsubscribed_at", null),
    service
      .from("subscribers")
      .select("id", { count: "exact", head: true })
      .not("unsubscribed_at", "is", null),
  ]);

  return {
    resendConfigured: Boolean(process.env.RESEND_API_KEY && from),
    resendFromDomain,
    isSandboxSender: isSandboxSender(from),
    totalSubscribers: total.count ?? 0,
    activeSubscribers: active.count ?? 0,
    unsubscribedSubscribers: unsubscribed.count ?? 0,
    appUrl: publicEnv.appUrl,
    publicAppUrlIsLocalhost: /^https?:\/\/localhost/i.test(publicEnv.appUrl),
  };
}

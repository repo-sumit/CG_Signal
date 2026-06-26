"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { track } from "@/lib/analytics/track";
import { cn } from "@/lib/utils/cn";

interface SubscribeResponse {
  ok?: boolean;
  status?: "subscribed" | "already_subscribed" | "reactivated";
  error?: string;
}

export interface NewsletterSubscribeSectionProps {
  /**
   * Where this instance is mounted. Drives analytics `placement` metadata
   * and selects the right copy/spacing variant. Defaults to `"landing"` so
   * existing call-sites keep working unchanged.
   */
  source?: "landing" | "post";
  /** Slug of the post the user is reading — only meaningful when `source="post"`. */
  postSlug?: string;
  /**
   * Tightens spacing, drops the gradient halo, and downsizes the heading so
   * the section sits comfortably inside a post page instead of dominating it.
   */
  compact?: boolean;
  /**
   * Hide the eyebrow + headline + body. Useful when a parent context already
   * provides a header for the form.
   */
  showHeading?: boolean;
  /**
   * DOM id applied to the wrapper. Lets external CTAs scroll/focus the
   * section without lifting state up.
   */
  id?: string;
}

const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Newsletter sign-up — posts to `/api/subscribe`, which records the email
 * in Supabase and fires a welcome email via Resend. Single opt-in.
 *
 * Used in two places:
 *  - Landing page hero subscribe block (`source="landing"`).
 *  - Bottom of each public post (`source="post"`, `compact` enabled).
 *
 * Both placements share the same backend, same validation, same success
 * state — the only thing that varies is copy + spacing.
 */
export function SubscribeSection({
  source = "landing",
  postSlug,
  compact = false,
  showHeading = true,
  id,
}: NewsletterSubscribeSectionProps = {}) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  // Sole placement for `post` source is the bottom subscribe section. The
  // mid-article CTA is a separate component that scrolls to this one rather
  // than rendering a second form.
  const placement: "landing" | "post_end" =
    source === "post" ? "post_end" : "landing";

  // Fire-once impression. Vercel Analytics dedups by event name + key payload
  // fields at the dashboard level — emitting once per mount is the right
  // granularity. Inputs are stable refs/strings so the effect only fires on
  // remount, not on every keystroke.
  useEffect(() => {
    track("subscribe_cta_view", { source, placement, postSlug });
  }, [source, placement, postSlug]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!VALID_EMAIL_RE.test(trimmed)) {
      toast.error("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    track("subscribe_submit", { source, placement, postSlug });
    track("subscribe_started", { source, placement, postSlug });
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source }),
      });
      const json = (await res.json().catch(() => ({}))) as SubscribeResponse;
      if (!res.ok || json.ok !== true) {
        const friendly =
          res.status === 400
            ? "Enter a valid email address."
            : json.error || "Subscription failed. Please try again.";
        throw new Error(friendly);
      }
      setDone(true);
      track("subscribe_success", { source, placement, postSlug });
      if (json.status === "already_subscribed") {
        toast.success("You are already subscribed.");
      } else {
        toast.success("Signal locked. You are subscribed.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Subscription failed. Please try again.";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Copy tweaked per placement — post readers already know what CG SIGNAL is
  // about, so we emphasise the "next signal" framing rather than re-pitching.
  const eyebrow = "ConveGenius Daily Signals";
  const heading = source === "post" ? "Receive the next signal" : "Receive the next signal";
  const body =
    source === "post"
      ? "Get future product, design, AI, engineering, and team signals directly in your inbox. Only published signals. No spam."
      : "Get new ConveGenius team posts in your inbox. No spam. Only published signals.";

  return (
    <section
      id={id ?? (source === "post" ? "newsletter-subscribe" : undefined)}
      className={cn(
        "feed-container w-full min-w-0",
        compact ? "py-8 sm:py-10" : "py-12 sm:py-16",
      )}
    >
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-md border bg-portal-panel-soft",
          compact
            ? "border-portal-border-soft p-5 sm:p-8"
            : "border-portal-border-muted bg-portal-panel-soft p-6 sm:p-10 lg:p-12",
        )}
      >
        <div
          className={cn(
            "relative grid gap-6",
            compact
              ? "lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-8"
              : "lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-10",
          )}
        >
          {showHeading ? (
            <div className="space-y-3">
              <div className="text-[11px] uppercase tracking-wider text-portal-orange">
                {eyebrow}
              </div>
              <h2
                className={cn(
                  "font-hero font-bold uppercase tracking-tighter text-portal-text",
                  compact
                    ? "text-2xl sm:text-3xl lg:text-4xl"
                    : "text-2xl sm:text-4xl lg:text-5xl",
                )}
              >
                {heading}
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-portal-text-muted">
                {body}
              </p>
            </div>
          ) : (
            <div />
          )}

          {done ? (
            <div className="rounded-md border border-portal-green/30 bg-portal-green/5 p-5 text-center sm:p-6">
              <CheckCircle2 className="mx-auto h-8 w-8 text-portal-green" />
              <div className="mt-3 font-hero text-lg font-bold uppercase tracking-tighter text-portal-text">
                You&apos;re subscribed
              </div>
              <p className="mt-2 text-sm text-portal-text-muted">
                A welcome email is on the way. Look for it from CG Signal.
              </p>
            </div>
          ) : (
            <form
              onSubmit={onSubmit}
              className="space-y-3 rounded-md border border-portal-border-soft bg-portal-main/60 p-4 backdrop-blur sm:p-5"
            >
              <label className="block" htmlFor={inputId}>
                <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-portal-text-muted">
                  Email
                </span>
                <input
                  id={inputId}
                  ref={inputRef}
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  autoComplete="email"
                  inputMode="email"
                  className="h-11 w-full rounded-pill border-2 border-portal-border-muted bg-portal-panel-soft px-4 font-ui text-sm text-portal-text placeholder:text-portal-text-soft focus-visible:border-portal-blue focus-visible:outline-none focus-visible:shadow-[0_0_0_4px_rgba(79,140,255,0.18)]"
                />
              </label>
              {/* Button: full-width on mobile so it never gets pushed off
                  the right edge; auto-width on sm+ for a tidier desktop row. */}
              <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                Subscribe
              </Button>
              <p className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                Unsubscribe anytime · No tracking pixels
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}

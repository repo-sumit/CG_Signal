"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Share2, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { publicEnv } from "@/lib/env";
import { cn } from "@/lib/utils/cn";
import { track } from "@/lib/analytics/track";
import { getClientContext, sendAnalyticsEvent } from "@/lib/analytics/client-context";

export interface PostShareButtonProps {
  title: string;
  slug: string;
  /** Stable post id — used for analytics correlation. Optional so legacy callers keep compiling. */
  postId?: string;
  /** Primary author display name. Falls back to the contributors list. */
  authorName?: string | null;
  /** Additional contributor names — joined when more than the primary author exists. */
  contributorNames?: string[];
  className?: string;
}

/**
 * Reusable share control for the public post detail page.
 *
 * Strategy:
 *   1. Use the Web Share API when the browser supports it AND
 *      `navigator.canShare` accepts the payload (mobile Safari / Chrome
 *      Android open the OS share sheet).
 *   2. Fall back to `navigator.clipboard.writeText` on desktop — copies the
 *      full share text (message + URL) so the user can paste anywhere.
 *   3. Final fallback: `document.execCommand("copy")` on a hidden textarea
 *      for very old / restricted browsers.
 *
 * The button never opens a modal — keeping the interaction synchronous with
 * the user gesture is what lets the Web Share API work at all (it requires
 * a transient user activation that React's event loop preserves).
 */
export function PostShareButton({
  title,
  slug,
  postId,
  authorName,
  contributorNames,
  className,
}: PostShareButtonProps) {
  const emitShare = useCallback(
    (channel: string) => {
      if (postId) {
        track("share_clicked", { postId, slug, channel });
        const ctx = getClientContext();
        sendAnalyticsEvent({
          eventName: "share_clicked",
          sessionId: ctx.sessionId,
          postId,
          path: ctx.path,
          metadata: { channel, slug },
        });
      }
    },
    [postId, slug],
  );
  const [copied, setCopied] = useState(false);

  const resolveUrl = useCallback(() => {
    // Prefer the configured public URL so shared links never include the
    // preview hostname. Fall back to the current document URL only when
    // the env is missing (dev / local-only deploys).
    const base = (publicEnv.appUrl || "").replace(/\/$/, "");
    if (base) return `${base}/posts/${slug}`;
    if (typeof window !== "undefined") return window.location.href;
    return `/posts/${slug}`;
  }, [slug]);

  const resolveAuthorLabel = useCallback(() => {
    const primary = authorName?.trim();
    const extras = (contributorNames ?? [])
      .map((n) => n?.trim())
      .filter((n): n is string => !!n && n !== primary);
    if (primary && extras.length > 0) return `${primary} and contributors`;
    if (primary) return primary;
    if (extras[0]) return extras[0];
    return "CG SIGNAL";
  }, [authorName, contributorNames]);

  const handleShare = useCallback(async () => {
    const url = resolveUrl();
    const author = resolveAuthorLabel();
    const text = `Check out this cool post by ${author} about ${title}`;
    const fullShareText = `${text}\n${url}`;

    // 1. Native share sheet (mobile + macOS Safari).
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      const payload = { title, text, url };
      // Some platforms (Safari especially) reject payloads with `url` set to
      // anything but the page's own origin. canShare() screens for that.
      const canShare =
        typeof navigator.canShare === "function" ? navigator.canShare(payload) : true;
      if (canShare) {
        try {
          await navigator.share(payload);
          emitShare("native");
          return;
        } catch (err) {
          // User cancelled — AbortError. Anything else (PermissionDenied,
          // NotAllowed) falls through to the clipboard path.
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
    }

    // 2. Clipboard copy (desktop primary path).
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(fullShareText);
        setCopied(true);
        toast.success("Share link copied.");
        window.setTimeout(() => setCopied(false), 2200);
        emitShare("copy");
        return;
      } catch {
        // Fall through to the execCommand fallback.
      }
    }

    // 3. Last-resort fallback: throw a hidden textarea, select, execCommand.
    //    Required for older Safari + restricted iframe contexts.
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = fullShareText;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        toast.success("Share link copied.");
        window.setTimeout(() => setCopied(false), 2200);
        emitShare("legacy-copy");
      } catch {
        toast.error("Could not copy the link. Long-press the URL to copy manually.");
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [emitShare, resolveAuthorLabel, resolveUrl, title]);

  const Icon = copied ? Check : Share2;
  const Aux = copied ? null : <Copy className="h-3 w-3 opacity-60 sm:hidden" aria-hidden />;
  const label = copied ? "Copied" : "Share";

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleShare}
      aria-label={copied ? "Share link copied" : `Share post: ${title}`}
      className={cn(
        // Full-width stacked on mobile (per spec), inline pill on sm+
        "w-full justify-center sm:w-auto",
        // Make the success state visually distinct without changing the
        // button shape — keeps surrounding layout stable.
        copied && "border-portal-green/40 text-portal-green hover:border-portal-green",
        className,
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      {Aux}
    </Button>
  );
}

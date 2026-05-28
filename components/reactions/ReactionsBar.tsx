"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ThumbsUp,
  Heart,
  Laugh,
  PartyPopper,
  Eye,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { REACTION_EMOJIS, REACTION_LABELS, type ReactionEmoji } from "@/lib/reactions";
import { toggleReaction } from "@/app/posts/[slug]/actions";
import { track } from "@/lib/analytics/track";
import { getClientContext, sendAnalyticsEvent } from "@/lib/analytics/client-context";
import { cn } from "@/lib/utils/cn";

interface Props {
  postId: string;
  postSlug: string;
  counts: Record<ReactionEmoji, number>;
  myReactions: ReactionEmoji[];
  isAuthenticated: boolean;
}

// Emoji keys are still the DB primary key — same strings stored in `reactions`
// table, same wire format to the toggleReaction action. We just map each one
// to a Lucide icon + accent colour for the UI. Adding/removing reactions
// stays a DB-only concern; mapping changes here have no migration cost.
interface ReactionConfig {
  Icon: LucideIcon;
  /** Display label used for the accessible name + optional tooltip. */
  label: string;
  /** Tailwind classes applied when the user has reacted. */
  activeClass: string;
  /** Tailwind classes applied on hover when NOT reacted (idle accent tint). */
  hoverClass: string;
}

const REACTION_CONFIG: Record<ReactionEmoji, ReactionConfig> = {
  "👍": {
    Icon: ThumbsUp,
    label: "Like",
    activeClass: "border-portal-blue/55 bg-portal-blue/12 text-portal-blue",
    hoverClass:
      "hover:border-portal-blue/40 hover:bg-portal-blue/5 hover:text-portal-blue",
  },
  "❤️": {
    Icon: Heart,
    label: "Love",
    activeClass: "border-portal-red/55 bg-portal-red/12 text-portal-red",
    hoverClass:
      "hover:border-portal-red/40 hover:bg-portal-red/5 hover:text-portal-red",
  },
  "😂": {
    Icon: Laugh,
    label: "Funny",
    activeClass: "border-portal-yellow/55 bg-portal-yellow/12 text-portal-yellow",
    hoverClass:
      "hover:border-portal-yellow/40 hover:bg-portal-yellow/5 hover:text-portal-yellow",
  },
  "🎉": {
    Icon: PartyPopper,
    label: "Celebrate",
    activeClass: "border-portal-orange/55 bg-portal-orange/12 text-portal-orange",
    hoverClass:
      "hover:border-portal-orange/40 hover:bg-portal-orange/5 hover:text-portal-orange",
  },
  "👀": {
    Icon: Eye,
    label: "Watching",
    activeClass: "border-portal-green/55 bg-portal-green/12 text-portal-green",
    hoverClass:
      "hover:border-portal-green/40 hover:bg-portal-green/5 hover:text-portal-green",
  },
  "🚀": {
    Icon: Rocket,
    label: "Launch",
    // Re-uses blue intentionally: there's no purple in the portal palette and
    // re-using a token reads cleaner than introducing an off-palette accent
    // just for one button. Icon shape makes the reaction unambiguous.
    activeClass: "border-portal-blue/55 bg-portal-blue/12 text-portal-blue",
    hoverClass:
      "hover:border-portal-blue/40 hover:bg-portal-blue/5 hover:text-portal-blue",
  },
};

export function ReactionsBar({ postId, postSlug, counts, myReactions, isAuthenticated }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Local optimistic state so the button reads as toggled the instant the
  // user clicks, without waiting for the server round-trip.
  const [local, setLocal] = useState<{ counts: Record<ReactionEmoji, number>; mine: Set<ReactionEmoji> }>({
    counts,
    mine: new Set(myReactions),
  });

  function click(emoji: ReactionEmoji) {
    if (!isAuthenticated) {
      // Bounce through /login with a return URL so the user lands back here.
      router.push(`/login?redirect=${encodeURIComponent(`/posts/${postSlug}`)}`);
      return;
    }
    const wasOn = local.mine.has(emoji);
    track("reaction_added", {
      postId,
      slug: postSlug,
      emoji,
      toggled: wasOn ? "off" : "on",
    });
    // Persist into analytics_events for the admin dashboard rollup.
    const ctx = getClientContext();
    sendAnalyticsEvent({
      eventName: wasOn ? "reaction_removed" : "reaction_added",
      sessionId: ctx.sessionId,
      postId,
      path: ctx.path,
      metadata: { emoji, slug: postSlug },
    });
    // Optimistic toggle
    setLocal((prev) => {
      const mine = new Set(prev.mine);
      const counts = { ...prev.counts };
      if (mine.has(emoji)) {
        mine.delete(emoji);
        counts[emoji] = Math.max(0, counts[emoji] - 1);
      } else {
        mine.add(emoji);
        counts[emoji] = counts[emoji] + 1;
      }
      return { counts, mine };
    });
    startTransition(async () => {
      const res = await toggleReaction({ postId, emoji });
      if (!res.ok) {
        // Roll back the optimistic update on failure.
        setLocal((prev) => {
          const mine = new Set(prev.mine);
          const counts = { ...prev.counts };
          if (mine.has(emoji)) {
            mine.delete(emoji);
            counts[emoji] = Math.max(0, counts[emoji] - 1);
          } else {
            mine.add(emoji);
            counts[emoji] = counts[emoji] + 1;
          }
          return { counts, mine };
        });
        toast.error(res.error ?? "Failed to react.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
      {REACTION_EMOJIS.map((e) => {
        const cfg = REACTION_CONFIG[e];
        const Icon = cfg.Icon;
        const reacted = local.mine.has(e);
        const count = local.counts[e] ?? 0;
        return (
          <button
            key={e}
            type="button"
            onClick={() => click(e)}
            disabled={pending}
            aria-pressed={reacted}
            aria-label={`${reacted ? "Remove" : "Add"} ${cfg.label} reaction — ${count} so far`}
            title={cfg.label}
            className={cn(
              // Base — larger, pillared, theme-aware. Mobile default (48px /
              // 20px icon) shrinks to desktop (44px / 18px icon) at the `sm`
              // breakpoint to hit Apple's 44pt minimum on small screens.
              "group inline-flex min-h-12 items-center gap-2 rounded-pill border px-4 py-2.5",
              "font-ui text-sm font-semibold tabular-nums",
              "transition-[color,background-color,border-color,transform] duration-150",
              "sm:min-h-11 sm:px-3.5 sm:py-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-portal-blue focus-visible:ring-offset-2 focus-visible:ring-offset-portal-main",
              "active:translate-y-px",
              reacted
                ? cfg.activeClass
                : cn(
                    "border-portal-border-soft bg-portal-panel-soft text-portal-text-muted",
                    cfg.hoverClass,
                  ),
              pending && "opacity-60 cursor-not-allowed",
            )}
          >
            <Icon
              aria-hidden
              strokeWidth={reacted ? 2.4 : 2}
              className="h-5 w-5 sm:h-[18px] sm:w-[18px]"
            />
            <span aria-hidden>{count}</span>
            {/* Screen-reader-only fallback that names the emoji, so users on
                assistive tech still get the same shorthand sighted users see.
                The aria-label on the button already conveys label + count;
                this just preserves the original emoji-key tagging. */}
            <span className="sr-only">{REACTION_LABELS[e]}</span>
          </button>
        );
      })}
      {!isAuthenticated && (
        <Link
          href={`/login?redirect=${encodeURIComponent(`/posts/${postSlug}`)}`}
          className="ml-1 font-ui text-[11px] uppercase tracking-wider text-portal-text-muted underline-offset-2 hover:text-portal-text hover:underline"
        >
          Sign in to react
        </Link>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics/track";
import { getClientContext, sendAnalyticsEvent } from "@/lib/analytics/client-context";

interface Props {
  postId: string;
  slug: string;
  isLoggedIn: boolean;
  /**
   * Estimated read time in minutes (from `posts.read_time_minutes`). Used to
   * decide when we treat the post as "read" — past 80% scroll OR time spent
   * exceeds 0.6 × estimated read time.
   */
  estimatedReadMinutes: number | null;
}

const MILESTONES: Array<{ depth: 25 | 50 | 75 | 100; key: string }> = [
  { depth: 25, key: "scroll_25" },
  { depth: 50, key: "scroll_50" },
  { depth: 75, key: "scroll_75" },
  { depth: 100, key: "scroll_100" },
];

// Periodic time-spent broadcast. 30s feels right — fast enough that even a
// reader who closes the tab early has at least one snapshot; slow enough
// that we don't hammer the API with stale-data updates.
const TIME_SPENT_INTERVAL_MS = 30 * 1000;

/**
 * Mounts under the post body and observes reader behaviour. Five jobs:
 *
 *   1. Fires `post_read_start` once on mount.
 *   2. Tracks scroll depth, emitting `scroll_25/50/75/100` once each.
 *   3. Accumulates visible-time (paused while the tab is hidden) and
 *      emits `time_spent_update` every 30 s.
 *   4. Emits `post_read_complete` once 80 % scroll is reached OR the
 *      visible time crosses 60 % of the estimated read time.
 *   5. Sends a final `sendBeacon` on `pagehide` with the final time +
 *      max scroll depth so the row in `post_views` can be patched.
 *
 * All emissions are best-effort. Failures never reach the user.
 */
export function PostAnalyticsTracker({ postId, slug, estimatedReadMinutes }: Props) {
  // Refs so visibility / scroll handlers see latest values without forcing
  // re-renders.
  const startedRef = useRef(false);
  const visibleAccumMsRef = useRef(0);
  const visibleSinceMsRef = useRef<number | null>(null);
  const maxScrollPctRef = useRef(0);
  const milestonesSentRef = useRef<Set<number>>(new Set());
  const readCompleteSentRef = useRef(false);
  const sessionIdRef = useRef<string>("");
  const completionThresholdMs = (() => {
    if (!estimatedReadMinutes || estimatedReadMinutes <= 0) return 90 * 1000; // sane default
    return Math.max(20 * 1000, Math.round(estimatedReadMinutes * 60 * 1000 * 0.6));
  })();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const ctx = getClientContext();
    sessionIdRef.current = ctx.sessionId;

    // ──────────────────────────────────────────────────────────────
    // Helper: current visible time spent in seconds.
    // ──────────────────────────────────────────────────────────────
    const currentSeconds = () => {
      let total = visibleAccumMsRef.current;
      if (visibleSinceMsRef.current !== null) {
        total += Date.now() - visibleSinceMsRef.current;
      }
      return Math.max(0, Math.round(total / 1000));
    };

    // ──────────────────────────────────────────────────────────────
    // Event emitter (Vercel + Supabase).
    // ──────────────────────────────────────────────────────────────
    const emit = (
      eventName: string,
      metadata: Record<string, unknown>,
      options?: { beacon?: boolean },
    ) => {
      sendAnalyticsEvent(
        {
          eventName,
          postId,
          path: ctx.path,
          sessionId: sessionIdRef.current,
          metadata,
        },
        options,
      );
    };

    // Fire the read-start event. Used by the funnel "started reading".
    emit("post_read_start", {});

    if (visibleSinceMsRef.current === null && !document.hidden) {
      visibleSinceMsRef.current = Date.now();
    }

    // ──────────────────────────────────────────────────────────────
    // Scroll listener — throttled via requestAnimationFrame.
    // ──────────────────────────────────────────────────────────────
    let scrollTicking = false;
    const onScroll = () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        scrollTicking = false;
        const scrollY = window.scrollY || window.pageYOffset || 0;
        const viewH = window.innerHeight || document.documentElement.clientHeight;
        const docH =
          Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight,
            document.documentElement.offsetHeight,
          ) - viewH;
        if (docH <= 0) return;
        const pct = Math.min(100, Math.max(0, Math.round((scrollY / docH) * 100)));
        if (pct > maxScrollPctRef.current) maxScrollPctRef.current = pct;

        for (const m of MILESTONES) {
          if (pct >= m.depth && !milestonesSentRef.current.has(m.depth)) {
            milestonesSentRef.current.add(m.depth);
            track("scroll_milestone", { postId, slug, depth: m.depth });
            emit(m.key, { depth: m.depth });
          }
        }

        // Read completion via scroll (80 %).
        if (!readCompleteSentRef.current && pct >= 80) {
          readCompleteSentRef.current = true;
          emit("post_read_complete", {
            reason: "scroll",
            scrollDepth: pct,
            timeSpentSeconds: currentSeconds(),
          });
        }
      });
    };

    // ──────────────────────────────────────────────────────────────
    // Visibility — pause the timer when the tab is backgrounded.
    // ──────────────────────────────────────────────────────────────
    const onVisibility = () => {
      if (document.hidden) {
        if (visibleSinceMsRef.current !== null) {
          visibleAccumMsRef.current += Date.now() - visibleSinceMsRef.current;
          visibleSinceMsRef.current = null;
        }
      } else if (visibleSinceMsRef.current === null) {
        visibleSinceMsRef.current = Date.now();
      }
    };

    // ──────────────────────────────────────────────────────────────
    // Periodic time-spent update.
    // ──────────────────────────────────────────────────────────────
    const intervalId = window.setInterval(() => {
      const seconds = currentSeconds();
      if (seconds <= 0) return;
      emit("time_spent_update", {
        seconds,
        scrollDepth: maxScrollPctRef.current,
      });

      // Read completion via dwell time.
      if (
        !readCompleteSentRef.current &&
        seconds * 1000 >= completionThresholdMs &&
        maxScrollPctRef.current >= 40 // require *some* scroll engagement
      ) {
        readCompleteSentRef.current = true;
        emit("post_read_complete", {
          reason: "time",
          scrollDepth: maxScrollPctRef.current,
          timeSpentSeconds: seconds,
        });
      }
    }, TIME_SPENT_INTERVAL_MS);

    // ──────────────────────────────────────────────────────────────
    // Final flush on pagehide — sendBeacon survives navigation.
    // ──────────────────────────────────────────────────────────────
    const onPageHide = () => {
      const seconds = currentSeconds();
      track("time_spent", { postId, slug, seconds });
      emit(
        "time_spent_update",
        {
          seconds,
          scrollDepth: maxScrollPctRef.current,
          final: true,
        },
        { beacon: true },
      );
      // Patch the post_views row with final time + scroll. The dedicated
      // endpoint accepts the same shape and does its own upsert.
      try {
        const blob = new Blob(
          [
            JSON.stringify({
              postId,
              slug,
              sessionId: sessionIdRef.current,
              timeSpentSeconds: seconds,
              scrollDepth: maxScrollPctRef.current,
              readComplete: readCompleteSentRef.current,
            }),
          ],
          { type: "application/json" },
        );
        if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
          navigator.sendBeacon("/api/analytics/post-view", blob);
        }
      } catch {
        /* swallow */
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    // Prime the first scroll position so very short posts that start at
    // 100 % scroll register a milestone immediately.
    onScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(intervalId);
    };
  }, [postId, slug, completionThresholdMs]);

  return null;
}

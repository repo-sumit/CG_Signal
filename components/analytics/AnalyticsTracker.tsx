"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { getClientContext, sendAnalyticsEvent } from "@/lib/analytics/client-context";

interface Props {
  isLoggedIn: boolean;
}

/**
 * Site-wide page-view tracker. Renders nothing. Mounted once at the (app)
 * layout root so every navigation (App Router transitions included) fires a
 * `page_view` event into `analytics_events`. The downstream
 * `analytics_sessions` upsert in /api/analytics/event keeps the visitor's
 * first/last-seen / device columns fresh.
 *
 * Public post pages also mount `PostViewTracker` + `PostAnalyticsTracker` —
 * those handle per-post Supabase dedupe, scroll depth, and time spent. The
 * page-view event from this component is fine to fire on every navigation:
 * sessions table dedupes on session_id and the dashboard groups by
 * (session, path) for "unique pageviews".
 */
export function AnalyticsTracker({ isLoggedIn }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ctx = getClientContext();
    sendAnalyticsEvent({
      eventName: "page_view",
      sessionId: ctx.sessionId,
      path: ctx.path,
      metadata: {
        isLoggedIn,
        referrer: ctx.referrer,
        viewportWidth: ctx.viewportWidth,
        viewportHeight: ctx.viewportHeight,
        timeZone: ctx.timeZone,
        language: ctx.language,
      },
    });
    // pathname + searchParams as deps so client-side navigation re-fires the
    // event without re-mounting the whole tracker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams?.toString(), isLoggedIn]);

  return null;
}

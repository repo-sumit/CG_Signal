import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { trafficSourceFor } from "@/lib/analytics/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ postId: z.string().uuid() });

/**
 * GET /api/admin/analytics/post/[postId]
 *
 * Manager-only. Returns a structured per-post analytics snapshot:
 *   - view aggregates (total / unique / logged-in / anonymous)
 *   - average time spent + scroll depth + read complete rate
 *   - per-traffic-source breakdown
 *   - per-device breakdown
 *   - last 50 reactions with user identity
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ postId: string }> }) {
  await requireManager();
  const raw = await props.params;
  const parsed = ParamsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid post id" }, { status: 400 });
  }
  const { postId } = parsed.data;
  const service = createSupabaseServiceClient();

  const [postRes, viewsRes, reactionsRes, commentsRes, eventsRes] = await Promise.all([
    service.from("posts").select("id, title, slug, author_id, published_at").eq("id", postId).maybeSingle(),
    service
      .from("post_views")
      .select(
        "viewer_id, session_id, time_spent_seconds, scroll_depth, read_complete, device_type, browser, os, country, referrer, created_at",
      )
      .eq("post_id", postId),
    service
      .from("reactions")
      .select("user_id, emoji, created_at")
      .eq("post_id", postId)
      .order("created_at", { ascending: false })
      .limit(50),
    service
      .from("comments")
      .select("id, user_id, body, created_at, author_name")
      .eq("post_id", postId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    service
      .from("analytics_events")
      .select("event_name, created_at")
      .eq("post_id", postId)
      .eq("event_name", "share_clicked"),
  ]);

  if (!postRes.data) {
    return NextResponse.json({ ok: false, error: "Post not found" }, { status: 404 });
  }

  type ViewRow = {
    viewer_id: string | null;
    session_id: string | null;
    time_spent_seconds: number | null;
    scroll_depth: number | null;
    read_complete: boolean | null;
    device_type: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
    referrer: string | null;
    created_at: string;
  };
  const views = (viewsRes.data ?? []) as ViewRow[];

  let timeSum = 0;
  let timeCount = 0;
  let scrollSum = 0;
  let scrollCount = 0;
  let completed = 0;
  let loggedIn = 0;
  const sessionIds = new Set<string>();
  const deviceTally = new Map<string, number>();
  const browserTally = new Map<string, number>();
  const sourceTally = new Map<string, number>();
  const countryTally = new Map<string, number>();

  for (const v of views) {
    if (v.session_id) sessionIds.add(v.session_id);
    if (v.viewer_id) loggedIn += 1;
    if (v.read_complete) completed += 1;
    if (typeof v.time_spent_seconds === "number") {
      timeSum += v.time_spent_seconds;
      timeCount += 1;
    }
    if (typeof v.scroll_depth === "number") {
      scrollSum += v.scroll_depth;
      scrollCount += 1;
    }
    deviceTally.set(v.device_type ?? "unknown", (deviceTally.get(v.device_type ?? "unknown") ?? 0) + 1);
    browserTally.set(v.browser ?? "Unknown", (browserTally.get(v.browser ?? "Unknown") ?? 0) + 1);
    const src = trafficSourceFor(v.referrer);
    sourceTally.set(src, (sourceTally.get(src) ?? 0) + 1);
    if (v.country) countryTally.set(v.country, (countryTally.get(v.country) ?? 0) + 1);
  }

  // Build identity-resolved reactions + comments.
  type Reaction = { user_id: string; emoji: string; created_at: string };
  const reactions = (reactionsRes.data ?? []) as Reaction[];
  type Comment = { id: string; user_id: string; body: string; created_at: string; author_name: string };
  const comments = (commentsRes.data ?? []) as Comment[];
  const userIds = Array.from(new Set([...reactions.map((r) => r.user_id), ...comments.map((c) => c.user_id)]));
  const profileRes = userIds.length
    ? await service.from("profiles").select("id, full_name, email, avatar_url, role").in("id", userIds)
    : { data: [] as Array<{ id: string; full_name: string | null; email: string; avatar_url: string | null; role: string }> };
  const profileById = new Map(
    ((profileRes.data ?? []) as Array<{ id: string; full_name: string | null; email: string; avatar_url: string | null; role: string }>).map((p) => [p.id, p]),
  );

  return NextResponse.json({
    ok: true,
    post: postRes.data,
    stats: {
      totalViews: views.length,
      uniqueViewers: sessionIds.size,
      loggedInViewers: loggedIn,
      anonymousViewers: views.length - loggedIn,
      averageTimeSpentSeconds: timeCount > 0 ? Math.round(timeSum / timeCount) : 0,
      averageScrollDepth: scrollCount > 0 ? Math.round(scrollSum / scrollCount) : 0,
      readCompleteRate: views.length > 0 ? Math.round((completed / views.length) * 100) : 0,
      shareClicks: (eventsRes.data ?? []).length,
    },
    breakdowns: {
      devices: Array.from(deviceTally.entries()).map(([device, count]) => ({ device, count })).sort((a, b) => b.count - a.count),
      browsers: Array.from(browserTally.entries()).map(([browser, count]) => ({ browser, count })).sort((a, b) => b.count - a.count),
      sources: Array.from(sourceTally.entries()).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
      countries: Array.from(countryTally.entries()).map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count),
    },
    reactions: reactions.map((r) => {
      const p = profileById.get(r.user_id);
      return {
        userId: r.user_id,
        userName: p?.full_name ?? p?.email ?? null,
        userEmail: p?.email ?? null,
        avatarUrl: p?.avatar_url ?? null,
        emoji: r.emoji,
        createdAt: r.created_at,
      };
    }),
    comments: comments.map((c) => {
      const p = profileById.get(c.user_id);
      return {
        id: c.id,
        userId: c.user_id,
        userName: p?.full_name ?? p?.email ?? c.author_name,
        userEmail: p?.email ?? "",
        avatarUrl: p?.avatar_url ?? null,
        body: c.body,
        createdAt: c.created_at,
      };
    }),
  });
}

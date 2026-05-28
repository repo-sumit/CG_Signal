import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  hashIp,
  extractIp,
  extractGeo,
  parseUserAgent,
  upsertAnalyticsSession,
} from "@/lib/analytics/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  postId: z.string().uuid().optional(),
  slug: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(80).optional(),
  referrer: z.string().max(2048).optional().nullable(),
  path: z.string().max(2048).optional().nullable(),
  viewportWidth: z.number().int().min(0).max(20000).optional().nullable(),
  viewportHeight: z.number().int().min(0).max(20000).optional().nullable(),
  timeZone: z.string().max(80).optional().nullable(),
  language: z.string().max(40).optional().nullable(),
  isLoggedIn: z.boolean().optional(),
  // Patch-style fields used by the post tracker's final beacon. Either set
  // creates a new row when none exists; sending them on an existing session/
  // post row updates time_spent_seconds / scroll_depth / read_complete.
  timeSpentSeconds: z.number().int().min(0).max(86400).optional().nullable(),
  scrollDepth: z.number().int().min(0).max(100).optional().nullable(),
  readComplete: z.boolean().optional(),
});

/**
 * POST /api/analytics/post-view
 *
 * Records a single post view. Authenticated callers get `viewer_id` stamped;
 * anonymous viewers contribute via `session_id` (client-supplied stable id).
 *
 * Server-side dedupe: if any view for (post_id, session_id) was recorded in
 * the last 30 minutes, we update that row (with the new time-spent / scroll
 * depth values) instead of inserting again. The client also gates on
 * localStorage so duplicate POSTs rarely reach us — this is the defense-in-
 * depth tier.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  const {
    postId,
    slug,
    sessionId,
    referrer,
    path,
    viewportWidth,
    viewportHeight,
    timeZone,
    language,
    isLoggedIn,
    timeSpentSeconds,
    scrollDepth,
    readComplete,
  } = parsed.data;
  if (!postId && !slug) {
    return NextResponse.json({ ok: false, error: "postId or slug required" }, { status: 400 });
  }

  // Resolve the post. Required visibility: published. Drafts / scheduled / archived
  // never count as a view.
  const service = createSupabaseServiceClient();
  const postQuery = service
    .from("posts")
    .select("id, status")
    .eq("status", "published")
    .limit(1);
  const { data: postRow, error: postErr } = postId
    ? await postQuery.eq("id", postId).maybeSingle()
    : await postQuery.eq("slug", slug!).maybeSingle();
  if (postErr) {
    return NextResponse.json({ ok: false, error: postErr.message }, { status: 500 });
  }
  const post = postRow as { id: string } | null;
  if (!post) {
    return NextResponse.json({ ok: false, error: "Post not found" }, { status: 404 });
  }

  // Identify the viewer if signed in.
  let viewerId: string | null = null;
  try {
    const authed = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authed.auth.getUser();
    viewerId = user?.id ?? null;
  } catch {
    viewerId = null;
  }

  const userAgent = request.headers.get("user-agent") ?? null;
  const ipRaw = extractIp(request);
  const ipHash = ipRaw ? hashIp(ipRaw) : null;
  const ua = parseUserAgent(userAgent);
  const geo = extractGeo(request);

  // Dedupe / patch: if we've already recorded a view in the last 30 minutes
  // for the same session on the same post, update that existing row with the
  // latest time-spent / scroll-depth / read-complete values rather than
  // inserting a fresh one.
  if (sessionId) {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: recent } = await service
      .from("post_views")
      .select("id, time_spent_seconds, scroll_depth, read_complete")
      .eq("post_id", post.id)
      .eq("session_id", sessionId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);
    const recentRow = recent?.[0] as
      | {
          id: string;
          time_spent_seconds: number | null;
          scroll_depth: number | null;
          read_complete: boolean | null;
        }
      | undefined;
    if (recentRow) {
      const patch: Record<string, unknown> = {};
      if (typeof timeSpentSeconds === "number") {
        const prev = recentRow.time_spent_seconds ?? 0;
        if (timeSpentSeconds > prev) patch.time_spent_seconds = timeSpentSeconds;
      }
      if (typeof scrollDepth === "number") {
        const prev = recentRow.scroll_depth ?? 0;
        if (scrollDepth > prev) patch.scroll_depth = scrollDepth;
      }
      if (readComplete && !recentRow.read_complete) patch.read_complete = true;
      if (Object.keys(patch).length > 0) {
        await service.from("post_views").update(patch).eq("id", recentRow.id);
      }
      // Best-effort session bookkeeping even on dedupe.
      await upsertAnalyticsSession({
        sessionId,
        userId: viewerId,
        referrer: referrer ?? null,
        landingPath: path ?? null,
        userAgent,
        ipHash,
        device: ua,
        country: geo.country,
        city: geo.city,
        isPageView: false,
      }).catch(() => undefined);
      return NextResponse.json({ ok: true, deduped: true, patched: Object.keys(patch).length > 0 });
    }
  }

  const { error: insErr } = await service.from("post_views").insert({
    post_id: post.id,
    viewer_id: viewerId,
    session_id: sessionId ?? null,
    user_agent: userAgent,
    referrer: referrer ?? null,
    ip_hash: ipHash,
    path: path ?? null,
    device_type: ua.device_type,
    browser: ua.browser,
    os: ua.os,
    country: geo.country,
    city: geo.city,
    viewport_width: viewportWidth ?? null,
    viewport_height: viewportHeight ?? null,
    time_zone: timeZone ?? null,
    language: language ?? null,
    is_logged_in: isLoggedIn ?? !!viewerId,
    time_spent_seconds: timeSpentSeconds ?? null,
    scroll_depth: scrollDepth ?? null,
    read_complete: readComplete ?? false,
  });
  if (insErr) {
    console.error("[post-view] insert failed", insErr.message);
    // Don't surface DB errors to the client — analytics must not block reads.
    return NextResponse.json({ ok: true, recorded: false });
  }

  if (sessionId) {
    await upsertAnalyticsSession({
      sessionId,
      userId: viewerId,
      referrer: referrer ?? null,
      landingPath: path ?? null,
      userAgent,
      ipHash,
      device: ua,
      country: geo.country,
      city: geo.city,
      isPageView: true,
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, recorded: true });
}

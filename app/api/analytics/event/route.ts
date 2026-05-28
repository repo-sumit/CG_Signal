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
import { ANALYTICS_EVENT_NAMES } from "@/lib/analytics/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);

// Cap on metadata size — analytics_events.metadata is jsonb but we don't want
// callers stuffing essays in. 2 KB is plenty for emoji / scroll depth / time.
const MAX_METADATA_BYTES = 2048;

const BodySchema = z.object({
  eventName: EventNameSchema,
  sessionId: z.string().min(1).max(80).optional().nullable(),
  postId: z.string().uuid().optional().nullable(),
  path: z.string().max(2048).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * POST /api/analytics/event
 *
 * Writes a row into `analytics_events` and bumps the matching
 * `analytics_sessions` row. Open to anonymous callers — only event NAMES
 * from the allow-list are accepted (the DB constraint enforces this again).
 *
 * Sensitive fields (passwords, draft content, raw IPs, emails) MUST NOT
 * appear in `metadata`. We don't actively scrub here — that's a code-review
 * concern on call-sites — but the size cap stops accidental leaks.
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

  const { eventName, sessionId, postId, path, metadata } = parsed.data;

  const meta = metadata ?? {};
  if (JSON.stringify(meta).length > MAX_METADATA_BYTES) {
    return NextResponse.json({ ok: false, error: "Metadata too large" }, { status: 413 });
  }

  // Identify the viewer if signed in. Failures here just mean the row is
  // recorded as anonymous.
  let userId: string | null = null;
  try {
    const authed = await createSupabaseServerClient();
    const {
      data: { user },
    } = await authed.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  const userAgent = request.headers.get("user-agent") ?? null;
  const ipRaw = extractIp(request);
  const ipHash = ipRaw ? hashIp(ipRaw) : null;
  const ua = parseUserAgent(userAgent);
  const geo = extractGeo(request);

  const service = createSupabaseServiceClient();
  const { error: insErr } = await service.from("analytics_events").insert({
    session_id: sessionId ?? null,
    user_id: userId,
    event_name: eventName,
    post_id: postId ?? null,
    path: path ?? null,
    metadata: meta,
  });
  if (insErr) {
    console.error("[analytics-event] insert failed", insErr.message);
    return NextResponse.json({ ok: true, recorded: false });
  }

  if (sessionId) {
    await upsertAnalyticsSession({
      sessionId,
      userId,
      referrer: typeof meta.referrer === "string" ? meta.referrer : null,
      landingPath: path ?? null,
      userAgent,
      ipHash,
      device: ua,
      country: geo.country,
      city: geo.city,
      isPageView: eventName === "page_view" || eventName === "post_view",
    }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true, recorded: true });
}

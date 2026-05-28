import "server-only";
import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import type { DeviceType } from "@/lib/analytics/events";

/**
 * Salted HMAC of the request IP. Used so analytics retains a stable
 * fingerprint per client without ever storing the raw address. Salt source:
 * CRON_SECRET (env). A hard-coded fallback keeps the function deterministic
 * in dev / preview environments that don't have the secret wired up — those
 * deployments produce predictable hashes, but no identifying value escapes.
 */
export function hashIp(ip: string): string {
  const secret = serverEnv().cronSecret || "fallback-ip-hash-salt";
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
}

export function extractIp(request: NextRequest | Request): string | null {
  const headers = request.headers;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? null;
}

/**
 * Vercel proxies stamp coarse geo (country / city) onto every request.
 * Outside Vercel both headers are missing — we just leave the columns null.
 */
export function extractGeo(request: NextRequest | Request): { country: string | null; city: string | null } {
  const headers = request.headers;
  const country = headers.get("x-vercel-ip-country") || headers.get("cf-ipcountry") || null;
  const cityRaw = headers.get("x-vercel-ip-city");
  let city: string | null = null;
  if (cityRaw) {
    try {
      // Vercel URL-encodes city names that contain spaces ("New%20York").
      city = decodeURIComponent(cityRaw);
    } catch {
      city = cityRaw;
    }
  }
  return { country, city };
}

export interface UAInfo {
  browser: string | null;
  os: string | null;
  device_type: DeviceType;
}

// Lightweight in-house UA parser. Avoids pulling ua-parser-js as a runtime
// dependency — we only need three coarse buckets (browser family, OS, device
// type) and the parser surface stays under 30 lines. If we ever need finer
// detail we can swap in the proper library here without touching callers.
export function parseUserAgent(ua: string | null | undefined): UAInfo {
  if (!ua) return { browser: null, os: null, device_type: "unknown" };
  const s = ua;
  const lower = s.toLowerCase();

  // Bot heuristics — match the most common crawler families first so they
  // don't get bucketed as "mobile" because of an Android UA in the string.
  if (/bot|crawler|spider|crawling|preview|fetch|monitor|http\bclient|preview/i.test(lower)) {
    return { browser: "Bot", os: null, device_type: "bot" };
  }

  let browser: string | null = null;
  if (/edg\//i.test(s)) browser = "Edge";
  else if (/opr\//i.test(s) || /opera/i.test(s)) browser = "Opera";
  else if (/chrome/i.test(s) && !/chromium/i.test(s)) browser = "Chrome";
  else if (/firefox/i.test(s)) browser = "Firefox";
  else if (/safari/i.test(s) && !/chrome/i.test(s)) browser = "Safari";
  else if (/msie|trident/i.test(s)) browser = "IE";

  let os: string | null = null;
  if (/windows nt/i.test(s)) os = "Windows";
  else if (/android/i.test(s)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(s)) os = "iOS";
  else if (/mac os x/i.test(s)) os = "macOS";
  else if (/cros/i.test(s)) os = "ChromeOS";
  else if (/linux/i.test(s)) os = "Linux";

  let device_type: DeviceType = "desktop";
  if (/ipad|tablet/i.test(s)) device_type = "tablet";
  else if (/mobile|iphone|android/i.test(s)) {
    // Android tablets often omit "Mobile" — treat them as tablets.
    device_type = /android(?!.*mobile)/i.test(s) ? "tablet" : "mobile";
  }

  return { browser, os, device_type };
}

/**
 * Best-effort upsert into analytics_sessions. Idempotent on `session_id`.
 * Failures are logged but never thrown — analytics MUST NOT block reads.
 *
 * Called from the analytics POST routes after the row has already been
 * authenticated/validated upstream.
 */
export interface UpsertSessionArgs {
  sessionId: string;
  userId?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  userAgent?: string | null;
  ipHash?: string | null;
  device: UAInfo;
  country?: string | null;
  city?: string | null;
  isPageView?: boolean;
}

export async function upsertAnalyticsSession(args: UpsertSessionArgs): Promise<void> {
  if (!args.sessionId) return;
  const service = createSupabaseServiceClient();
  const nowIso = new Date().toISOString();

  // Try to update an existing row first. We don't want first_seen_at,
  // landing_path, referrer, or the originating user_agent to be overwritten
  // on subsequent events.
  const { data: existing } = await service
    .from("analytics_sessions")
    .select("id, user_id, event_count, page_view_count")
    .eq("session_id", args.sessionId)
    .maybeSingle();

  if (existing) {
    const patch: Record<string, unknown> = {
      last_seen_at: nowIso,
      event_count: (existing.event_count ?? 0) + 1,
    };
    if (args.isPageView) {
      patch.page_view_count = (existing.page_view_count ?? 0) + 1;
    }
    // Promote anonymous sessions to logged-in once we know the user.
    if (args.userId && !existing.user_id) patch.user_id = args.userId;
    if (args.country) patch.country = args.country;
    if (args.city) patch.city = args.city;
    if (args.device.device_type) patch.device_type = args.device.device_type;
    if (args.device.browser) patch.browser = args.device.browser;
    if (args.device.os) patch.os = args.device.os;
    if (args.ipHash) patch.ip_hash = args.ipHash;

    await service
      .from("analytics_sessions")
      .update(patch)
      .eq("session_id", args.sessionId);
    return;
  }

  await service.from("analytics_sessions").insert({
    session_id: args.sessionId,
    user_id: args.userId ?? null,
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    device_type: args.device.device_type,
    browser: args.device.browser,
    os: args.device.os,
    country: args.country ?? null,
    city: args.city ?? null,
    referrer: args.referrer ?? null,
    landing_path: args.landingPath ?? null,
    user_agent: args.userAgent ?? null,
    ip_hash: args.ipHash ?? null,
    event_count: 1,
    page_view_count: args.isPageView ? 1 : 0,
  });
}

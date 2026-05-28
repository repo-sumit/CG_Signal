// Canonical analytics event names + payload contracts shared by the client
// tracker, the /api/analytics/event route, and the analytics_events DB CHECK
// constraint. Keep this list in lock-step with migration 0012.

export const ANALYTICS_EVENT_NAMES = [
  "page_view",
  "post_view",
  "post_read_start",
  "post_read_complete",
  "scroll_25",
  "scroll_50",
  "scroll_75",
  "scroll_100",
  "time_spent_update",
  "reaction_added",
  "reaction_removed",
  "comment_added",
  "comment_deleted",
  "share_clicked",
  "subscribe_submit",
  "subscribe_success",
  "login_started",
  "login_success",
  "post_published",
  "post_scheduled",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "bot", "unknown"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Traffic-source bucket derived from a `referrer` string. Keep the bucket
 * list short — admins want "WhatsApp vs LinkedIn" granularity, not the long
 * tail of obscure embeds.
 */
export type TrafficSource =
  | "whatsapp"
  | "linkedin"
  | "twitter"
  | "facebook"
  | "instagram"
  | "google"
  | "email"
  | "direct"
  | "other";

const SOURCE_HOST_PATTERNS: Array<{ source: TrafficSource; pattern: RegExp }> = [
  { source: "whatsapp", pattern: /(?:^|\.)whatsapp\.com$|^wa\.me$|^chat\.whatsapp\.com$/i },
  { source: "linkedin", pattern: /(?:^|\.)linkedin\.com$|^lnkd\.in$/i },
  { source: "twitter", pattern: /(?:^|\.)twitter\.com$|^t\.co$|(?:^|\.)x\.com$/i },
  { source: "facebook", pattern: /(?:^|\.)facebook\.com$|^fb\.com$|^fb\.me$|^l\.facebook\.com$/i },
  { source: "instagram", pattern: /(?:^|\.)instagram\.com$/i },
  { source: "google", pattern: /(?:^|\.)google\.[a-z.]+$|^news\.google\.com$/i },
  { source: "email", pattern: /^mail\.|@/i },
];

/**
 * Bucket a referrer URL into one of the canonical traffic sources. Designed
 * to be lenient — invalid URLs fall back to "direct", unknown hosts fall back
 * to "other".
 */
export function trafficSourceFor(referrer: string | null | undefined): TrafficSource {
  if (!referrer) return "direct";
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (!host) return "direct";
  for (const { source, pattern } of SOURCE_HOST_PATTERNS) {
    if (pattern.test(host)) return source;
  }
  return "other";
}

"use client";

// Browser-side helpers for collecting analytics context. Kept tiny + tree-
// shakable so the public bundle doesn't carry an analytics SDK. Strict rule:
// nothing here touches sensitive surfaces (passwords, draft content,
// clipboard, keystrokes). Only the public, deterministic browser hints.

const SESSION_KEY = "cg_signal_session";

/** Persists a stable per-browser session id so the server can dedupe POSTs. */
export function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
    window.localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Private mode / disabled storage — fall back to a per-tab session id.
    return Math.random().toString(36).slice(2);
  }
}

export interface ClientAnalyticsContext {
  sessionId: string;
  path: string;
  referrer: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  timeZone: string | null;
  language: string | null;
  userAgent: string | null;
}

/**
 * Snapshot of the public, non-sensitive client hints we attach to every
 * analytics event. SSR-safe — returns an empty stub when called on the
 * server, callers should only invoke from `useEffect` / event handlers.
 */
export function getClientContext(): ClientAnalyticsContext {
  if (typeof window === "undefined") {
    return {
      sessionId: "",
      path: "",
      referrer: null,
      viewportWidth: null,
      viewportHeight: null,
      timeZone: null,
      language: null,
      userAgent: null,
    };
  }
  let timeZone: string | null = null;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timeZone = null;
  }
  return {
    sessionId: getOrCreateSessionId(),
    path: window.location.pathname + window.location.search,
    referrer: document.referrer || null,
    viewportWidth: window.innerWidth || null,
    viewportHeight: window.innerHeight || null,
    timeZone,
    language: typeof navigator !== "undefined" ? navigator.language ?? null : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent ?? null : null,
  };
}

/**
 * Send an analytics event POST. Uses sendBeacon on pagehide-style calls so
 * the payload survives navigation; falls back to keepalive fetch when
 * sendBeacon is unavailable. Failures are intentionally swallowed.
 */
export function sendAnalyticsEvent(
  body: Record<string, unknown>,
  options: { beacon?: boolean } = {},
): void {
  if (typeof window === "undefined") return;
  const url = "/api/analytics/event";
  const payload = JSON.stringify(body);
  try {
    if (options.beacon && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      const blob = new Blob([payload], { type: "application/json" });
      const ok = navigator.sendBeacon(url, blob);
      if (ok) return;
    }
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* swallow — analytics must never break the page */
    });
  } catch {
    /* swallow */
  }
}

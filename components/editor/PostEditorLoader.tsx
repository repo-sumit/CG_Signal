"use client";

import dynamic from "next/dynamic";

/**
 * Lazy-loaded entry point for the Tiptap-backed editor. Splitting it out
 * keeps the editor bundle (Tiptap + extensions + custom toolbar) off the
 * critical path of any non-editor route, and lets the /editor pages render
 * an instant skeleton before the editor chunk finishes downloading.
 *
 * `ssr: false` because:
 *   1. The editor depends on `document` + `window` for selection / IME
 *      handling — SSR would crash.
 *   2. It's behind auth, so we don't lose SEO by rendering client-only.
 */
export const PostEditor = dynamic(
  () => import("./PostEditor").then((m) => m.PostEditor),
  {
    ssr: false,
    loading: () => (
      <div className="content-container py-12">
        <div className="h-8 w-48 animate-pulse rounded bg-portal-panel-soft" />
        <div className="mt-6 h-[480px] animate-pulse rounded-md bg-portal-panel-soft" />
        <p className="mt-3 font-ui text-[10px] uppercase tracking-wider text-portal-text-muted">
          Loading editor…
        </p>
      </div>
    ),
  },
);

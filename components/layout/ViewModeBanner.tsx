"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { setViewMode } from "@/app/(app)/actions/viewMode";

/**
 * Persistent yellow strip at the very top whenever View Mode is active.
 * Renders only when its parent decides — keep this component lean so its
 * client-side weight is tiny.
 */
export function ViewModeBanner() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function exit() {
    startTransition(async () => {
      await setViewMode(false);
      router.refresh();
    });
  }

  return (
    <div
      role="status"
      className="border-b border-portal-yellow/30 bg-portal-yellow/10 text-portal-yellow"
    >
      <div className="content-container flex flex-wrap items-center justify-between gap-3 py-2 text-[11px] uppercase tracking-wider">
        <span className="inline-flex items-center gap-2">
          <Eye className="h-3.5 w-3.5" />
          <strong className="font-bold">View mode active</strong>
          <span className="hidden text-portal-yellow/80 sm:inline">— browsing as standard member</span>
        </span>
        <button
          type="button"
          onClick={exit}
          disabled={pending}
          className="rounded-md border border-portal-yellow/40 px-2.5 py-1 hover:bg-portal-yellow/15 disabled:opacity-60"
        >
          Exit view mode
        </button>
      </div>
    </div>
  );
}

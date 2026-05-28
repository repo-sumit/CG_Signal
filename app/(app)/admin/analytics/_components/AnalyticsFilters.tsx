import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import { WINDOW_PRESETS, type WindowPresetId } from "@/lib/analytics/admin";

export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "posts", label: "Posts" },
  { id: "users", label: "Users" },
  { id: "reactions", label: "Reactions" },
  { id: "comments", label: "Comments" },
  { id: "traffic", label: "Traffic Sources" },
  { id: "devices", label: "Devices" },
  { id: "subscribers", label: "Subscribers" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

interface Props {
  currentTab: TabId;
  currentWindow: WindowPresetId;
}

function buildHref(tab: TabId, window: WindowPresetId): string {
  return `/admin/analytics?tab=${tab}&window=${window}`;
}

/**
 * Renders the tab strip + window-preset filter at the top of the admin
 * analytics dashboard. Server component — each control is a plain anchor
 * that re-loads the page with new query params.
 */
export function AnalyticsFilters({ currentTab, currentWindow }: Props) {
  return (
    <div className="space-y-4">
      <nav aria-label="Analytics sections" className="-mx-1 overflow-x-auto">
        <ul className="flex min-w-max items-center gap-1 px-1">
          {TABS.map((t) => {
            const active = t.id === currentTab;
            return (
              <li key={t.id}>
                <Link
                  href={buildHref(t.id, currentWindow)}
                  className={cn(
                    "inline-flex items-center rounded-pill border px-3 py-1.5 font-ui text-[11px] uppercase tracking-label transition-colors",
                    active
                      ? "border-portal-orange bg-portal-orange/10 text-portal-orange"
                      : "border-portal-border-soft bg-portal-panel-soft text-portal-text-muted hover:border-portal-border-muted hover:text-portal-text",
                  )}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-portal-text-muted">Window</span>
        {WINDOW_PRESETS.map((p) => {
          const active = p.id === currentWindow;
          return (
            <Link
              key={p.id}
              href={buildHref(currentTab, p.id)}
              className={cn(
                "inline-flex items-center rounded-pill border px-2.5 py-1 font-ui text-[10px] uppercase tracking-wider",
                active
                  ? "border-portal-blue/55 bg-portal-blue/10 text-portal-blue"
                  : "border-portal-border-soft bg-portal-panel-soft text-portal-text-muted hover:border-portal-border-muted hover:text-portal-text",
              )}
            >
              {p.label}
            </Link>
          );
        })}
        <Badge variant="muted" className="ml-2">No raw IPs · hashed only</Badge>
      </div>
    </div>
  );
}

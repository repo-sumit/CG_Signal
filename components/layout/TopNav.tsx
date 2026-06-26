"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, ShieldCheck, LogOut } from "lucide-react";
import type { ProfileRow, AppRole } from "@/lib/db/types";
import { canCreatePost, isManager, roleLabel } from "@/lib/auth/roles";
import { cn } from "@/lib/utils/cn";
import { Avatar } from "@/components/ui/Avatar";
import { BrandLockup } from "@/components/portal/BrandLockup";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  show: (role: AppRole) => boolean;
}

// Top-nav is intentionally lean: the Signal Feed (/) and Transmit (/editor/new)
// links were removed because the dashboard already surfaces "Open Signal Feed"
// and "New Transmission" actions — the routes still exist, just not here.
const NAV: NavItem[] = [
  { href: "/dashboard",  label: "Dashboard",   icon: LayoutDashboard, show: () => true },
  { href: "/me/posts",   label: "My Posts",    icon: FileText,        show: (r) => canCreatePost(r) },
  { href: "/admin",      label: "Admin",       icon: ShieldCheck,     show: (r) => isManager(r) },
];

interface Props {
  profile: ProfileRow;
  /** Effective role (demoted to "viewer" when view mode is active). */
  effectiveRole: AppRole;
  viewModeActive: boolean;
}

export function TopNav({ profile, effectiveRole, viewModeActive }: Props) {
  const pathname = usePathname();
  const visibleNav = NAV.filter((i) => i.show(effectiveRole));

  return (
    <header className="sticky top-0 z-40 border-b border-portal-border-soft bg-portal-main/90 backdrop-blur-md">
      <div className="content-container flex h-16 items-center gap-6">
        <BrandLockup size="sm" href="/dashboard" withSubtitle={false} />

        <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Primary">
          {visibleNav.map((item) => {
            // "/" must match exactly — otherwise it would match every route.
            const active =
              item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-ui text-xs uppercase tracking-wider transition-colors",
                  active
                    ? "bg-portal-panel-raised text-portal-text"
                    : "text-portal-text-muted hover:bg-portal-panel-soft hover:text-portal-text",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle compact className="md:hidden" />
          <ThemeToggle className="hidden md:inline-flex" />
          <div className="hidden flex-col items-end leading-tight sm:flex">
            <span className="font-ui text-xs text-portal-text">{profile.full_name || profile.email}</span>
            <span className="font-ui text-[10px] uppercase tracking-wider text-portal-text-muted">
              {viewModeActive ? "Viewer (preview)" : roleLabel(profile.role)}
            </span>
          </div>
          <Avatar src={profile.avatar_url} name={profile.full_name} email={profile.email} size="sm" />
          <form action="/api/auth/signout" method="post">
            <button
              type="submit"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-portal-text-muted hover:bg-portal-panel-soft hover:text-portal-text"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
      </div>

      {/* Mobile nav strip */}
      <nav className="content-container flex items-center gap-1 overflow-x-auto pb-3 md:hidden" aria-label="Primary mobile">
        {visibleNav.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "shrink-0 rounded-md px-3 py-1 font-ui text-[10px] uppercase tracking-wider",
                active
                  ? "bg-portal-panel-raised text-portal-text"
                  : "text-portal-text-muted",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

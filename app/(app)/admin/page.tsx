import type { Metadata } from "next";
import Link from "next/link";
import { Calendar, Users, Tag, BarChart3, Mail, ClipboardCheck } from "lucide-react";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Panel, PanelBody } from "@/components/portal/Panel";
import { weekStartISO } from "@/lib/utils/dates";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminHomePage() {
  await requireManager();
  const supabase = await createSupabaseServerClient();
  const wk = weekStartISO();

  const [{ count: teamCount }, { count: publishedCount }, { count: draftsCount }, { count: underReviewCount }] = await Promise.all([
    supabase.from("profiles").select("id", { count: "exact", head: true }).in("role", ["author", "manager"]),
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("status", "published").eq("week_start_date", wk),
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("status", "draft"),
    supabase.from("posts").select("id", { count: "exact", head: true }).eq("review_status", "under_review"),
  ]);

  const reviewCount = underReviewCount ?? 0;
  const sections = [
    { href: "/admin/review",      icon: ClipboardCheck, title: "Review Queue", desc: "Approve, reject, or request changes on submitted signals.", badge: reviewCount },
    { href: "/admin/schedule",    icon: Calendar,  title: "Schedule",    desc: "Assign weekdays to each team member." },
    { href: "/admin/users",       icon: Users,     title: "Users",       desc: "Manage the role allowlist." },
    { href: "/admin/tags",        icon: Tag,       title: "Tags",        desc: "Curate tags used across posts." },
    { href: "/admin/analytics",   icon: BarChart3, title: "Analytics",   desc: "Completion and content metrics." },
    { href: "/admin/subscribers", icon: Mail,      title: "Subscribers", desc: "Newsletter signups and unsubscribes." },
  ];

  return (
    <div className="container mx-auto space-y-6 px-4 py-10">
      <header className="space-y-2">
        <h1 className="font-hero text-4xl font-bold uppercase tracking-tighter text-portal-text sm:text-5xl">
          Admin
        </h1>
        <p className="text-sm text-portal-text-muted">Manage the team blog newsletter.</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Team size" value={teamCount ?? 0} />
        <StatTile label="Published this week" value={publishedCount ?? 0} tone="green" />
        <StatTile label="Awaiting review" value={reviewCount} tone="orange" />
        <StatTile label="All drafts" value={draftsCount ?? 0} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <Link
              key={s.href}
              href={s.href}
              className="group rounded-md border border-portal-border-soft bg-portal-panel p-6 transition-colors hover:border-portal-border-muted"
            >
              <div className="flex items-center justify-between">
                <Icon className="h-5 w-5 text-portal-text-muted group-hover:text-portal-orange" />
                {"badge" in s && typeof s.badge === "number" && s.badge > 0 && (
                  <span className="inline-flex min-w-[1.5rem] items-center justify-center rounded-pill border border-portal-orange/40 bg-portal-orange/10 px-2 py-0.5 font-ui text-[11px] font-bold text-portal-orange">
                    {s.badge}
                  </span>
                )}
              </div>
              <h2 className="mt-3 font-hero text-lg font-bold uppercase tracking-tighter text-portal-text group-hover:text-portal-orange">
                {s.title}
              </h2>
              <p className="mt-1.5 text-sm text-portal-text-muted">{s.desc}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "orange" | "green" }) {
  const color = tone === "orange" ? "text-portal-orange" : tone === "green" ? "text-portal-green" : "text-portal-text";
  return (
    <Panel>
      <PanelBody className="p-5">
        <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">{label}</div>
        <div className={`mt-2 font-hero text-3xl font-bold tracking-tighter ${color}`}>{value}</div>
      </PanelBody>
    </Panel>
  );
}

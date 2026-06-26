import type { Metadata } from "next";
import Link from "next/link";
import { PenSquare, ListTodo, CheckCircle2 } from "lucide-react";
import { requireWriter } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listTeam } from "@/lib/db/profiles";
import { listPostsThisWeek, listOwnPosts } from "@/lib/db/posts";
import { weekStartISO } from "@/lib/utils/dates";
import { canCreatePost, isManager } from "@/lib/auth/roles";
import { effectiveRole } from "@/lib/auth/viewMode";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelBody, PanelHeader } from "@/components/portal/Panel";
import { SystemLabel } from "@/components/portal/SystemLabel";
import { WeeklyScheduleCard } from "@/components/dashboard/WeeklyScheduleCard";
import { PostCard } from "@/components/blog/PostCard";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Dashboard is editor-only — Gmail commenters get bounced to /unauthorized.
  const { profile, userId } = await requireWriter();
  const supabase = await createSupabaseServerClient();
  const wk = weekStartISO();
  // When View Mode is active, every UI gate evaluates as a plain viewer.
  const role = await effectiveRole(profile.role);

  type SubmittedRow = {
    id: string;
    title: string;
    slug: string;
    updated_at: string;
    author: { full_name: string | null; email: string } | null;
  };

  const [team, postsThisWeek, ownPosts] = await Promise.all([
    listTeam(),
    listPostsThisWeek(wk),
    canCreatePost(role) ? listOwnPosts(userId) : Promise.resolve([]),
  ]);

  let submittedRows: SubmittedRow[] = [];
  if (isManager(role)) {
    const { data } = await supabase
      .from("posts")
      .select("id,title,slug,updated_at,author:profiles!posts_author_id_fkey(full_name,email)")
      .eq("status", "submitted")
      .order("updated_at", { ascending: false })
      .limit(10);
    submittedRows = (data ?? []) as unknown as SubmittedRow[];
  }

  const postsByAuthor: Record<string, number> = {};
  for (const p of postsThisWeek) postsByAuthor[p.author_id] = (postsByAuthor[p.author_id] ?? 0) + 1;
  const completion =
    team.length > 0 ? Math.round((Object.keys(postsByAuthor).length / team.length) * 100) : 0;

  // Latest in-progress draft for the "Your activity" panel. We still scope to
  // this week so a months-old abandoned draft doesn't dominate the dashboard;
  // authors who haven't started anything this week see the empty-state CTA.
  const myDraftThisWeek = ownPosts.find(
    (p) => p.week_start_date === wk && (p.status === "draft" || p.status === "submitted"),
  );
  const firstName = profile.full_name?.split(" ")[0] || profile.email.split("@")[0];

  return (
    <div className="container mx-auto space-y-8 px-4 py-10">
      {/* Hero block — minimal, no decorative pattern */}
      <section className="space-y-4">
        <SystemLabel tone="orange">Welcome back</SystemLabel>
        <h1 className="font-hero text-4xl font-bold uppercase tracking-tighter text-portal-text sm:text-5xl">
          {firstName}.
          <span className="text-portal-text-muted"> Signal received.</span>
        </h1>
        <p className="max-w-xl text-sm text-portal-text-muted">
          What the team is broadcasting today. Post whenever your signal is ready — every post
          becomes part of the team archive.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {canCreatePost(role) && (
            <Button asChild>
              <Link href="/editor/new">
                <PenSquare className="h-4 w-4" />
                New Transmission
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/">Open Signal Feed</Link>
          </Button>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {canCreatePost(role) && (
            <Panel>
              <PanelHeader>
                <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                  Your activity
                </div>
              </PanelHeader>
              <PanelBody className="grid gap-3 sm:grid-cols-3">
                <StatBox
                  label="Latest signal"
                  value={myDraftThisWeek ? "Draft in progress" : "Ready to post"}
                  href={myDraftThisWeek ? `/editor/${myDraftThisWeek.id}` : "/editor/new"}
                />
                <StatBox
                  label="Published this week"
                  value={String(postsByAuthor[userId] ?? 0)}
                />
                <StatBox
                  label="Status"
                  badge={
                    (postsByAuthor[userId] ?? 0) > 0
                      ? <Badge variant="success"><CheckCircle2 className="h-3 w-3" /> Active</Badge>
                      : <Badge variant="muted">Idle</Badge>
                  }
                />
              </PanelBody>
            </Panel>
          )}

          {isManager(role) && (
            <Panel>
              <PanelHeader>
                <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                  Awaiting your review
                </div>
                <Badge variant="muted">
                  <ListTodo className="h-3 w-3" /> {submittedRows.length}
                </Badge>
              </PanelHeader>
              <PanelBody>
                {submittedRows.length === 0 ? (
                  <p className="text-sm text-portal-text-muted">No submissions waiting.</p>
                ) : (
                  <ul className="space-y-2">
                    {submittedRows.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-portal-border-soft bg-portal-panel-soft p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/editor/${p.id}`}
                            className="block truncate font-ui font-bold text-portal-text hover:text-portal-orange"
                          >
                            {p.title || "Untitled"}
                          </Link>
                          <div className="mt-0.5 text-[11px] text-portal-text-muted">
                            {p.author?.full_name || p.author?.email}
                          </div>
                        </div>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/editor/${p.id}`}>Review</Link>
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelBody>
            </Panel>
          )}

          <Panel>
            <PanelHeader>
              <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                Latest signals
              </div>
              <SystemLabel tone="green" dot>Live</SystemLabel>
            </PanelHeader>
            <PanelBody>
              {postsThisWeek.length === 0 ? (
                <div className="rounded-md border border-dashed border-portal-border-soft p-10 text-center">
                  <p className="text-sm text-portal-text-muted">No signals broadcast yet.</p>
                  {canCreatePost(role) && (
                    <Button asChild className="mt-4">
                      <Link href="/editor/new">Be the first signal</Link>
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {postsThisWeek.map((p) => (
                    <PostCard key={p.id} post={p} />
                  ))}
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>

        <aside className="space-y-6">
          <WeeklyScheduleCard
            team={team}
            postsByAuthorThisWeek={postsByAuthor}
            canManageSchedule={isManager(role)}
          />

          {isManager(role) && (
            <Panel>
              <PanelHeader>
                <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                  Completion
                </div>
              </PanelHeader>
              <PanelBody className="space-y-3">
                <div className="font-hero text-4xl font-bold tracking-tighter text-portal-text">
                  {completion}%
                </div>
                <div className="text-[11px] uppercase tracking-wider text-portal-text-muted">
                  {Object.keys(postsByAuthor).length} of {team.length} posted
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-pill bg-portal-panel-soft">
                  <div
                    className="h-full bg-portal-orange transition-[width] duration-700"
                    style={{ width: `${completion}%` }}
                  />
                </div>
                <Link
                  href="/admin/analytics"
                  className="inline-block text-[11px] uppercase tracking-wider text-portal-blue hover:underline"
                >
                  View analytics →
                </Link>
              </PanelBody>
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  badge,
  href,
}: {
  label: string;
  value?: React.ReactNode;
  badge?: React.ReactNode;
  href?: string;
}) {
  const inner = (
    <>
      <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">{label}</div>
      <div className="mt-2">
        {badge ? badge : <div className="font-ui text-sm font-bold text-portal-text">{value}</div>}
      </div>
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="block rounded-md border border-portal-border-soft bg-portal-panel-soft p-3 transition-colors hover:border-portal-border-muted hover:bg-portal-panel-raised"
      >
        {inner}
      </Link>
    );
  }
  return <div className="rounded-md border border-portal-border-soft bg-portal-panel-soft p-3">{inner}</div>;
}

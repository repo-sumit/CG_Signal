import type { Metadata } from "next";
import Link from "next/link";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listTeam } from "@/lib/db/profiles";
import { weekdayLabel, formatWeekRange } from "@/lib/utils/dates";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import {
  resolveWindow,
  loadOverview,
  loadPostBreakdowns,
  loadUserActivity,
  loadReactionDetails,
  loadCommentDetails,
  loadTrafficSources,
  loadDeviceMix,
  type WindowPresetId,
} from "@/lib/analytics/admin";
import { AnalyticsFilters, TABS, type TabId } from "./_components/AnalyticsFilters";
import { StatCard, formatDuration } from "./_components/StatCard";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

interface SearchParams {
  tab?: string;
  window?: string;
  postId?: string;
}

const ALLOWED_TABS: TabId[] = TABS.map((t) => t.id);
const ALLOWED_WINDOWS: WindowPresetId[] = ["24h", "7d", "30d", "all"];

function parseTab(raw: string | undefined): TabId {
  return (ALLOWED_TABS as string[]).includes(raw ?? "") ? (raw as TabId) : "overview";
}
function parseWindow(raw: string | undefined): WindowPresetId {
  return (ALLOWED_WINDOWS as string[]).includes(raw ?? "") ? (raw as WindowPresetId) : "30d";
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default async function AnalyticsPage(props: { searchParams: Promise<SearchParams> }) {
  await requireManager();
  const searchParams = await props.searchParams;
  const tab = parseTab(searchParams.tab);
  const windowId = parseWindow(searchParams.window);
  const window = resolveWindow(windowId);
  const selectedPostId = typeof searchParams.postId === "string" ? searchParams.postId : null;

  return (
    <main className="content-container space-y-6 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          {window.label} · {formatWeekRange()}
        </p>
      </header>

      <AnalyticsFilters currentTab={tab} currentWindow={windowId} />

      {tab === "overview" && <OverviewTab window={window} />}
      {tab === "posts" && <PostsTab window={window} selectedPostId={selectedPostId} />}
      {tab === "users" && <UsersTab window={window} />}
      {tab === "reactions" && <ReactionsTab window={window} postId={selectedPostId} />}
      {tab === "comments" && <CommentsTab window={window} postId={selectedPostId} />}
      {tab === "traffic" && <TrafficTab window={window} />}
      {tab === "devices" && <DevicesTab window={window} />}
      {tab === "subscribers" && <SubscribersTab />}
    </main>
  );
}

// ============================================================
// Overview
// ============================================================

async function OverviewTab({ window }: { window: ReturnType<typeof resolveWindow> }) {
  const [overview, team, completionInfo] = await Promise.all([
    loadOverview(window),
    listTeam(),
    loadWeeklyCompletion(),
  ]);

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total views" value={overview.totalViews} hint={`${overview.uniqueVisitors} unique visitors`} />
        <StatCard label="Sessions" value={overview.totalSessions} hint={`${overview.loggedInVisitors} logged-in · ${overview.anonymousVisitors} anonymous`} />
        <StatCard label="Avg time spent" value={formatDuration(overview.averageTimeSpentSeconds)} hint="Visible-time only" />
        <StatCard label="Avg scroll depth" value={`${overview.averageScrollDepth}%`} hint={`${overview.readCompleteRate}% finished reading`} />
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Active subscribers" value={overview.totalSubscribers} />
        <StatCard label="Weekly completion" value={`${completionInfo.completion}%`} hint={`${completionInfo.posted} of ${team.length} team posted`} />
        <StatCard label="Top device" value={overview.deviceMix[0]?.device ?? "—"} hint={overview.deviceMix[0] ? `${overview.deviceMix[0].count} views` : undefined} />
        <StatCard label="Top source" value={overview.topReferrers[0]?.source ?? "—"} hint={overview.topReferrers[0] ? `${overview.topReferrers[0].count} views` : undefined} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top 5 posts</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.topPosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No view data yet.</p>
            ) : (
              <ol className="space-y-2">
                {overview.topPosts.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-3 text-sm">
                    <span className="w-6 font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                    <Link href={`/admin/analytics?tab=posts&postId=${p.id}`} className="flex-1 truncate font-medium hover:text-portal-orange">
                      {p.title}
                    </Link>
                    <Badge variant="muted">{p.views} views</Badge>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top referrers</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.topReferrers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No referrer data yet.</p>
            ) : (
              <ul className="space-y-2">
                {overview.topReferrers.slice(0, 6).map((r) => (
                  <li key={r.source} className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize">{r.source}</span>
                    <Badge variant="muted">{r.count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By author (this week)</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {team.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-3">
                <Avatar src={m.avatar_url} name={m.full_name} email={m.email} />
                <div className="flex-1">
                  <div className="font-medium">{m.full_name || m.email}</div>
                  <div className="text-xs text-muted-foreground capitalize">
                    {m.role} · {m.weekly_post_day ? weekdayLabel(m.weekly_post_day) : "no day"}
                  </div>
                </div>
                {completionInfo.postedSet.has(m.id) ? (
                  <Badge variant="success">Posted</Badge>
                ) : (
                  <Badge variant="destructive">Missed</Badge>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

async function loadWeeklyCompletion(): Promise<{ completion: number; posted: number; postedSet: Set<string> }> {
  const service = createSupabaseServiceClient();
  // Reuse the existing weekStart helper indirectly — query directly to avoid an extra dependency on the previous shape.
  const { data: teamData } = await service.from("profiles").select("id").in("role", ["author", "manager"]);
  const totalTeam = (teamData ?? []).length;
  const { data: weekly } = await service
    .from("posts")
    .select("author_id, week_start_date, status")
    .eq("status", "published");
  const postedSet = new Set<string>();
  const monday = new Date();
  const day = monday.getDay();
  const diff = (day + 6) % 7;
  monday.setDate(monday.getDate() - diff);
  const isoMonday = monday.toISOString().slice(0, 10);
  for (const p of (weekly ?? []) as Array<{ author_id: string; week_start_date: string | null }>) {
    if (p.week_start_date === isoMonday) postedSet.add(p.author_id);
  }
  const completion = totalTeam > 0 ? Math.round((postedSet.size / totalTeam) * 100) : 0;
  return { completion, posted: postedSet.size, postedSet };
}

// ============================================================
// Posts
// ============================================================

async function PostsTab({ window, selectedPostId }: { window: ReturnType<typeof resolveWindow>; selectedPostId: string | null }) {
  const rows = await loadPostBreakdowns(window);
  const selected = selectedPostId ? rows.find((r) => r.id === selectedPostId) : null;

  return (
    <div className="space-y-4">
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>{selected.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Views" value={selected.views} hint={`${selected.uniqueViewers} unique`} />
              <StatCard label="Logged-in" value={selected.loggedInViewers} hint={`${selected.anonymousViewers} anonymous`} />
              <StatCard label="Avg time" value={formatDuration(selected.averageTimeSpentSeconds)} hint={`${selected.averageScrollDepth}% avg scroll`} />
              <StatCard label="Read complete" value={`${selected.readCompleteRate}%`} hint={`${selected.shares} shares · ${selected.reactions} reactions`} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-[11px] uppercase tracking-wider">
              <Link className="underline-offset-2 hover:underline" href={`/admin/analytics?tab=reactions&window=${ALLOWED_WINDOWS_LABEL_FOR(window)}&postId=${selected.id}`}>View reactions →</Link>
              <Link className="underline-offset-2 hover:underline" href={`/admin/analytics?tab=comments&window=${ALLOWED_WINDOWS_LABEL_FOR(window)}&postId=${selected.id}`}>View comments →</Link>
              <Link className="underline-offset-2 hover:underline" href={`/posts/${selected.slug}`} target="_blank" rel="noreferrer">Open post ↗</Link>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Engagement by post</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No published posts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-2 py-2 font-medium">Post</th>
                    <th className="px-2 py-2 text-right font-medium">Views</th>
                    <th className="px-2 py-2 text-right font-medium">Unique</th>
                    <th className="px-2 py-2 text-right font-medium">Time</th>
                    <th className="px-2 py-2 text-right font-medium">Scroll</th>
                    <th className="px-2 py-2 text-right font-medium">Read</th>
                    <th className="px-2 py-2 text-right font-medium">Reactions</th>
                    <th className="px-2 py-2 text-right font-medium">Comments</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td className="px-2 py-2">
                        <Link href={`/admin/analytics?tab=posts&postId=${p.id}`} className="truncate font-medium hover:text-portal-orange">
                          {p.title}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.views}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.uniqueViewers}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatDuration(p.averageTimeSpentSeconds)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.averageScrollDepth}%</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.readCompleteRate}%</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.reactions}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{p.comments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Small helper so we can keep the existing window slug when linking between tabs.
function ALLOWED_WINDOWS_LABEL_FOR(window: ReturnType<typeof resolveWindow>): WindowPresetId {
  // Window label → preset id reverse lookup. We use the label here because the
  // resolveWindow result doesn't expose the originating id; cheap to scan.
  if (window.label.startsWith("Today")) return "24h";
  if (window.label.includes("7")) return "7d";
  if (window.label.includes("30")) return "30d";
  return "all";
}

// ============================================================
// Users
// ============================================================

async function UsersTab({ window }: { window: ReturnType<typeof resolveWindow> }) {
  const rows = await loadUserActivity(window);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Logged-in user activity</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tracked activity yet. Sessions stamped with a user id will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-2 font-medium">User</th>
                  <th className="px-2 py-2 text-right font-medium">Sessions</th>
                  <th className="px-2 py-2 text-right font-medium">Posts read</th>
                  <th className="px-2 py-2 text-right font-medium">Reactions</th>
                  <th className="px-2 py-2 text-right font-medium">Comments</th>
                  <th className="px-2 py-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((u) => (
                  <tr key={u.userId}>
                    <td className="px-2 py-2">
                      <Link href={`/admin/analytics/users/${u.userId}`} className="flex items-center gap-2">
                        <Avatar src={u.avatarUrl} name={u.fullName} email={u.email} size="sm" />
                        <span className="font-medium hover:text-portal-orange">{u.fullName ?? u.email}</span>
                        <Badge variant="muted" className="capitalize">{u.role}</Badge>
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{u.sessions}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{u.postsRead}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{u.reactions}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{u.comments}</td>
                    <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">{formatDateTime(u.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Reactions
// ============================================================

async function ReactionsTab({ window, postId }: { window: ReturnType<typeof resolveWindow>; postId: string | null }) {
  const details = await loadReactionDetails(window, postId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent reactions {postId ? "for this post" : ""}</CardTitle>
      </CardHeader>
      <CardContent>
        {details.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reactions in this window.</p>
        ) : (
          <ul className="divide-y">
            {details.slice(0, 200).map((r, i) => (
              <li key={`${r.createdAt}-${i}`} className="flex items-center gap-3 py-2 text-sm">
                <span className="text-lg" aria-hidden>{r.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.userName}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{r.userEmail}</div>
                </div>
                <Link href={`/posts/${r.postSlug}`} className="hidden truncate text-xs text-portal-text-muted hover:text-portal-orange sm:block sm:max-w-[200px]">
                  {r.postTitle}
                </Link>
                <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Comments
// ============================================================

async function CommentsTab({ window, postId }: { window: ReturnType<typeof resolveWindow>; postId: string | null }) {
  const details = await loadCommentDetails(window, postId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent comments {postId ? "for this post" : ""}</CardTitle>
      </CardHeader>
      <CardContent>
        {details.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments in this window.</p>
        ) : (
          <ul className="divide-y">
            {details.map((c) => (
              <li key={c.id} className="py-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{c.userName}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{c.userEmail}</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm leading-snug text-portal-text">{c.body}</p>
                <Link href={`/posts/${c.postSlug}`} className="mt-1 inline-block text-[11px] uppercase tracking-wider text-portal-text-muted hover:text-portal-orange">
                  on “{c.postTitle}” ↗
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Traffic Sources
// ============================================================

async function TrafficTab({ window }: { window: ReturnType<typeof resolveWindow> }) {
  const sources = await loadTrafficSources(window);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Traffic sources</CardTitle>
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">No referrer data in this window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 text-right font-medium">Views</th>
                  <th className="px-2 py-2 text-right font-medium">Unique sessions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sources.map((s) => (
                  <tr key={s.source}>
                    <td className="px-2 py-2 capitalize">{s.source}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{s.views}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{s.uniqueSessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Devices
// ============================================================

async function DevicesTab({ window }: { window: ReturnType<typeof resolveWindow> }) {
  const data = await loadDeviceMix(window);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {[
        { title: "Device type", rows: data.byDeviceType },
        { title: "Browser", rows: data.byBrowser },
        { title: "Operating system", rows: data.byOs },
      ].map((section) => (
        <Card key={section.title}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
          </CardHeader>
          <CardContent>
            {section.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {section.rows.map((r) => (
                  <li key={r.bucket} className="flex items-center justify-between">
                    <span className="capitalize">{r.bucket}</span>
                    <Badge variant="muted">{r.count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============================================================
// Subscribers
// ============================================================

async function SubscribersTab() {
  const service = createSupabaseServiceClient();
  const [activeRes, totalRes, recentRes] = await Promise.all([
    service.from("subscribers").select("id", { count: "exact", head: true }).is("unsubscribed_at", null),
    service.from("subscribers").select("id", { count: "exact", head: true }),
    service.from("subscribers").select("id, email, source, created_at, unsubscribed_at").order("created_at", { ascending: false }).limit(10),
  ]);
  type Sub = { id: string; email: string; source: string | null; created_at: string; unsubscribed_at: string | null };
  const recent = (recentRes.data ?? []) as Sub[];

  return (
    <div className="space-y-4">
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active subscribers" value={activeRes.count ?? 0} />
        <StatCard label="Total subscriptions" value={totalRes.count ?? 0} />
        <StatCard label="Unsubscribed" value={(totalRes.count ?? 0) - (activeRes.count ?? 0)} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent subscribers</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscribers yet.</p>
          ) : (
            <ul className="divide-y">
              {recent.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="flex-1 truncate font-medium">{s.email}</span>
                  <Badge variant="muted">{s.source ?? "unknown"}</Badge>
                  {s.unsubscribed_at ? <Badge variant="destructive">unsubscribed</Badge> : <Badge variant="success">active</Badge>}
                  <span className="ml-2 text-xs tabular-nums text-muted-foreground">{formatDateTime(s.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Link href="/admin/subscribers" className="text-[11px] uppercase tracking-wider text-portal-text-muted underline-offset-2 hover:underline">
              Manage all subscribers →
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Eye, MessageSquare, ThumbsUp } from "lucide-react";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { resolveWindow, loadReadingHistory, type WindowPresetId } from "@/lib/analytics/admin";
import { StatCard, formatDuration } from "../../_components/StatCard";

export const metadata: Metadata = { title: "User activity" };
export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS: WindowPresetId[] = ["24h", "7d", "30d", "all"];

interface SearchParams {
  window?: string;
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

interface PageProps {
  params: Promise<{ userId: string }>;
  searchParams: Promise<SearchParams>;
}

export default async function UserAnalyticsPage(props: PageProps) {
  await requireManager();
  const { userId } = await props.params;
  const searchParams = await props.searchParams;
  const windowId = parseWindow(searchParams.window);
  const window = resolveWindow(windowId);

  const service = createSupabaseServiceClient();
  const [profileRes, sessionsRes, viewsRes, reactionsRes, commentsRes] = await Promise.all([
    service.from("profiles").select("id, full_name, email, avatar_url, role").eq("id", userId).maybeSingle(),
    service
      .from("analytics_sessions")
      .select("session_id, last_seen_at, first_seen_at, device_type, browser, os, country")
      .eq("user_id", userId)
      .order("last_seen_at", { ascending: false })
      .limit(20),
    service
      .from("post_views")
      .select("id, time_spent_seconds, scroll_depth, read_complete")
      .eq("viewer_id", userId),
    service.from("reactions").select("id", { count: "exact", head: true }).eq("user_id", userId),
    service.from("comments").select("id", { count: "exact", head: true }).eq("user_id", userId).is("deleted_at", null),
  ]);

  if (!profileRes.data) notFound();
  const profile = profileRes.data as { id: string; full_name: string | null; email: string; avatar_url: string | null; role: "manager" | "author" | "viewer" };

  type Session = {
    session_id: string;
    last_seen_at: string;
    first_seen_at: string;
    device_type: string | null;
    browser: string | null;
    os: string | null;
    country: string | null;
  };
  const sessions = (sessionsRes.data ?? []) as Session[];

  type View = { id: string; time_spent_seconds: number | null; scroll_depth: number | null; read_complete: boolean | null };
  const views = (viewsRes.data ?? []) as View[];
  const totalTime = views.reduce((acc, v) => acc + (v.time_spent_seconds ?? 0), 0);
  const completed = views.filter((v) => v.read_complete).length;
  const reactionCount = (reactionsRes.count ?? 0) as number;
  const commentCount = (commentsRes.count ?? 0) as number;

  const history = await loadReadingHistory(userId, window);

  return (
    <main className="content-container space-y-6 py-8">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-4">
          <Link href={`/admin/analytics?tab=users&window=${windowId}`}>
            <ChevronLeft className="h-4 w-4" /> Back to users
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <Avatar src={profile.avatar_url} name={profile.full_name} email={profile.email} size="lg" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{profile.full_name ?? profile.email}</h1>
            <p className="text-sm text-muted-foreground">
              <span className="capitalize">{profile.role}</span> · {profile.email}
            </p>
          </div>
        </div>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Posts read" value={views.length} hint={`${completed} read to the end`} />
        <StatCard label="Total reading time" value={formatDuration(totalTime)} hint="Visible-time only" />
        <StatCard label="Reactions" value={reactionCount} />
        <StatCard label="Comments" value={commentCount} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tracked sessions for this user.</p>
          ) : (
            <ul className="divide-y">
              {sessions.map((s) => (
                <li key={s.session_id} className="flex items-center gap-3 py-2 text-sm">
                  <div className="flex-1">
                    <div className="font-medium">
                      {s.device_type ?? "unknown"}
                      {s.browser ? <span className="text-muted-foreground"> · {s.browser}</span> : null}
                      {s.os ? <span className="text-muted-foreground"> · {s.os}</span> : null}
                    </div>
                    {s.country && (
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.country}</div>
                    )}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {formatDateTime(s.first_seen_at)} → {formatDateTime(s.last_seen_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reading history</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity in the selected window.</p>
          ) : (
            <ol className="space-y-3">
              {history.map((entry, idx) => (
                <li key={`${entry.at}-${idx}`} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-portal-panel-soft text-portal-text-muted">
                    {entry.kind === "view" ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : entry.kind === "reaction" ? (
                      <ThumbsUp className="h-3.5 w-3.5" />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs uppercase tracking-wider text-muted-foreground">
                        {formatDateTime(entry.at)}
                      </span>
                      <Badge variant="muted" className="capitalize">{entry.kind}</Badge>
                      {entry.kind === "reaction" && entry.detail ? (
                        <span aria-hidden className="text-base">{entry.detail}</span>
                      ) : null}
                    </div>
                    <Link href={`/posts/${entry.postSlug}`} className="font-medium text-portal-text hover:text-portal-orange">
                      {entry.postTitle}
                    </Link>
                    {entry.kind === "comment" && entry.detail ? (
                      <p className="mt-1 text-sm text-portal-text-muted">“{entry.detail}”</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

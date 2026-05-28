import "server-only";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { trafficSourceFor, type TrafficSource } from "@/lib/analytics/events";

// All admin reads use the service client because the analytics tables are
// RLS-locked to managers + (for limited cases) post authors. The /admin
// pages call requireManager() before reaching this layer, so the service
// client is a safe widening here — not on public routes.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DateWindow {
  /** Inclusive lower bound, ISO. `null` = no lower bound (all time). */
  from: string | null;
  /** Inclusive upper bound, ISO. `null` = no upper bound (now). */
  to: string | null;
  /** Human label for the dashboard breadcrumb. */
  label: string;
}

export const WINDOW_PRESETS = [
  { id: "24h", label: "Today (24h)", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "all", label: "All time", days: null },
] as const;

export type WindowPresetId = (typeof WINDOW_PRESETS)[number]["id"];

export function resolveWindow(preset: WindowPresetId | undefined): DateWindow {
  const id = preset ?? "30d";
  const entry = WINDOW_PRESETS.find((p) => p.id === id) ?? WINDOW_PRESETS[2];
  if (entry.days === null) return { from: null, to: null, label: entry.label };
  return {
    from: new Date(Date.now() - entry.days * DAY_MS).toISOString(),
    to: null,
    label: entry.label,
  };
}

// ============================================================
// Overview
// ============================================================

export interface OverviewStats {
  totalViews: number;
  uniqueVisitors: number;
  totalSessions: number;
  loggedInVisitors: number;
  anonymousVisitors: number;
  averageTimeSpentSeconds: number;
  averageScrollDepth: number;
  readCompleteRate: number;
  topPosts: Array<{ id: string; title: string; slug: string; views: number }>;
  topReferrers: Array<{ source: TrafficSource; count: number }>;
  deviceMix: Array<{ device: string; count: number }>;
  totalSubscribers: number;
}

export async function loadOverview(window: DateWindow): Promise<OverviewStats> {
  const service = createSupabaseServiceClient();
  let viewsQuery = service
    .from("post_views")
    .select("post_id, viewer_id, session_id, time_spent_seconds, scroll_depth, read_complete, device_type, referrer");
  if (window.from) viewsQuery = viewsQuery.gte("created_at", window.from);
  if (window.to) viewsQuery = viewsQuery.lte("created_at", window.to);

  let sessionsQuery = service
    .from("analytics_sessions")
    .select("session_id, user_id, device_type, referrer");
  if (window.from) sessionsQuery = sessionsQuery.gte("last_seen_at", window.from);
  if (window.to) sessionsQuery = sessionsQuery.lte("last_seen_at", window.to);

  const [viewsRes, sessionsRes, postsRes, subsRes] = await Promise.all([
    viewsQuery,
    sessionsQuery,
    service.from("posts").select("id, title, slug").eq("status", "published"),
    service.from("subscribers").select("id", { count: "exact", head: true }).is("unsubscribed_at", null),
  ]);

  type ViewRow = {
    post_id: string;
    viewer_id: string | null;
    session_id: string | null;
    time_spent_seconds: number | null;
    scroll_depth: number | null;
    read_complete: boolean | null;
    device_type: string | null;
    referrer: string | null;
  };
  const views = ((viewsRes.data ?? []) as unknown as ViewRow[]) ?? [];

  type SessionRow = { session_id: string; user_id: string | null; device_type: string | null; referrer: string | null };
  const sessions = ((sessionsRes.data ?? []) as unknown as SessionRow[]) ?? [];

  const totalViews = views.length;
  const sessionIds = new Set<string>();
  let timeSum = 0;
  let timeCount = 0;
  let scrollSum = 0;
  let scrollCount = 0;
  let readCompleteCount = 0;
  const viewsByPost = new Map<string, number>();
  const referrerBuckets = new Map<TrafficSource, number>();
  const deviceMix = new Map<string, number>();

  for (const v of views) {
    if (v.session_id) sessionIds.add(v.session_id);
    if (typeof v.time_spent_seconds === "number") {
      timeSum += v.time_spent_seconds;
      timeCount += 1;
    }
    if (typeof v.scroll_depth === "number") {
      scrollSum += v.scroll_depth;
      scrollCount += 1;
    }
    if (v.read_complete) readCompleteCount += 1;
    viewsByPost.set(v.post_id, (viewsByPost.get(v.post_id) ?? 0) + 1);
    const bucket = trafficSourceFor(v.referrer);
    referrerBuckets.set(bucket, (referrerBuckets.get(bucket) ?? 0) + 1);
    const device = v.device_type ?? "unknown";
    deviceMix.set(device, (deviceMix.get(device) ?? 0) + 1);
  }

  const loggedInVisitors = sessions.filter((s) => s.user_id).length;
  const anonymousVisitors = sessions.length - loggedInVisitors;

  const posts = (postsRes.data ?? []) as Array<{ id: string; title: string; slug: string }>;
  const titleById = new Map(posts.map((p) => [p.id, p]));
  const topPosts = Array.from(viewsByPost.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => {
      const p = titleById.get(id);
      return { id, title: p?.title ?? "(removed post)", slug: p?.slug ?? "", views: count };
    });

  const topReferrers = Array.from(referrerBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, count }));

  return {
    totalViews,
    uniqueVisitors: sessionIds.size,
    totalSessions: sessions.length,
    loggedInVisitors,
    anonymousVisitors,
    averageTimeSpentSeconds: timeCount > 0 ? Math.round(timeSum / timeCount) : 0,
    averageScrollDepth: scrollCount > 0 ? Math.round(scrollSum / scrollCount) : 0,
    readCompleteRate: totalViews > 0 ? Math.round((readCompleteCount / totalViews) * 100) : 0,
    topPosts,
    topReferrers,
    deviceMix: Array.from(deviceMix.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([device, count]) => ({ device, count })),
    totalSubscribers: (subsRes.count ?? 0) as number,
  };
}

// ============================================================
// Per-post breakdown
// ============================================================

export interface PostBreakdownRow {
  id: string;
  title: string;
  slug: string;
  authorId: string;
  views: number;
  uniqueViewers: number;
  loggedInViewers: number;
  anonymousViewers: number;
  averageTimeSpentSeconds: number;
  averageScrollDepth: number;
  readCompleteRate: number;
  reactions: number;
  comments: number;
  shares: number;
}

export async function loadPostBreakdowns(window: DateWindow): Promise<PostBreakdownRow[]> {
  const service = createSupabaseServiceClient();

  const [postsRes, viewsRes, commentsRes, reactionsRes, eventsRes] = await Promise.all([
    service
      .from("posts")
      .select("id, title, slug, author_id")
      .eq("status", "published"),
    (() => {
      let q = service
        .from("post_views")
        .select(
          "post_id, viewer_id, session_id, time_spent_seconds, scroll_depth, read_complete",
        );
      if (window.from) q = q.gte("created_at", window.from);
      if (window.to) q = q.lte("created_at", window.to);
      return q;
    })(),
    (() => {
      let q = service.from("comments").select("post_id").is("deleted_at", null);
      if (window.from) q = q.gte("created_at", window.from);
      if (window.to) q = q.lte("created_at", window.to);
      return q;
    })(),
    (() => {
      let q = service.from("reactions").select("post_id");
      if (window.from) q = q.gte("created_at", window.from);
      if (window.to) q = q.lte("created_at", window.to);
      return q;
    })(),
    (() => {
      let q = service.from("analytics_events").select("post_id").eq("event_name", "share_clicked");
      if (window.from) q = q.gte("created_at", window.from);
      if (window.to) q = q.lte("created_at", window.to);
      return q;
    })(),
  ]);

  type Post = { id: string; title: string; slug: string; author_id: string };
  const posts = (postsRes.data ?? []) as Post[];

  type ViewRow = {
    post_id: string;
    viewer_id: string | null;
    session_id: string | null;
    time_spent_seconds: number | null;
    scroll_depth: number | null;
    read_complete: boolean | null;
  };
  const views = ((viewsRes.data ?? []) as unknown as ViewRow[]) ?? [];

  const byPost = new Map<
    string,
    {
      views: number;
      sessions: Set<string>;
      loggedIn: number;
      anonymous: number;
      timeSum: number;
      timeCount: number;
      scrollSum: number;
      scrollCount: number;
      complete: number;
    }
  >();
  for (const p of posts) {
    byPost.set(p.id, {
      views: 0,
      sessions: new Set(),
      loggedIn: 0,
      anonymous: 0,
      timeSum: 0,
      timeCount: 0,
      scrollSum: 0,
      scrollCount: 0,
      complete: 0,
    });
  }

  for (const v of views) {
    const slot = byPost.get(v.post_id);
    if (!slot) continue;
    slot.views += 1;
    if (v.session_id) slot.sessions.add(v.session_id);
    if (v.viewer_id) slot.loggedIn += 1;
    else slot.anonymous += 1;
    if (typeof v.time_spent_seconds === "number") {
      slot.timeSum += v.time_spent_seconds;
      slot.timeCount += 1;
    }
    if (typeof v.scroll_depth === "number") {
      slot.scrollSum += v.scroll_depth;
      slot.scrollCount += 1;
    }
    if (v.read_complete) slot.complete += 1;
  }

  const commentByPost = new Map<string, number>();
  for (const c of (commentsRes.data ?? []) as { post_id: string }[]) {
    commentByPost.set(c.post_id, (commentByPost.get(c.post_id) ?? 0) + 1);
  }
  const reactionByPost = new Map<string, number>();
  for (const r of (reactionsRes.data ?? []) as { post_id: string }[]) {
    reactionByPost.set(r.post_id, (reactionByPost.get(r.post_id) ?? 0) + 1);
  }
  const shareByPost = new Map<string, number>();
  for (const e of (eventsRes.data ?? []) as { post_id: string | null }[]) {
    if (e.post_id) shareByPost.set(e.post_id, (shareByPost.get(e.post_id) ?? 0) + 1);
  }

  return posts
    .map<PostBreakdownRow>((p) => {
      const slot = byPost.get(p.id)!;
      return {
        id: p.id,
        title: p.title,
        slug: p.slug,
        authorId: p.author_id,
        views: slot.views,
        uniqueViewers: slot.sessions.size,
        loggedInViewers: slot.loggedIn,
        anonymousViewers: slot.anonymous,
        averageTimeSpentSeconds:
          slot.timeCount > 0 ? Math.round(slot.timeSum / slot.timeCount) : 0,
        averageScrollDepth:
          slot.scrollCount > 0 ? Math.round(slot.scrollSum / slot.scrollCount) : 0,
        readCompleteRate: slot.views > 0 ? Math.round((slot.complete / slot.views) * 100) : 0,
        reactions: reactionByPost.get(p.id) ?? 0,
        comments: commentByPost.get(p.id) ?? 0,
        shares: shareByPost.get(p.id) ?? 0,
      };
    })
    .sort((a, b) => b.views - a.views);
}

// ============================================================
// Users tab — logged-in activity rollup
// ============================================================

export interface UserActivityRow {
  userId: string;
  fullName: string | null;
  email: string;
  avatarUrl: string | null;
  role: "manager" | "author" | "viewer";
  lastSeenAt: string | null;
  sessions: number;
  postsRead: number;
  reactions: number;
  comments: number;
}

export async function loadUserActivity(window: DateWindow): Promise<UserActivityRow[]> {
  const service = createSupabaseServiceClient();

  let sessionsQuery = service
    .from("analytics_sessions")
    .select("session_id, user_id, last_seen_at")
    .not("user_id", "is", null);
  if (window.from) sessionsQuery = sessionsQuery.gte("last_seen_at", window.from);
  if (window.to) sessionsQuery = sessionsQuery.lte("last_seen_at", window.to);

  let viewsQuery = service.from("post_views").select("viewer_id, post_id").not("viewer_id", "is", null);
  if (window.from) viewsQuery = viewsQuery.gte("created_at", window.from);
  if (window.to) viewsQuery = viewsQuery.lte("created_at", window.to);

  let reactionsQuery = service.from("reactions").select("user_id");
  if (window.from) reactionsQuery = reactionsQuery.gte("created_at", window.from);
  if (window.to) reactionsQuery = reactionsQuery.lte("created_at", window.to);

  let commentsQuery = service.from("comments").select("user_id").is("deleted_at", null);
  if (window.from) commentsQuery = commentsQuery.gte("created_at", window.from);
  if (window.to) commentsQuery = commentsQuery.lte("created_at", window.to);

  const [sessRes, viewsRes, reactRes, commRes, profileRes] = await Promise.all([
    sessionsQuery,
    viewsQuery,
    reactionsQuery,
    commentsQuery,
    service.from("profiles").select("id, full_name, email, avatar_url, role"),
  ]);

  type Session = { session_id: string; user_id: string; last_seen_at: string };
  const sessions = ((sessRes.data ?? []) as unknown as Session[]) ?? [];

  type View = { viewer_id: string; post_id: string };
  const views = ((viewsRes.data ?? []) as unknown as View[]) ?? [];

  type Profile = {
    id: string;
    full_name: string | null;
    email: string;
    avatar_url: string | null;
    role: "manager" | "author" | "viewer";
  };
  const profiles = ((profileRes.data ?? []) as unknown as Profile[]) ?? [];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const sessionsByUser = new Map<string, { count: number; lastSeen: string | null }>();
  for (const s of sessions) {
    const slot = sessionsByUser.get(s.user_id) ?? { count: 0, lastSeen: null };
    slot.count += 1;
    if (!slot.lastSeen || s.last_seen_at > slot.lastSeen) slot.lastSeen = s.last_seen_at;
    sessionsByUser.set(s.user_id, slot);
  }

  const postsReadByUser = new Map<string, Set<string>>();
  for (const v of views) {
    if (!postsReadByUser.has(v.viewer_id)) postsReadByUser.set(v.viewer_id, new Set());
    postsReadByUser.get(v.viewer_id)!.add(v.post_id);
  }

  const reactByUser = new Map<string, number>();
  for (const r of (reactRes.data ?? []) as { user_id: string }[]) {
    reactByUser.set(r.user_id, (reactByUser.get(r.user_id) ?? 0) + 1);
  }
  const commByUser = new Map<string, number>();
  for (const c of (commRes.data ?? []) as { user_id: string }[]) {
    commByUser.set(c.user_id, (commByUser.get(c.user_id) ?? 0) + 1);
  }

  // Build the row set from the union of users that show up anywhere in the
  // tracked window. A user with reactions but no recorded session still
  // appears in the rollup — useful for older accounts predating v2.
  const userIds = new Set<string>([
    ...sessionsByUser.keys(),
    ...postsReadByUser.keys(),
    ...reactByUser.keys(),
    ...commByUser.keys(),
  ]);

  return Array.from(userIds)
    .map<UserActivityRow | null>((id) => {
      const profile = profileById.get(id);
      if (!profile) return null;
      const sessionInfo = sessionsByUser.get(id);
      return {
        userId: id,
        fullName: profile.full_name,
        email: profile.email,
        avatarUrl: profile.avatar_url,
        role: profile.role,
        lastSeenAt: sessionInfo?.lastSeen ?? null,
        sessions: sessionInfo?.count ?? 0,
        postsRead: postsReadByUser.get(id)?.size ?? 0,
        reactions: reactByUser.get(id) ?? 0,
        comments: commByUser.get(id) ?? 0,
      };
    })
    .filter((r): r is UserActivityRow => r !== null)
    .sort((a, b) => {
      const aTs = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0;
      const bTs = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0;
      return bTs - aTs;
    });
}

// ============================================================
// Single-user reading history
// ============================================================

export interface ReadingHistoryEntry {
  at: string;
  postTitle: string;
  postSlug: string;
  kind: "view" | "reaction" | "comment";
  detail: string | null;
}

export async function loadReadingHistory(userId: string, window: DateWindow): Promise<ReadingHistoryEntry[]> {
  const service = createSupabaseServiceClient();

  let viewsQuery = service
    .from("post_views")
    .select("post_id, created_at")
    .eq("viewer_id", userId);
  if (window.from) viewsQuery = viewsQuery.gte("created_at", window.from);
  if (window.to) viewsQuery = viewsQuery.lte("created_at", window.to);

  let reactQuery = service
    .from("reactions")
    .select("post_id, emoji, created_at")
    .eq("user_id", userId);
  if (window.from) reactQuery = reactQuery.gte("created_at", window.from);
  if (window.to) reactQuery = reactQuery.lte("created_at", window.to);

  let commQuery = service
    .from("comments")
    .select("post_id, body, created_at")
    .eq("user_id", userId)
    .is("deleted_at", null);
  if (window.from) commQuery = commQuery.gte("created_at", window.from);
  if (window.to) commQuery = commQuery.lte("created_at", window.to);

  const [viewsRes, reactRes, commRes, postRes] = await Promise.all([
    viewsQuery,
    reactQuery,
    commQuery,
    service.from("posts").select("id, title, slug"),
  ]);

  type Post = { id: string; title: string; slug: string };
  const postById = new Map(
    ((postRes.data ?? []) as unknown as Post[]).map((p) => [p.id, p]),
  );

  const entries: ReadingHistoryEntry[] = [];

  for (const v of (viewsRes.data ?? []) as { post_id: string; created_at: string }[]) {
    const post = postById.get(v.post_id);
    if (!post) continue;
    entries.push({
      at: v.created_at,
      postTitle: post.title,
      postSlug: post.slug,
      kind: "view",
      detail: null,
    });
  }
  for (const r of (reactRes.data ?? []) as { post_id: string; emoji: string; created_at: string }[]) {
    const post = postById.get(r.post_id);
    if (!post) continue;
    entries.push({
      at: r.created_at,
      postTitle: post.title,
      postSlug: post.slug,
      kind: "reaction",
      detail: r.emoji,
    });
  }
  for (const c of (commRes.data ?? []) as { post_id: string; body: string; created_at: string }[]) {
    const post = postById.get(c.post_id);
    if (!post) continue;
    entries.push({
      at: c.created_at,
      postTitle: post.title,
      postSlug: post.slug,
      kind: "comment",
      detail: c.body.length > 80 ? `${c.body.slice(0, 77)}…` : c.body,
    });
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ============================================================
// Reactions / comments by user (Reactions + Comments tabs)
// ============================================================

export interface ReactionDetail {
  postId: string;
  postTitle: string;
  postSlug: string;
  userName: string;
  userEmail: string;
  emoji: string;
  createdAt: string;
}

export async function loadReactionDetails(window: DateWindow, postId?: string | null): Promise<ReactionDetail[]> {
  const service = createSupabaseServiceClient();
  let q = service
    .from("reactions")
    .select("post_id, user_id, emoji, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (window.from) q = q.gte("created_at", window.from);
  if (window.to) q = q.lte("created_at", window.to);
  if (postId) q = q.eq("post_id", postId);

  const { data, error } = await q;
  if (error) return [];

  const rows = (data ?? []) as { post_id: string; user_id: string; emoji: string; created_at: string }[];
  const postIds = Array.from(new Set(rows.map((r) => r.post_id)));
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const [postRes, profileRes] = await Promise.all([
    postIds.length
      ? service.from("posts").select("id, title, slug").in("id", postIds)
      : Promise.resolve({ data: [] as { id: string; title: string; slug: string }[] }),
    userIds.length
      ? service.from("profiles").select("id, full_name, email").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string }[] }),
  ]);

  const postById = new Map(
    ((postRes.data ?? []) as { id: string; title: string; slug: string }[]).map((p) => [p.id, p]),
  );
  const profileById = new Map(
    ((profileRes.data ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p]),
  );

  return rows
    .map<ReactionDetail | null>((r) => {
      const p = postById.get(r.post_id);
      const u = profileById.get(r.user_id);
      if (!p || !u) return null;
      return {
        postId: r.post_id,
        postTitle: p.title,
        postSlug: p.slug,
        userName: u.full_name ?? u.email,
        userEmail: u.email,
        emoji: r.emoji,
        createdAt: r.created_at,
      };
    })
    .filter((r): r is ReactionDetail => r !== null);
}

export interface CommentDetail {
  id: string;
  postId: string;
  postTitle: string;
  postSlug: string;
  userName: string;
  userEmail: string;
  body: string;
  createdAt: string;
}

export async function loadCommentDetails(window: DateWindow, postId?: string | null): Promise<CommentDetail[]> {
  const service = createSupabaseServiceClient();
  let q = service
    .from("comments")
    .select("id, post_id, user_id, body, created_at, author_name")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (window.from) q = q.gte("created_at", window.from);
  if (window.to) q = q.lte("created_at", window.to);
  if (postId) q = q.eq("post_id", postId);

  const { data, error } = await q;
  if (error) return [];

  type Row = {
    id: string;
    post_id: string;
    user_id: string;
    body: string;
    created_at: string;
    author_name: string;
  };
  const rows = (data ?? []) as Row[];
  const postIds = Array.from(new Set(rows.map((r) => r.post_id)));
  const userIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const [postRes, profileRes] = await Promise.all([
    postIds.length
      ? service.from("posts").select("id, title, slug").in("id", postIds)
      : Promise.resolve({ data: [] as { id: string; title: string; slug: string }[] }),
    userIds.length
      ? service.from("profiles").select("id, full_name, email").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string }[] }),
  ]);

  const postById = new Map(
    ((postRes.data ?? []) as { id: string; title: string; slug: string }[]).map((p) => [p.id, p]),
  );
  const profileById = new Map(
    ((profileRes.data ?? []) as { id: string; full_name: string | null; email: string }[]).map((p) => [p.id, p]),
  );

  return rows
    .map<CommentDetail | null>((c) => {
      const p = postById.get(c.post_id);
      const u = profileById.get(c.user_id);
      if (!p) return null;
      return {
        id: c.id,
        postId: c.post_id,
        postTitle: p.title,
        postSlug: p.slug,
        userName: u?.full_name ?? u?.email ?? c.author_name,
        userEmail: u?.email ?? "",
        body: c.body,
        createdAt: c.created_at,
      };
    })
    .filter((c): c is CommentDetail => c !== null);
}

// ============================================================
// Traffic + device tabs
// ============================================================

export interface TrafficSourceRow {
  source: TrafficSource;
  views: number;
  uniqueSessions: number;
}

export async function loadTrafficSources(window: DateWindow): Promise<TrafficSourceRow[]> {
  const service = createSupabaseServiceClient();
  let q = service.from("post_views").select("session_id, referrer");
  if (window.from) q = q.gte("created_at", window.from);
  if (window.to) q = q.lte("created_at", window.to);
  const { data } = await q;
  const rows = (data ?? []) as { session_id: string | null; referrer: string | null }[];

  const tally = new Map<TrafficSource, { views: number; sessions: Set<string> }>();
  for (const r of rows) {
    const bucket = trafficSourceFor(r.referrer);
    if (!tally.has(bucket)) tally.set(bucket, { views: 0, sessions: new Set() });
    const slot = tally.get(bucket)!;
    slot.views += 1;
    if (r.session_id) slot.sessions.add(r.session_id);
  }
  return Array.from(tally.entries())
    .map<TrafficSourceRow>(([source, slot]) => ({
      source,
      views: slot.views,
      uniqueSessions: slot.sessions.size,
    }))
    .sort((a, b) => b.views - a.views);
}

export interface DeviceMixRow {
  bucket: string;
  count: number;
}

export interface DeviceTabData {
  byDeviceType: DeviceMixRow[];
  byBrowser: DeviceMixRow[];
  byOs: DeviceMixRow[];
}

export async function loadDeviceMix(window: DateWindow): Promise<DeviceTabData> {
  const service = createSupabaseServiceClient();
  let q = service.from("post_views").select("device_type, browser, os");
  if (window.from) q = q.gte("created_at", window.from);
  if (window.to) q = q.lte("created_at", window.to);
  const { data } = await q;
  const rows = (data ?? []) as { device_type: string | null; browser: string | null; os: string | null }[];

  const tally = (key: "device_type" | "browser" | "os") => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = r[key] ?? "Unknown";
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return Array.from(m.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count);
  };

  return {
    byDeviceType: tally("device_type"),
    byBrowser: tally("browser"),
    byOs: tally("os"),
  };
}

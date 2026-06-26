import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, Mail, Search, UserMinus, UserPlus, MailCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isSandboxSender } from "@/lib/email/newsletter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export const metadata: Metadata = { title: "Subscribers" };
export const dynamic = "force-dynamic";

interface SubscriberRow {
  id: string;
  email: string;
  source: string | null;
  unsubscribed_at: string | null;
  created_at: string;
  welcome_sent_at: string | null;
  user_id: string | null;
}

interface SearchParams {
  q?: string;
  status?: "all" | "active" | "unsubscribed";
}

/**
 * Newsletter subscribers admin. Manager-only — `subscribers` is a private,
 * RLS-locked table, so we go through the service-role client. Everything
 * happens on the server: search filter is a `searchParams.q` parameter and
 * status is a `searchParams.status` enum, both folded into the query so we
 * never ship the full subscriber list to the client.
 */
export default async function SubscribersAdminPage(
  props: {
    searchParams: Promise<SearchParams>;
  }
) {
  const searchParams = await props.searchParams;
  await requireManager();
  const service = createSupabaseServiceClient();

  const q = (searchParams.q ?? "").trim();
  const status: "all" | "active" | "unsubscribed" =
    searchParams.status === "active" || searchParams.status === "unsubscribed"
      ? searchParams.status
      : "all";

  let query = service
    .from("subscribers")
    .select("id, email, source, unsubscribed_at, created_at, welcome_sent_at, user_id")
    .order("created_at", { ascending: false });

  if (status === "active") query = query.is("unsubscribed_at", null);
  if (status === "unsubscribed") query = query.not("unsubscribed_at", "is", null);
  // ilike is case-insensitive + supports leading/trailing %. We constrain to
  // local-part + domain only; no SQL wildcards from the user themselves.
  if (q) query = query.ilike("email", `%${q.replace(/[%_]/g, "")}%`);

  const { data, error } = await query.limit(500);
  const rows = (data ?? []) as SubscriberRow[];

  // Headline counts come from a separate count query so totals reflect the
  // whole table — not just the filtered/limited slice rendered below.
  const [
    { count: totalAll },
    { count: totalActive },
    { count: totalUnsub },
    { count: totalWelcomed },
    { data: lastNl },
  ] = await Promise.all([
    service.from("subscribers").select("id", { count: "exact", head: true }),
    service.from("subscribers").select("id", { count: "exact", head: true }).is("unsubscribed_at", null),
    service.from("subscribers").select("id", { count: "exact", head: true }).not("unsubscribed_at", "is", null),
    service.from("subscribers").select("id", { count: "exact", head: true }).not("welcome_sent_at", "is", null),
    service
      .from("posts")
      .select("title, slug, newsletter_sent_at")
      .not("newsletter_sent_at", "is", null)
      .order("newsletter_sent_at", { ascending: false })
      .limit(1),
  ]);
  const lastNewsletter = (lastNl?.[0] ?? null) as
    | { title: string; slug: string; newsletter_sent_at: string }
    | null;

  // Resend delivery configuration — the usual reason "no one receives email".
  const resendFrom = process.env.RESEND_FROM ?? "";
  const resendConfigured = !!process.env.RESEND_API_KEY && !!resendFrom;
  const sandbox = isSandboxSender(resendFrom);

  return (
    <main className="content-container space-y-6 py-8">
      <div className="space-y-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin">
            <ChevronLeft className="h-4 w-4" /> Admin
          </Link>
        </Button>
        <h1 className="font-hero text-3xl font-bold uppercase tracking-tighter text-portal-text sm:text-4xl">
          Subscribers
        </h1>
        <p className="text-sm text-portal-text-muted">
          Newsletter signups. Emails stay private — only managers can open this page.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={totalAll ?? 0} icon={Mail} />
        <StatTile label="Active" value={totalActive ?? 0} icon={UserPlus} tone="green" />
        <StatTile label="Unsubscribed" value={totalUnsub ?? 0} icon={UserMinus} tone="muted" />
        <StatTile label="Welcome sent" value={totalWelcomed ?? 0} icon={MailCheck} />
      </div>

      {/* Delivery diagnostics — surfaces the usual reasons emails don't arrive. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <MailCheck className="h-4 w-4" /> Delivery diagnostics
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!resendConfigured ? (
            <div className="flex items-start gap-2 rounded-md border border-portal-yellow/30 bg-portal-yellow/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-portal-yellow" />
              <div>
                <div className="font-ui font-bold text-portal-text">Email is not configured</div>
                <p className="mt-0.5 text-xs text-portal-text-muted">
                  Set <code>RESEND_API_KEY</code> and <code>RESEND_FROM</code> to send the welcome
                  email and per-post newsletters. Publishing still works without it.
                </p>
              </div>
            </div>
          ) : sandbox ? (
            <div className="flex items-start gap-2 rounded-md border border-portal-yellow/30 bg-portal-yellow/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-portal-yellow" />
              <div>
                <div className="font-ui font-bold text-portal-text">Resend sandbox sender detected</div>
                <p className="mt-0.5 text-xs text-portal-text-muted">
                  <code>RESEND_FROM</code> uses an <code>@resend.dev</code> address — Resend will
                  only deliver to the account owner. Verify a domain and set{" "}
                  <code>RESEND_FROM=&quot;CG Signal &lt;signal@your-domain&gt;&quot;</code> to reach
                  all subscribers.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-portal-green/30 bg-portal-green/10 p-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-portal-green" />
              <div>
                <div className="font-ui font-bold text-portal-text">Email configured</div>
                <p className="mt-0.5 text-xs text-portal-text-muted">
                  Sending from a verified domain. Newsletters fire on publish to all active
                  subscribers.
                </p>
              </div>
            </div>
          )}
          <div className="text-xs text-portal-text-muted">
            {lastNewsletter ? (
              <>
                Last newsletter dispatched {formatDate(lastNewsletter.newsletter_sent_at)} for{" "}
                <Link href={`/posts/${lastNewsletter.slug}`} className="text-portal-blue hover:underline">
                  {lastNewsletter.title || "Untitled"}
                </Link>
                .
              </>
            ) : (
              "No newsletter has been dispatched yet."
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All subscribers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            method="get"
            action="/admin/subscribers"
            className="flex flex-wrap items-center gap-2"
          >
            <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-portal-text-muted" />
              <Input
                name="q"
                defaultValue={q}
                placeholder="Search by email…"
                className="pl-10"
              />
            </div>
            <input type="hidden" name="status" value={status} />
            <Button type="submit" variant="outline">
              Search
            </Button>
            {(q || status !== "all") && (
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/subscribers">Clear</Link>
              </Button>
            )}
          </form>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-2 text-[10px] uppercase tracking-wider text-portal-text-muted">
              Status:
            </span>
            {(["all", "active", "unsubscribed"] as const).map((s) => {
              const active = status === s;
              const href = q
                ? `/admin/subscribers?q=${encodeURIComponent(q)}&status=${s}`
                : `/admin/subscribers?status=${s}`;
              return (
                <Link
                  key={s}
                  href={href}
                  className={
                    "rounded-pill border px-3 py-0.5 font-ui text-[10px] uppercase tracking-wider transition-colors " +
                    (active
                      ? "border-portal-orange/40 bg-portal-orange/10 text-portal-orange"
                      : "border-portal-border-soft text-portal-text-muted hover:border-portal-border-muted")
                  }
                >
                  {s}
                </Link>
              );
            })}
          </div>

          {error ? (
            <p className="text-sm text-portal-red">Failed to load subscribers.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-portal-text-muted">
              {q || status !== "all"
                ? "No subscribers match this filter."
                : "No subscribers yet."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="border-b border-portal-border-soft text-left text-[10px] uppercase tracking-wider text-portal-text-muted">
                    <th className="px-2 py-2 font-medium">Email</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Source</th>
                    <th className="px-2 py-2 font-medium">Welcome</th>
                    <th className="px-2 py-2 font-medium">Subscribed</th>
                    <th className="px-2 py-2 font-medium">Unsubscribed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-portal-border-soft">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-2 font-ui text-portal-text">{r.email}</td>
                      <td className="px-2 py-2">
                        {r.unsubscribed_at ? (
                          <Badge variant="muted">Unsubscribed</Badge>
                        ) : (
                          <Badge variant="success">Active</Badge>
                        )}
                      </td>
                      <td className="px-2 py-2 text-portal-text-muted">
                        {r.source ?? "—"}
                      </td>
                      <td className="px-2 py-2 text-portal-text-muted tabular-nums">
                        {r.welcome_sent_at ? formatDate(r.welcome_sent_at) : "—"}
                      </td>
                      <td className="px-2 py-2 text-portal-text-muted tabular-nums">
                        {formatDate(r.created_at)}
                      </td>
                      <td className="px-2 py-2 text-portal-text-muted tabular-nums">
                        {r.unsubscribed_at ? formatDate(r.unsubscribed_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 500 && (
                <p className="mt-3 text-[10px] uppercase tracking-wider text-portal-text-muted">
                  Showing first 500 rows. Filter to narrow the list further.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "green" | "muted";
}) {
  const valueColor =
    tone === "green"
      ? "text-portal-green"
      : tone === "muted"
        ? "text-portal-text-muted"
        : "text-portal-text";
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <Icon className="h-5 w-5 text-portal-text-muted" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
            {label}
          </div>
          <div className={`mt-1 font-hero text-3xl font-bold tracking-tighter ${valueColor}`}>
            {value}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

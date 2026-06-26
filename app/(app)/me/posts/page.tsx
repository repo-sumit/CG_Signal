import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireWriter } from "@/lib/auth/guards";
import { listOwnPosts, listSharedPosts } from "@/lib/db/posts";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelBody, PanelHeader } from "@/components/portal/Panel";
import { PostRowActions } from "@/components/blog/PostRowActions";
import { formatPostDate, formatScheduledLabel } from "@/lib/utils/dates";
import { isManager } from "@/lib/auth/roles";
import { COLLAB_ROLE_LABEL } from "@/lib/auth/collaboration";
import { reviewBadge } from "@/lib/utils/reviewStatus";

export const metadata: Metadata = { title: "My posts" };
export const dynamic = "force-dynamic";

const GROUP_LABEL: Record<string, string> = {
  draft: "Drafts",
  submitted: "Under Review",
  scheduled: "Scheduled",
  published: "Published",
};

export default async function MyPostsPage() {
  const { userId, profile } = await requireWriter();
  const [posts, shared] = await Promise.all([listOwnPosts(userId), listSharedPosts(userId)]);

  const live = posts.filter((p) => p.status !== "archived");
  const trashed = posts.filter((p) => p.status === "archived");

  const grouped: Record<string, typeof live> = { draft: [], submitted: [], scheduled: [], published: [] };
  for (const p of live) {
    if (grouped[p.status]) grouped[p.status]!.push(p);
  }

  return (
    <div className="container mx-auto space-y-6 px-4 py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h1 className="font-hero text-4xl font-bold uppercase tracking-tighter text-portal-text sm:text-5xl">
            My Posts
          </h1>
          <p className="text-sm text-portal-text-muted">Every signal you've published, drafted, or scheduled.</p>
        </div>
        <Button asChild>
          <Link href="/editor/new">
            <Plus className="h-4 w-4" /> New Transmission
          </Link>
        </Button>
      </header>

      {live.length === 0 && trashed.length === 0 && shared.length === 0 ? (
        <Panel>
          <PanelBody className="p-16 text-center">
            <h2 className="font-hero text-xl font-bold uppercase text-portal-text">No transmissions yet</h2>
            <p className="mt-2 text-sm text-portal-text-muted">Start your first signal.</p>
            <Button asChild className="mt-5">
              <Link href="/editor/new">Create your first post</Link>
            </Button>
          </PanelBody>
        </Panel>
      ) : (
        <>
          {(["draft", "submitted", "scheduled", "published"] as const).map((status) =>
            (grouped[status]?.length ?? 0) > 0 ? (
              <Panel key={status}>
                <PanelHeader>
                  <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                    {GROUP_LABEL[status] ?? status} ({grouped[status]!.length})
                  </div>
                </PanelHeader>
                <PanelBody className="p-0">
                  <ul className="divide-y divide-portal-border-soft">
                    {grouped[status]!.map((p) => {
                      const badge = reviewBadge(p.status, p.review_status);
                      return (
                      <li key={p.id} className="flex items-center justify-between gap-3 px-6 py-4">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/editor/${p.id}`}
                            className="font-ui font-bold text-portal-text hover:text-portal-orange"
                          >
                            {p.title || "Untitled"}
                          </Link>
                          <div className="mt-1 text-[10px] uppercase tracking-wider text-portal-text-muted">
                            Week of {formatPostDate(p.week_start_date)} · updated {formatPostDate(p.updated_at)}
                            {p.status === "scheduled" && p.scheduled_for && (
                              <> · goes live {formatScheduledLabel(p.scheduled_for)}</>
                            )}
                            {p.status === "published" && (
                              <> · {p.viewCount ?? 0} {p.viewCount === 1 ? "view" : "views"}</>
                            )}
                          </div>
                          {p.review_status === "changes_requested" && p.review_note && (
                            <p className="mt-2 rounded border border-portal-yellow/30 bg-portal-yellow/10 px-3 py-2 text-xs text-portal-text">
                              <span className="font-bold">Changes requested:</span> {p.review_note}
                            </p>
                          )}
                          {p.review_status === "rejected" && p.rejection_reason && (
                            <p className="mt-2 rounded border border-portal-red/30 bg-portal-red/10 px-3 py-2 text-xs text-portal-text">
                              <span className="font-bold">Review rejected:</span> {p.rejection_reason}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/editor/${p.id}`}>Edit</Link>
                          </Button>
                          {p.status === "published" && (
                            <Button asChild size="sm" variant="ghost">
                              <Link href={`/posts/${p.slug}`}>View</Link>
                            </Button>
                          )}
                          <PostRowActions
                            postId={p.id}
                            status={p.status}
                            canPermanentDelete={isManager(profile.role)}
                          />
                        </div>
                      </li>
                      );
                    })}
                  </ul>
                </PanelBody>
              </Panel>
            ) : null,
          )}

          {/* Shared with me — drafts the user was invited to collaborate on. */}
          {shared.length > 0 && (
            <Panel>
              <PanelHeader>
                <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                  Shared with me ({shared.length})
                </div>
                <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                  Drafts you've been invited to
                </div>
              </PanelHeader>
              <PanelBody className="p-0">
                <ul className="divide-y divide-portal-border-soft">
                  {shared.map((p) => {
                    const isReviewer = p.collaboratorRole === "reviewer";
                    return (
                      <li key={p.id} className="flex items-center justify-between gap-3 px-6 py-4">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/editor/${p.id}`}
                            className="font-ui font-bold text-portal-text hover:text-portal-orange"
                          >
                            {p.title || "Untitled"}
                          </Link>
                          <div className="mt-1 text-[10px] uppercase tracking-wider text-portal-text-muted">
                            by {p.author?.full_name || p.author?.email || "Unknown"} · updated{" "}
                            {formatPostDate(p.updated_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant={isReviewer ? "secondary" : "default"}>
                            {COLLAB_ROLE_LABEL[p.collaboratorRole]}
                          </Badge>
                          {(() => {
                            const b = reviewBadge(p.status, p.review_status);
                            return <Badge variant={b.variant}>{b.label}</Badge>;
                          })()}
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/editor/${p.id}`}>{isReviewer ? "Review" : "Edit"}</Link>
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </PanelBody>
            </Panel>
          )}

          {/* Trash bin — posts stay here until the author (or an admin) deletes them. */}
          {trashed.length > 0 && (
            <Panel>
              <PanelHeader>
                <div className="font-hero text-base font-bold uppercase tracking-tighter text-portal-text">
                  Trash ({trashed.length})
                </div>
                <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                  Restore or delete permanently
                </div>
              </PanelHeader>
              <PanelBody className="p-0">
                <ul className="divide-y divide-portal-border-soft">
                  {trashed.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-6 py-4">
                      <div className="min-w-0 flex-1">
                        <div className="font-ui font-bold text-portal-text-muted line-through">
                          {p.title || "Untitled"}
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-portal-text-muted">
                          Deleted {p.archived_at ? formatPostDate(p.archived_at) : ""}
                        </div>
                      </div>
                      <PostRowActions
                        postId={p.id}
                        status={p.status}
                        canPermanentDelete={isManager(profile.role)}
                      />
                    </li>
                  ))}
                </ul>
              </PanelBody>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

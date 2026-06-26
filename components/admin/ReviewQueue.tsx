"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MessageSquare, XCircle, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils/cn";
import {
  approveAndPublishPost,
  requestPostChanges,
  rejectPost,
} from "@/app/(app)/admin/actions";
import { reviewBadge } from "@/lib/utils/reviewStatus";
import type { PostStatus, ReviewStatus } from "@/lib/db/types";
import type { ReviewQueueFilter } from "@/lib/db/posts";

export interface ReviewItem {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  status: PostStatus;
  reviewStatus: ReviewStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  rejectionReason: string | null;
  updatedAt: string;
  authorName: string;
  tags: string[];
}

const TABS: { key: ReviewQueueFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "under_review", label: "Under Review" },
  { key: "changes_requested", label: "Changes Requested" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "published", label: "Published" },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type FeedbackKind = "changes" | "reject";

export function ReviewQueue({
  items,
  activeFilter,
}: {
  items: ReviewItem[];
  activeFilter: ReviewQueueFilter;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; item: ReviewItem } | null>(null);

  function approve(item: ReviewItem) {
    setBusyId(item.id);
    startTransition(async () => {
      const res = await approveAndPublishPost(item.id);
      setBusyId(null);
      if (!res.ok) toast.error(res.error || "Failed to approve.");
      else {
        toast.success(`Published "${item.title}".`);
        router.refresh();
      }
    });
  }

  function submitFeedback(note: string) {
    if (!feedback) return;
    const { kind, item } = feedback;
    setBusyId(item.id);
    startTransition(async () => {
      const res =
        kind === "changes"
          ? await requestPostChanges(item.id, note)
          : await rejectPost(item.id, note);
      setBusyId(null);
      if (!res.ok) {
        toast.error(res.error || "Failed.");
        return;
      }
      toast.success(kind === "changes" ? "Changes requested." : "Post rejected.");
      setFeedback(null);
      router.refresh();
    });
  }

  return (
    <div className="container mx-auto space-y-6 px-4 py-10">
      <header className="space-y-2">
        <h1 className="font-hero text-4xl font-bold uppercase tracking-tighter text-portal-text sm:text-5xl">
          Review Queue
        </h1>
        <p className="text-sm text-portal-text-muted">
          Approve, request changes, or reject signals submitted by ConveGenius writers.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/review?filter=${t.key}`}
            className={cn(
              "rounded-pill border px-3 py-1.5 font-ui text-[11px] uppercase tracking-label transition-colors",
              t.key === activeFilter
                ? "border-portal-orange/50 bg-portal-orange/10 text-portal-orange"
                : "border-portal-border-soft text-portal-text-muted hover:border-portal-border-muted hover:text-portal-text",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <div className="rounded-md border border-portal-border-soft bg-portal-panel p-10 text-center text-sm text-portal-text-muted">
          Nothing here right now.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => {
            const badge = reviewBadge(item.status, item.reviewStatus);
            const actionable = item.reviewStatus === "under_review";
            const rowBusy = busyId === item.id && pending;
            return (
              <li
                key={item.id}
                className="rounded-md border border-portal-border-soft bg-portal-panel p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {item.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    <h2 className="mt-2 font-hero text-xl font-bold tracking-tight text-portal-text">
                      {item.title || "Untitled draft"}
                    </h2>
                    {item.excerpt && (
                      <p className="mt-1 line-clamp-2 text-sm text-portal-text-muted">
                        {item.excerpt}
                      </p>
                    )}
                    <div className="mt-2 text-[11px] uppercase tracking-wider text-portal-text-muted">
                      {item.authorName} · submitted {formatDate(item.submittedAt)} · updated{" "}
                      {formatDate(item.updatedAt)}
                    </div>
                    {item.reviewStatus === "changes_requested" && item.reviewNote && (
                      <p className="mt-2 rounded border border-portal-yellow/30 bg-portal-yellow/10 px-3 py-2 text-xs text-portal-text">
                        Last note: {item.reviewNote}
                      </p>
                    )}
                    {item.reviewStatus === "rejected" && item.rejectionReason && (
                      <p className="mt-2 rounded border border-portal-red/30 bg-portal-red/10 px-3 py-2 text-xs text-portal-text">
                        Rejected: {item.rejectionReason}
                      </p>
                    )}
                  </div>

                  <Link
                    href={`/editor/${item.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-portal-border-soft px-3 py-1.5 text-[11px] uppercase tracking-wider text-portal-text-muted transition-colors hover:border-portal-border-muted hover:text-portal-text"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open
                  </Link>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => approve(item)}
                    disabled={rowBusy || pending}
                    title={actionable ? "Approve and publish now" : "Approve and publish"}
                  >
                    {rowBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    Approve &amp; Publish
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setFeedback({ kind: "changes", item })}
                    disabled={pending}
                  >
                    <MessageSquare className="h-4 w-4" /> Request Changes
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setFeedback({ kind: "reject", item })}
                    disabled={pending}
                  >
                    <XCircle className="h-4 w-4" /> Reject
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {feedback && (
        <FeedbackModal
          kind={feedback.kind}
          title={feedback.item.title || "Untitled draft"}
          busy={busyId === feedback.item.id && pending}
          onCancel={() => setFeedback(null)}
          onConfirm={submitFeedback}
        />
      )}
    </div>
  );
}

function FeedbackModal({
  kind,
  title,
  busy,
  onCancel,
  onConfirm,
}: {
  kind: FeedbackKind;
  title: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isReject = kind === "reject";

  function confirm() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(isReject ? "A rejection reason is required." : "Add a note for the writer.");
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-feedback-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !busy && onCancel()}
      />
      <div className="relative w-full max-w-md rounded-md border-2 border-portal-border-muted bg-portal-panel-raised shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
        <header className="flex items-start justify-between gap-4 border-b-2 border-portal-border-soft px-5 py-4">
          <div>
            <div
              className={cn(
                "flex items-center gap-2 text-[10px] uppercase tracking-wider",
                isReject ? "text-portal-red" : "text-portal-yellow",
              )}
            >
              {isReject ? <XCircle className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
              {isReject ? "Reject" : "Request changes"}
            </div>
            <h2
              id="review-feedback-title"
              className="mt-1 font-hero text-xl font-bold uppercase tracking-tighter text-portal-text"
            >
              {isReject ? "Reject signal" : "Request changes"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-portal-text-muted transition-colors hover:bg-portal-panel-soft hover:text-portal-text"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-3 px-5 py-5">
          <p className="text-sm leading-relaxed text-portal-text-muted">
            {isReject
              ? `Tell the writer why "${title}" can't be published. They can revise and resubmit.`
              : `Tell the writer what to change in "${title}". They can edit and submit again.`}
          </p>
          <label className="block">
            <span className="mb-1.5 block text-[10px] uppercase tracking-wider text-portal-text-muted">
              {isReject ? "Rejection reason" : "Note for writer"}
            </span>
            <textarea
              autoFocus
              rows={4}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              className={cn(
                "w-full rounded-md border-2 bg-portal-panel-soft px-3 py-2 font-ui text-sm text-portal-text",
                "focus:outline-none focus:border-portal-blue focus:shadow-[0_0_0_4px_rgba(79,140,255,0.18)]",
                error ? "border-portal-red" : "border-portal-border-muted",
              )}
            />
            {error && <span className="mt-1 block text-[11px] font-medium text-portal-red">{error}</span>}
          </label>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t-2 border-portal-border-soft px-5 py-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={confirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isReject ? "Reject signal" : "Send to writer"}
          </Button>
        </footer>
      </div>
    </div>
  );
}

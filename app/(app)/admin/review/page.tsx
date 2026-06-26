import type { Metadata } from "next";
import { requireManager } from "@/lib/auth/guards";
import { listReviewQueue, type ReviewQueueFilter } from "@/lib/db/posts";
import { ReviewQueue, type ReviewItem } from "@/components/admin/ReviewQueue";

export const metadata: Metadata = { title: "Review Queue" };
export const dynamic = "force-dynamic";

const FILTERS: ReviewQueueFilter[] = [
  "all",
  "under_review",
  "changes_requested",
  "approved",
  "rejected",
  "published",
];

function resolveFilter(raw: string | string[] | undefined): ReviewQueueFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (FILTERS as string[]).includes(value ?? "")
    ? (value as ReviewQueueFilter)
    : "under_review";
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireManager();
  const { filter: filterParam } = await searchParams;
  const filter = resolveFilter(filterParam);
  const posts = await listReviewQueue(filter);

  const items: ReviewItem[] = posts.map((p) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    excerpt: p.excerpt,
    status: p.status,
    reviewStatus: p.review_status,
    submittedAt: p.submitted_for_review_at,
    reviewedAt: p.reviewed_at,
    reviewNote: p.review_note,
    rejectionReason: p.rejection_reason,
    updatedAt: p.updated_at,
    authorName: p.author?.full_name ?? p.author?.email ?? "Unknown",
    tags: p.tags.map((t) => t.name),
  }));

  return <ReviewQueue items={items} activeFilter={filter} />;
}

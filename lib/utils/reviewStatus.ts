import type { PostStatus, ReviewStatus } from "@/lib/db/types";

/** Badge variants exposed by components/ui/Badge.tsx. */
export type ReviewBadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "muted"
  | "blue";

export interface ReviewBadge {
  label: string;
  variant: ReviewBadgeVariant;
}

/**
 * Single source of truth for how a post's review state is surfaced to writers
 * and admins. Combines the publishing `status` with the `review_status`
 * sub-state so the badge reads correctly in every UI (post cards, the writer
 * dashboard, the admin review queue).
 *
 * Published always wins — once live, the review history is irrelevant to the
 * badge. Otherwise the review sub-state drives the label/colour.
 */
export function reviewBadge(status: PostStatus, review: ReviewStatus): ReviewBadge {
  if (status === "published") return { label: "Published", variant: "success" };
  if (status === "scheduled") return { label: "Scheduled", variant: "blue" };
  if (status === "hidden") return { label: "Hidden", variant: "secondary" };
  if (status === "archived") return { label: "Archived", variant: "destructive" };

  switch (review) {
    case "under_review":
      return { label: "Under Review", variant: "warning" };
    case "changes_requested":
      return { label: "Changes Requested", variant: "warning" };
    case "rejected":
      return { label: "Review Rejected", variant: "destructive" };
    case "approved":
      return { label: "Review Passed", variant: "success" };
    case "not_submitted":
    default:
      return { label: "Draft", variant: "muted" };
  }
}

/** Human label for a review_status value on its own (e.g. queue filters). */
export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  not_submitted: "Not submitted",
  under_review: "Under Review",
  changes_requested: "Changes Requested",
  approved: "Review Passed",
  rejected: "Review Rejected",
};

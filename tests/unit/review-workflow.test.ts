import { describe, it, expect } from "vitest";
import { reviewBadge, REVIEW_STATUS_LABEL } from "@/lib/utils/reviewStatus";

describe("reviewBadge", () => {
  it("published always reads as Published regardless of review_status", () => {
    expect(reviewBadge("published", "approved")).toEqual({ label: "Published", variant: "success" });
    // Even a stale review_status can't override a live post.
    expect(reviewBadge("published", "under_review").label).toBe("Published");
  });

  it("maps each review sub-state for an unpublished post", () => {
    expect(reviewBadge("submitted", "under_review")).toEqual({
      label: "Under Review",
      variant: "warning",
    });
    expect(reviewBadge("draft", "changes_requested")).toEqual({
      label: "Changes Requested",
      variant: "warning",
    });
    expect(reviewBadge("draft", "rejected")).toEqual({
      label: "Review Rejected",
      variant: "destructive",
    });
    expect(reviewBadge("draft", "approved")).toEqual({
      label: "Review Passed",
      variant: "success",
    });
    expect(reviewBadge("draft", "not_submitted")).toEqual({ label: "Draft", variant: "muted" });
  });

  it("scheduled and archived have their own badges", () => {
    expect(reviewBadge("scheduled", "not_submitted").label).toBe("Scheduled");
    expect(reviewBadge("archived", "not_submitted").label).toBe("Archived");
  });

  it("labels exist for every review_status", () => {
    expect(Object.keys(REVIEW_STATUS_LABEL).sort()).toEqual(
      ["approved", "changes_requested", "not_submitted", "rejected", "under_review"].sort(),
    );
  });
});

import type { AppRole } from "@/lib/db/types";

/**
 * UI labels for each role. The DB enum keeps `manager` for stability (renaming
 * the enum value would require a schema migration + RLS helper renames), but
 * the UI surfaces it as "Admin" per current product naming.
 */
export const ROLE_LABEL: Record<AppRole, string> = {
  viewer: "Viewer",
  writer: "Writer",
  author: "Author",
  manager: "Admin",
};

export function roleLabel(role: AppRole | null | undefined): string {
  if (!role) return "—";
  return ROLE_LABEL[role];
}

export function canAuthor(role: AppRole | null | undefined) {
  return role === "author" || role === "manager";
}

export function isManager(role: AppRole | null | undefined) {
  return role === "manager";
}

/** Convenience alias — "admin" is the product term for manager. */
export const isAdmin = isManager;

/**
 * Anyone who can open the editor and create/edit their own posts: general
 * writers (any @convegenius.ai employee) plus the core team. Distinct from
 * `canAuthor` — writers are NOT authors and must go through review.
 */
export function canCreatePost(role: AppRole | null | undefined) {
  return role === "writer" || role === "author" || role === "manager";
}

/**
 * Can publish/schedule a post directly without admin review. Writers never can
 * — their posts always go through the review queue. (Core authors may still be
 * gated by the optional `require_manager_review` runtime flag, enforced in the
 * save action, not here.)
 */
export function canPublishDirectly(role: AppRole | null | undefined) {
  return role === "author" || role === "manager";
}

/** Can review submitted posts (approve / reject / request changes). */
export function canReview(role: AppRole | null | undefined) {
  return role === "manager";
}

/** A general writer (not a core author/manager/external viewer). */
export function isGeneralWriter(role: AppRole | null | undefined) {
  return role === "writer";
}

export function isValidDomain(email: string, allowedDomain: string) {
  const e = email.trim().toLowerCase();
  const d = allowedDomain.trim().toLowerCase();
  if (!e.includes("@") || !d) return false;
  return e.split("@")[1] === d;
}

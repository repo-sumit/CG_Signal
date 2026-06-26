// Pure collaboration permission logic + shared view types. NO server-only
// imports and NO database access here — this module is imported by client
// components (for the view types) AND by the unit tests (which run in jsdom),
// so it must stay side-effect free. All DB I/O lives in `lib/db/collaboration.ts`.

import type { AppRole, PostCollaboratorRole } from "@/lib/db/types";

/** Edit lock lifetime. A lock is "active" until `expires_at`. */
export const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** How often the holder refreshes the lock. Must be < LOCK_TTL_MS. */
export const LOCK_HEARTBEAT_MS = 60 * 1000; // 60 seconds

export type CollabRelationship = "owner" | "manager" | "editor" | "reviewer" | "none";

export interface PostAccess {
  /** The current user authored the post. */
  isOwner: boolean;
  /** The current user is an app-wide manager/admin. */
  isManager: boolean;
  /** The current user's per-post collaborator role, if any. */
  collaboratorRole: PostCollaboratorRole | null;
  relationship: CollabRelationship;
  /** May open the editor page at all. */
  canOpen: boolean;
  /** May change post content (owner, manager, or editor collaborator). */
  canEdit: boolean;
  /** May read + leave review comments. */
  canReview: boolean;
  /** Alias of canReview — kept for call-site readability. */
  canComment: boolean;
  /** May invite/remove collaborators + change their roles. */
  canManageCollaborators: boolean;
  /** May publish / schedule / archive / change status. */
  canPublish: boolean;
}

/**
 * Pure access resolver. Given who authored the post, who's asking, their
 * app-role, and their per-post collaborator role, return every permission the
 * UI and server actions need. The owner can't also be a collaborator (the
 * server prevents it), so `relationship` is unambiguous.
 */
export function deriveAccess(input: {
  authorId: string | null;
  userId: string;
  role: AppRole;
  collaboratorRole: PostCollaboratorRole | null;
}): PostAccess {
  const isManager = input.role === "manager";
  const isOwner = !!input.authorId && input.authorId === input.userId;
  const collaboratorRole = input.collaboratorRole;
  const isEditorCollab = collaboratorRole === "editor";
  const isReviewerCollab = collaboratorRole === "reviewer";

  const canOpen = isOwner || isManager || collaboratorRole !== null;
  const canEdit = isOwner || isManager || isEditorCollab;
  const canReview = canOpen;
  const canManageCollaborators = isOwner || isManager;
  const canPublish = isOwner || isManager;

  let relationship: CollabRelationship = "none";
  if (isOwner) relationship = "owner";
  else if (isManager) relationship = "manager";
  else if (isEditorCollab) relationship = "editor";
  else if (isReviewerCollab) relationship = "reviewer";

  return {
    isOwner,
    isManager,
    collaboratorRole,
    relationship,
    canOpen,
    canEdit,
    canReview,
    canComment: canReview,
    canManageCollaborators,
    canPublish,
  };
}

/** A lock is active when its expiry is in the future. */
export function isLockActive(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return !Number.isNaN(t) && t > nowMs;
}

export function isCollaboratorRole(role: string): role is PostCollaboratorRole {
  return role === "editor" || role === "reviewer";
}

export const COLLAB_ROLE_LABEL: Record<PostCollaboratorRole, string> = {
  editor: "Editor",
  reviewer: "Reviewer",
};

// ============================================================
// Shared view types — returned by lib/db/collaboration.ts and consumed by the
// editor UI. Defined here so client components can import the types without
// pulling in the server-only DB module.
// ============================================================

export interface CollaboratorView {
  userId: string;
  role: PostCollaboratorRole;
  name: string;
  email: string;
  avatarUrl: string | null;
  invitedBy: string | null;
}

export interface ReviewCommentView {
  id: string;
  userId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
}

export interface LockHolder {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface LockView {
  postId: string;
  lockedBy: LockHolder;
  lockedAt: string;
  expiresAt: string;
}

export interface ApprovedTeammate {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: AppRole;
}

/** A pending email invite (invitee hasn't logged in / accepted yet). */
export interface PendingInviteView {
  id: string;
  email: string;
  role: PostCollaboratorRole;
  createdAt: string;
}

export interface PostOwnerView {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface EditorUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

/** The full collaboration context the editor UI is initialised with. */
export interface EditorCollaborationProps {
  canEdit: boolean;
  relationship: CollabRelationship;
  isOwner: boolean;
  canManageCollaborators: boolean;
  currentUser: EditorUser;
  owner: PostOwnerView | null;
  collaborators: CollaboratorView[];
  reviewComments: ReviewCommentView[];
  approvedTeammates: ApprovedTeammate[];
  pendingInvites: PendingInviteView[];
  initialLock: LockView | null;
}

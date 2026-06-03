import { describe, it, expect } from "vitest";
import {
  deriveAccess,
  isLockActive,
  isCollaboratorRole,
  LOCK_TTL_MS,
  LOCK_HEARTBEAT_MS,
} from "@/lib/auth/collaboration";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("deriveAccess", () => {
  it("owner can edit, manage, publish, and open", () => {
    const a = deriveAccess({ authorId: OWNER, userId: OWNER, role: "author", collaboratorRole: null });
    expect(a.relationship).toBe("owner");
    expect(a.isOwner).toBe(true);
    expect(a.canOpen).toBe(true);
    expect(a.canEdit).toBe(true);
    expect(a.canManageCollaborators).toBe(true);
    expect(a.canPublish).toBe(true);
  });

  it("manager (not the author) can edit/manage/publish any post", () => {
    const a = deriveAccess({ authorId: OWNER, userId: OTHER, role: "manager", collaboratorRole: null });
    expect(a.relationship).toBe("manager");
    expect(a.isOwner).toBe(false);
    expect(a.canOpen).toBe(true);
    expect(a.canEdit).toBe(true);
    expect(a.canManageCollaborators).toBe(true);
    expect(a.canPublish).toBe(true);
  });

  it("editor collaborator can open + edit + comment but not manage/publish", () => {
    const a = deriveAccess({ authorId: OWNER, userId: OTHER, role: "author", collaboratorRole: "editor" });
    expect(a.relationship).toBe("editor");
    expect(a.canOpen).toBe(true);
    expect(a.canEdit).toBe(true);
    expect(a.canComment).toBe(true);
    expect(a.canManageCollaborators).toBe(false);
    expect(a.canPublish).toBe(false);
  });

  it("reviewer collaborator can open + comment but never edit/manage/publish", () => {
    const a = deriveAccess({ authorId: OWNER, userId: OTHER, role: "author", collaboratorRole: "reviewer" });
    expect(a.relationship).toBe("reviewer");
    expect(a.canOpen).toBe(true);
    expect(a.canReview).toBe(true);
    expect(a.canComment).toBe(true);
    expect(a.canEdit).toBe(false);
    expect(a.canManageCollaborators).toBe(false);
    expect(a.canPublish).toBe(false);
  });

  it("non-invited author cannot open the draft", () => {
    const a = deriveAccess({ authorId: OWNER, userId: OTHER, role: "author", collaboratorRole: null });
    expect(a.relationship).toBe("none");
    expect(a.canOpen).toBe(false);
    expect(a.canEdit).toBe(false);
    expect(a.canComment).toBe(false);
  });

  it("a missing post (null author) is not openable by a plain author", () => {
    const a = deriveAccess({ authorId: null, userId: OTHER, role: "author", collaboratorRole: null });
    expect(a.canOpen).toBe(false);
  });
});

describe("isLockActive", () => {
  const now = 1_700_000_000_000;
  it("is true when expiry is in the future", () => {
    expect(isLockActive(new Date(now + 60_000).toISOString(), now)).toBe(true);
  });
  it("is false when expiry is in the past", () => {
    expect(isLockActive(new Date(now - 1).toISOString(), now)).toBe(false);
  });
  it("is false for null/invalid", () => {
    expect(isLockActive(null, now)).toBe(false);
    expect(isLockActive(undefined, now)).toBe(false);
    expect(isLockActive("not-a-date", now)).toBe(false);
  });
});

describe("lock constants", () => {
  it("heartbeat fires well within the TTL window", () => {
    expect(LOCK_HEARTBEAT_MS).toBeLessThan(LOCK_TTL_MS);
    expect(LOCK_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe("isCollaboratorRole", () => {
  it("accepts editor + reviewer only", () => {
    expect(isCollaboratorRole("editor")).toBe(true);
    expect(isCollaboratorRole("reviewer")).toBe(true);
    expect(isCollaboratorRole("owner")).toBe(false);
    expect(isCollaboratorRole("viewer")).toBe(false);
  });
});

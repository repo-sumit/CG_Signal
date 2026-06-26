import { describe, it, expect } from "vitest";
import {
  canAuthor,
  canCreatePost,
  canPublishDirectly,
  canReview,
  isGeneralWriter,
  isManager,
  isValidDomain,
  roleLabel,
} from "@/lib/auth/roles";

describe("roles", () => {
  it("isValidDomain accepts case-insensitive", () => {
    expect(isValidDomain("Foo@ConveGenius.AI", "convegenius.ai")).toBe(true);
    expect(isValidDomain("foo@convegenius.ai", "convegenius.ai")).toBe(true);
  });
  it("isValidDomain rejects mismatches", () => {
    expect(isValidDomain("foo@gmail.com", "convegenius.ai")).toBe(false);
    expect(isValidDomain("foo@convegenius.com", "convegenius.ai")).toBe(false);
    expect(isValidDomain("", "convegenius.ai")).toBe(false);
    expect(isValidDomain("foo@", "convegenius.ai")).toBe(false);
  });
  it("canAuthor excludes the general writer tier", () => {
    expect(canAuthor("viewer")).toBe(false);
    expect(canAuthor("writer")).toBe(false);
    expect(canAuthor("author")).toBe(true);
    expect(canAuthor("manager")).toBe(true);
    expect(canAuthor(null)).toBe(false);
  });
  it("isManager", () => {
    expect(isManager("manager")).toBe(true);
    expect(isManager("author")).toBe(false);
    expect(isManager("writer")).toBe(false);
  });

  it("canCreatePost includes writers, authors, managers — not viewers", () => {
    expect(canCreatePost("viewer")).toBe(false);
    expect(canCreatePost("writer")).toBe(true);
    expect(canCreatePost("author")).toBe(true);
    expect(canCreatePost("manager")).toBe(true);
    expect(canCreatePost(null)).toBe(false);
  });

  it("canPublishDirectly excludes general writers", () => {
    expect(canPublishDirectly("writer")).toBe(false);
    expect(canPublishDirectly("author")).toBe(true);
    expect(canPublishDirectly("manager")).toBe(true);
    expect(canPublishDirectly("viewer")).toBe(false);
  });

  it("canReview is manager-only", () => {
    expect(canReview("manager")).toBe(true);
    expect(canReview("author")).toBe(false);
    expect(canReview("writer")).toBe(false);
    expect(canReview("viewer")).toBe(false);
  });

  it("isGeneralWriter", () => {
    expect(isGeneralWriter("writer")).toBe(true);
    expect(isGeneralWriter("author")).toBe(false);
    expect(isGeneralWriter("manager")).toBe(false);
  });

  it("roleLabel surfaces a label for every role", () => {
    expect(roleLabel("viewer")).toBe("Viewer");
    expect(roleLabel("writer")).toBe("Writer");
    expect(roleLabel("author")).toBe("Author");
    expect(roleLabel("manager")).toBe("Admin");
    expect(roleLabel(null)).toBe("—");
  });
});

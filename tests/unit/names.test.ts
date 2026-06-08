import { describe, it, expect } from "vitest";
import { getFirstName } from "@/lib/utils/names";

describe("getFirstName", () => {
  it("returns the first token of a full name", () => {
    expect(getFirstName("Sumit Kumar")).toBe("Sumit");
    expect(getFirstName("Om Kumar")).toBe("Om");
    expect(getFirstName("Insha Naseem")).toBe("Insha");
  });
  it("handles single names + extra whitespace", () => {
    expect(getFirstName("  Aryan  ")).toBe("Aryan");
    expect(getFirstName("Aditya   C")).toBe("Aditya");
  });
  it("falls back to CG for missing names (never an email)", () => {
    expect(getFirstName(null)).toBe("CG");
    expect(getFirstName(undefined)).toBe("CG");
    expect(getFirstName("")).toBe("CG");
    expect(getFirstName("   ")).toBe("CG");
  });
});

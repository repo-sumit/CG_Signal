// Playwright E2E — public post contributor byline.
// Run against a deployed/staging instance: `npx playwright test`.
// Requires AUTH_TEST_BASE_URL to point at a running app (Supabase configured)
// and CONTRIBUTORS_TEST_SLUG to name a PUBLISHED post that has multiple
// editor contributors (e.g. "decoding-claude"). Optionally set
// CONTRIBUTORS_TEST_NAMES to a comma-separated list of expected first names.
import { test, expect } from "@playwright/test";

const BASE = process.env.AUTH_TEST_BASE_URL ?? "http://localhost:3000";
const SLUG = process.env.CONTRIBUTORS_TEST_SLUG;
const NAMES = (process.env.CONTRIBUTORS_TEST_NAMES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

test.describe("public post contributors", () => {
  test.skip(!SLUG, "Set CONTRIBUTORS_TEST_SLUG to a multi-contributor published post.");

  test("shows all contributor first names in the byline", async ({ page }) => {
    await page.goto(`${BASE}/posts/${SLUG}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const header = page.locator("article").first();
    for (const name of NAMES) {
      await expect(header.getByText(name, { exact: false }).first()).toBeVisible();
    }
  });

  test("never exposes contributor email addresses publicly", async ({ page }) => {
    await page.goto(`${BASE}/posts/${SLUG}`);
    // The article header (byline) must not render any email address.
    const headerText = (await page.locator("article").first().innerText()) ?? "";
    expect(headerText).not.toMatch(/@convegenius\.ai/i);
  });

  test("byline does not overflow on a mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE}/posts/${SLUG}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // Allow a 2px rounding tolerance; anything larger means horizontal overflow.
    expect(overflow).toBeLessThanOrEqual(2);
  });

  test("renders contributor avatars or initials", async ({ page }) => {
    await page.goto(`${BASE}/posts/${SLUG}`);
    const header = page.locator("article").first();
    // Avatar renders as <img> (photo) or a <span aria-label> (initials fallback).
    const avatarCount = await header.locator("img, span[aria-label]").count();
    expect(avatarCount).toBeGreaterThan(0);
  });
});

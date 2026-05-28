import { NextResponse, type NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/guards";
import { loadUserActivity, resolveWindow, type WindowPresetId } from "@/lib/analytics/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS: WindowPresetId[] = ["24h", "7d", "30d", "all"];

/**
 * GET /api/admin/analytics/users?window=30d
 *
 * Manager-only. Returns the logged-in user activity rollup for the supplied
 * window (default 30 days). Used by the Users tab in the admin dashboard.
 */
export async function GET(request: NextRequest) {
  await requireManager();
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("window");
  const preset = (ALLOWED_WINDOWS as string[]).includes(raw ?? "") ? (raw as WindowPresetId) : "30d";
  const window = resolveWindow(preset);
  const rows = await loadUserActivity(window);
  return NextResponse.json({ ok: true, window: window.label, users: rows });
}

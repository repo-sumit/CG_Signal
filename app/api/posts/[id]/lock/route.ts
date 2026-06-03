import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getActiveLock } from "@/lib/db/collaboration";
import { getLockActor } from "@/lib/api/edit-lock";
import { LOCK_TTL_MS } from "@/lib/auth/collaboration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/posts/[id]/lock — acquire (or refresh) the edit lock.
 *
 *  - No lock / expired lock      → acquire (replace).
 *  - Lock already held by caller → refresh.
 *  - Active lock held by another → 409 with the holder's identity.
 */
export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const parsed = ParamsSchema.safeParse(await props.params);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid post id" }, { status: 400 });
  }
  const postId = parsed.data.id;

  const actor = await getLockActor(postId);
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!actor.postExists) return NextResponse.json({ ok: false, error: "Post not found" }, { status: 404 });
  if (!actor.canEdit) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const service = createSupabaseServiceClient();
  const current = await getActiveLock(service, postId);
  if (current && current.lockedBy.id !== actor.userId) {
    return NextResponse.json(
      { ok: false, lockedBy: current.lockedBy, expiresAt: current.expiresAt },
      { status: 409 },
    );
  }

  const now = Date.now();
  const lockedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + LOCK_TTL_MS).toISOString();
  const { error } = await service
    .from("post_edit_locks")
    .upsert(
      { post_id: postId, locked_by: actor.userId, locked_at: lockedAt, expires_at: expiresAt },
      { onConflict: "post_id" },
    );
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    lockedBy: { id: actor.userId, name: actor.name, avatarUrl: actor.avatarUrl },
    expiresAt,
  });
}

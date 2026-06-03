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
 * POST /api/posts/[id]/lock/heartbeat — extend the caller's lock by another
 * TTL window. Only the current holder may extend; if the lock was lost to
 * someone else (or expired and re-taken), respond 409 with the new holder so
 * the client can drop into read-only.
 */
export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const parsed = ParamsSchema.safeParse(await props.params);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid post id" }, { status: 400 });
  }
  const postId = parsed.data.id;

  const actor = await getLockActor(postId);
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!actor.canEdit) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

  const service = createSupabaseServiceClient();
  const current = await getActiveLock(service, postId);
  if (!current || current.lockedBy.id !== actor.userId) {
    return NextResponse.json(
      { ok: false, lockedBy: current?.lockedBy ?? null, expiresAt: current?.expiresAt ?? null },
      { status: 409 },
    );
  }

  const expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  const { error } = await service
    .from("post_edit_locks")
    .update({ expires_at: expiresAt })
    .eq("post_id", postId)
    .eq("locked_by", actor.userId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    lockedBy: { id: actor.userId, name: actor.name, avatarUrl: actor.avatarUrl },
    expiresAt,
  });
}

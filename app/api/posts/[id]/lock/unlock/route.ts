import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getLockActor } from "@/lib/api/edit-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/posts/[id]/lock/unlock — release the edit lock.
 *
 *  - The current lock holder may release their own lock.
 *  - A manager OR the post owner may force-release anyone's lock ("take over").
 *  - Already unlocked → silently succeeds.
 */
export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const parsed = ParamsSchema.safeParse(await props.params);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid post id" }, { status: 400 });
  }
  const postId = parsed.data.id;

  const actor = await getLockActor(postId);
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  const service = createSupabaseServiceClient();
  const { data: lockRow } = await service
    .from("post_edit_locks")
    .select("locked_by")
    .eq("post_id", postId)
    .maybeSingle();
  const lock = lockRow as { locked_by: string } | null;

  // Already unlocked — nothing to do.
  if (!lock) return NextResponse.json({ ok: true });

  const isHolder = lock.locked_by === actor.userId;
  if (!isHolder && !actor.isManager && !actor.isOwner) {
    return NextResponse.json({ ok: false, error: "You can't release this lock." }, { status: 403 });
  }

  const { error } = await service.from("post_edit_locks").delete().eq("post_id", postId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

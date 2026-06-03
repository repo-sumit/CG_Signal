import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePostAccess } from "@/lib/db/collaboration";
import type { AppRole } from "@/lib/db/types";

/**
 * Authenticated actor + their permission to touch a post's edit lock. Returns
 * null when the request is unauthenticated. `canEdit` gates acquire/heartbeat;
 * unlock additionally accepts the lock owner / post owner / manager.
 */
export interface LockActor {
  userId: string;
  role: AppRole;
  name: string;
  avatarUrl: string | null;
  canEdit: boolean;
  isManager: boolean;
  isOwner: boolean;
  postExists: boolean;
}

export async function getLockActor(postId: string): Promise<LockActor | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, full_name, avatar_url, email")
    .eq("id", user.id)
    .maybeSingle();
  const profile = profileRow as
    | { role?: AppRole; full_name?: string | null; avatar_url?: string | null; email?: string | null }
    | null;
  const role = profile?.role;
  if (!role) return null;

  const { access, post } = await resolvePostAccess(supabase, postId, user.id, role);
  return {
    userId: user.id,
    role,
    name: (profile?.full_name && profile.full_name.trim()) || profile?.email || "Someone",
    avatarUrl: profile?.avatar_url ?? null,
    canEdit: access.canEdit,
    isManager: access.isManager,
    isOwner: access.isOwner,
    postExists: post !== null,
  };
}

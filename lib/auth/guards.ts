import "server-only";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/db/types";
import { isViewModeActive } from "@/lib/auth/viewMode";

export interface SessionContext {
  userId: string;
  email: string;
  profile: ProfileRow;
}

export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;

  return {
    userId: user.id,
    email: (user.email ?? "").toLowerCase(),
    profile: profile as unknown as ProfileRow,
  };
}

export async function requireSession(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/**
 * Require an author/admin actor (approved core editor). Non-core editors
 * (including general writers and external Gmail commenters) are sent to
 * /unauthorized. While View Mode is active, editors are sent to /dashboard so
 * the viewer simulation is consistent.
 *
 * NOTE: most editor routes now use {@link requireWriter} so general writers can
 * create + submit posts. Reserve `requireAuthor` for surfaces that are truly
 * core-author-only.
 */
export async function requireAuthor(): Promise<SessionContext> {
  const ctx = await requireSession();
  if (await isViewModeActive()) redirect("/dashboard");
  if (ctx.profile.role !== "author" && ctx.profile.role !== "manager") {
    redirect("/unauthorized?reason=editor");
  }
  return ctx;
}

/**
 * Require an actor who can author posts: a general writer (any @convegenius.ai
 * employee) OR a core author/admin. External Gmail commenters are sent to
 * /unauthorized. This is the guard for the editor + "my posts" surfaces; the
 * publish/review gating is enforced per-action by role, not here.
 */
export async function requireWriter(): Promise<SessionContext> {
  const ctx = await requireSession();
  if (await isViewModeActive()) redirect("/dashboard");
  const role = ctx.profile.role;
  if (role !== "writer" && role !== "author" && role !== "manager") {
    redirect("/unauthorized?reason=editor");
  }
  return ctx;
}

/** Require an admin actor. Non-admins bounced to /unauthorized. */
export async function requireManager(): Promise<SessionContext> {
  const ctx = await requireSession();
  if (await isViewModeActive()) redirect("/dashboard");
  if (ctx.profile.role !== "manager") {
    redirect("/unauthorized?reason=editor");
  }
  return ctx;
}

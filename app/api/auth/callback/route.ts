import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/env";
import { safeRedirectPath } from "@/lib/auth/safeRedirect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // SECURITY: any same-origin path is fine; anything else falls back. Without
  // this, an attacker could craft /login?redirect=https://evil.example.com to
  // turn our auth flow into an open redirect (classic phishing pivot).
  const redirectPath = safeRedirectPath(url.searchParams.get("redirect"), "/dashboard");
  const supabase = await createSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const dest = new URL("/login", url.origin);
      dest.searchParams.set("error", error.message);
      return NextResponse.redirect(dest);
    }
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const email = user.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  const env = serverEnv();
  // Any Google account is allowed to sign in — they need a session to
  // comment and react. Whether they're an APPROVED EDITOR is a separate
  // check enforced by the route-level guards (requireAuthor / requireManager).
  const isInternalDomain = domain === env.allowedDomain;

  // Bootstrap (or refresh) the profile. The DB function reads the allowlist;
  // also reconcile env-driven manager/author overrides so a fresh setup works
  // without having to seed authorized_users by hand.
  try {
    const service = createSupabaseServiceClient();

    // Only reconcile the authorized-users allowlist when the signed-in account
    // is from the internal domain — Gmail/external accounts are commenters,
    // never editors, so they don't belong in the allowlist.
    if (isInternalDomain && env.managerEmails.length > 0) {
      await service
        .from("authorized_users")
        .upsert(
          env.managerEmails.map((email) => ({ email, role: "manager" as const })),
          { onConflict: "email" },
        );
    }
    const managerSet = new Set(env.managerEmails);
    const authorEmailsToSeed = env.authorEmails.filter((a) => !managerSet.has(a));
    if (isInternalDomain && authorEmailsToSeed.length > 0) {
      await service
        .from("authorized_users")
        .upsert(
          authorEmailsToSeed.map((email) => ({ email, role: "author" as const })),
          { onConflict: "email", ignoreDuplicates: true },
        );
    }

    // External (Gmail/etc.) sessions are always viewers — they can comment +
    // react but not access editor/admin. Internal-domain users default to
    // `writer` (any ConveGenius employee can create posts + submit for review),
    // and get a higher role if the allowlist grants one.
    type Role = "manager" | "author" | "writer" | "viewer";
    let role: Role = "viewer";
    let weekday: number | null = null;
    if (isInternalDomain) {
      const { data: allow } = await service
        .from("authorized_users")
        .select("role, weekly_post_day")
        .eq("email", email)
        .maybeSingle();
      role = (allow?.role as Role | undefined) ?? "writer";
      weekday = (allow?.weekly_post_day as number | null | undefined) ?? null;

      // Never downgrade an already-elevated user. If a profile is already
      // author/manager but the allowlist no longer lists them (e.g. env vars
      // changed), keep their elevated role rather than dropping to writer.
      const { data: existingProfile } = await service
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      const existingRole = (existingProfile?.role as Role | undefined) ?? null;
      if ((existingRole === "manager" || existingRole === "author") && role === "writer") {
        role = existingRole;
      }
    }

    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const fullName =
      (meta.full_name as string | undefined) ||
      (meta.name as string | undefined) ||
      email.split("@")[0];
    const avatarUrl =
      (meta.avatar_url as string | undefined) || (meta.picture as string | undefined) || null;

    await service.from("profiles").upsert(
      {
        id: user.id,
        email,
        full_name: fullName,
        avatar_url: avatarUrl,
        role,
        weekly_post_day: weekday,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  } catch (err) {
    console.error("[auth/callback] bootstrap failed", err);
    const dest = new URL("/login", url.origin);
    dest.searchParams.set("error", "Profile bootstrap failed. Contact your admin.");
    return NextResponse.redirect(dest);
  }

  // External (commenter) sessions should never land on a protected dashboard.
  // Honor `?redirect=` only if it's a public path or the post they came from.
  const PUBLIC_REDIRECT_RE = /^\/(?:$|posts\/|login|unauthorized)/;
  const finalRedirect = isInternalDomain
    ? redirectPath
    : PUBLIC_REDIRECT_RE.test(redirectPath)
      ? redirectPath
      : "/";
  return NextResponse.redirect(new URL(finalRedirect, url.origin));
}

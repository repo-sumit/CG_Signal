import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { serverEnv, publicEnv } from "@/lib/env";
import { safeRedirectPath } from "@/lib/auth/safeRedirect";
import { activatePendingInvites } from "@/lib/db/collaboration";
import { sendEmail } from "@/lib/email/resend";
import { welcomeTemplate } from "@/lib/email/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Auto-subscribe a user to the newsletter on login and send the welcome email
 * exactly once. Best-effort — callers must not let this block sign-in.
 *
 * - New email → insert an active subscription (source=login_auto_subscribe).
 * - Existing + active → link the user_id; send welcome only if never sent.
 * - Existing + unsubscribed → respect their choice; never silently resubscribe.
 *
 * The welcome send is claimed by stamping welcome_sent_at FIRST (conditional
 * update) so concurrent logins can't double-send.
 */
async function autoSubscribeOnLogin(
  service: SupabaseClient,
  userId: string,
  email: string,
): Promise<void> {
  type SubRow = { id: string; unsubscribed_at: string | null; welcome_sent_at: string | null };
  const { data: existing } = await service
    .from("subscribers")
    .select("id, unsubscribed_at, welcome_sent_at")
    .ilike("email", email)
    .maybeSingle();
  let row = existing as SubRow | null;

  if (!row) {
    const { data: inserted, error } = await service
      .from("subscribers")
      .insert({ email, user_id: userId, source: "login_auto_subscribe" })
      .select("id, unsubscribed_at, welcome_sent_at")
      .single();
    if (error || !inserted) return;
    row = inserted as SubRow;
  } else {
    // Link the signed-in user without disturbing their subscription state.
    await service.from("subscribers").update({ user_id: userId }).eq("id", row.id).is("user_id", null);
  }
  if (!row || row.unsubscribed_at || row.welcome_sent_at) return;

  // Claim the welcome send (idempotent across concurrent logins).
  const { data: claimed } = await service
    .from("subscribers")
    .update({ welcome_sent_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("welcome_sent_at", null)
    .select("unsubscribe_token");
  const token = (claimed?.[0] as { unsubscribe_token?: string } | undefined)?.unsubscribe_token;
  if (!token) return;

  const unsubscribeUrl = `${publicEnv.appUrl}/api/subscribe/unsubscribe?t=${token}`;
  const tpl = welcomeTemplate({ appUrl: publicEnv.appUrl, unsubscribeUrl });
  const res = await sendEmail({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  if (!res.ok) console.error("[auth/callback] welcome email failed", res.error);
}

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

  // Post-login side tasks — best-effort, never block sign-in:
  //   1. Activate any pending collaborator invites addressed to this email.
  //   2. Auto-subscribe to the newsletter (+ one-time welcome email).
  try {
    const service = createSupabaseServiceClient();
    await activatePendingInvites(service, user.id, email);
    await autoSubscribeOnLogin(service, user.id, email);
  } catch (err) {
    console.error("[auth/callback] post-login tasks failed", err);
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

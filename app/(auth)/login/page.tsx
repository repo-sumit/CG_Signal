import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/guards";
import { safeRedirectPath } from "@/lib/auth/safeRedirect";
import LoginForm from "@/components/auth/LoginForm";
import { BrandLockup } from "@/components/portal/BrandLockup";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(
  props: {
    searchParams: Promise<{ redirect?: string; error?: string; code?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const safeRedirect = safeRedirectPath(searchParams.redirect, "/dashboard");
  if (searchParams.code) {
    const params = new URLSearchParams({ code: searchParams.code, redirect: safeRedirect });
    redirect(`/api/auth/callback?${params.toString()}`);
  }
  const ctx = await getSessionContext();
  if (ctx) redirect(safeRedirect);

  return (
    <main className="relative min-h-screen">
      <div className="content-container relative flex min-h-screen flex-col justify-center py-10">
        <div className="mx-auto grid w-full max-w-5xl gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          {/* Brand zone */}
          <div className="flex flex-col gap-6">
            <BrandLockup size="lg" />
            <div className="space-y-4">
              <h1 className="font-hero text-4xl font-bold uppercase leading-tight tracking-tighter text-portal-text sm:text-5xl lg:text-6xl">
                The team
                <br />
                signal portal.
              </h1>
              <p className="max-w-md text-base leading-relaxed text-portal-text-muted">
                Daily transmissions from across ConveGenius. Sign in with your workspace email to
                read the signal feed and broadcast your own.
              </p>
            </div>
            <div className="text-[11px] uppercase tracking-wider text-portal-text-muted">
              Domain locked · convegenius.ai
            </div>
          </div>

          {/* Sign-in card */}
          <LoginForm redirectTo={safeRedirect} initialError={searchParams.error} />
        </div>

        <div className="mt-10 text-center text-[11px] uppercase tracking-wider text-portal-text-muted">
          CG Signal · Internal Blog OS
        </div>
      </div>
    </main>
  );
}

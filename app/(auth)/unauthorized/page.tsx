import type { Metadata } from "next";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel, PanelBody } from "@/components/portal/Panel";

export const metadata: Metadata = { title: "Access denied" };

const ALLOWED_DOMAIN = process.env.APP_ALLOWED_EMAIL_DOMAIN ?? "convegenius.ai";

export default async function UnauthorizedPage(
  props: {
    searchParams: Promise<{ reason?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const reason = searchParams.reason;
  const isEditorBlock = reason === "editor";

  return (
    <main className="min-h-screen">
      <div className="content-container flex min-h-screen items-center">
        <Panel variant="bright" className="mx-auto w-full max-w-lg">
          <PanelBody className="space-y-5 p-10 text-center">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-portal-yellow/40 bg-portal-yellow/10 text-portal-yellow">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="font-hero text-3xl font-bold uppercase tracking-tighter text-portal-text">
              {isEditorBlock
                ? "Posting is ConveGenius-only"
                : reason === "domain"
                  ? "Sign-in not allowed"
                  : "Access restricted"}
            </h1>
            <p className="text-sm leading-relaxed text-portal-text-muted">
              {isEditorBlock
                ? `You're signed in, but only @${ALLOWED_DOMAIN} accounts can create posts. You can keep reading and join the discussion — or switch to your ConveGenius account to post.`
                : reason === "domain"
                  ? `CG Signal is limited to @${ALLOWED_DOMAIN} accounts. Sign in with your ConveGenius workspace email to continue.`
                  : "Your account does not have access to this area."}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <Button asChild>
                <Link href="/">Continue reading</Link>
              </Button>
              {isEditorBlock ? (
                // The visitor is signed in with a non-ConveGenius account — let
                // them swap to a workspace account (sign out → /login) to post.
                <form action="/api/auth/signout" method="post">
                  <Button type="submit" variant="outline">
                    Switch to a ConveGenius account
                  </Button>
                </form>
              ) : (
                <Button asChild variant="outline">
                  <Link href="/login">Back to sign in</Link>
                </Button>
              )}
            </div>
          </PanelBody>
        </Panel>
      </div>
    </main>
  );
}

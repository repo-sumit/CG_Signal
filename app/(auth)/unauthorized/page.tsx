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
      <div className="container mx-auto flex min-h-screen items-center px-4">
        <Panel variant="bright" className="mx-auto w-full max-w-lg">
          <PanelBody className="space-y-5 p-10 text-center">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-portal-yellow/40 bg-portal-yellow/10 text-portal-yellow">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <h1 className="font-hero text-3xl font-bold uppercase tracking-tighter text-portal-text">
              {isEditorBlock ? "No editor access" : "Access restricted"}
            </h1>
            <p className="text-sm leading-relaxed text-portal-text-muted">
              {isEditorBlock
                ? `Sorry, you don't have posting access. Use a @${ALLOWED_DOMAIN} email account to create posts. You can still read posts and join the discussion.`
                : reason === "domain"
                  ? `This area is limited to @${ALLOWED_DOMAIN} accounts. Sign in with your workspace email.`
                  : "Your account does not have access to this area."}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <Button asChild>
                <Link href="/">Continue reading</Link>
              </Button>
              {!isEditorBlock && (
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

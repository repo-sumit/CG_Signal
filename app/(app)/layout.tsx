import { Suspense } from "react";
import { requireSession } from "@/lib/auth/guards";
import { isViewModeActive, effectiveRole } from "@/lib/auth/viewMode";
import { TopNav } from "@/components/layout/TopNav";
import { PortalFooter } from "@/components/layout/PortalFooter";
import { ViewModeBanner } from "@/components/layout/ViewModeBanner";
import { AnalyticsTracker } from "@/components/analytics/AnalyticsTracker";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const viewModeActive = await isViewModeActive();
  const role = await effectiveRole(session.profile.role);

  return (
    <div className="flex min-h-screen flex-col">
      {viewModeActive && <ViewModeBanner />}
      <TopNav profile={session.profile} effectiveRole={role} viewModeActive={viewModeActive} />
      <main className="flex-1">{children}</main>
      <PortalFooter />
      {/* Page-view tracker — Suspense boundary required because the tracker
          uses useSearchParams under the hood. */}
      <Suspense fallback={null}>
        <AnalyticsTracker isLoggedIn={true} />
      </Suspense>
    </div>
  );
}

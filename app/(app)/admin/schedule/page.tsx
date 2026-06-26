import type { Metadata } from "next";
import { requireManager } from "@/lib/auth/guards";
import { listTeam } from "@/lib/db/profiles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { ScheduleEditor } from "@/components/admin/ScheduleEditor";

export const metadata: Metadata = { title: "Schedule" };
export const dynamic = "force-dynamic";

export default async function SchedulePage() {
  await requireManager();
  const team = await listTeam();
  return (
    <main className="content-container max-w-3xl py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Weekly schedule</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Assign each team member a posting weekday. Saturday and Sunday are intentionally excluded.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleEditor team={team} />
        </CardContent>
      </Card>
    </main>
  );
}

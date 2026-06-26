import type { Metadata } from "next";
import { requireManager } from "@/lib/auth/guards";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { UsersAdmin } from "@/components/admin/UsersAdmin";
import type { AuthorizedUserRow, ProfileRow } from "@/lib/db/types";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requireManager();
  const supabase = await createSupabaseServerClient();
  const [{ data: allow }, { data: profiles }] = await Promise.all([
    supabase.from("authorized_users").select("*").order("email"),
    supabase.from("profiles").select("*").order("created_at", { ascending: false }),
  ]);
  return (
    <main className="content-container py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Users & allowlist</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Access is controlled by explicit email allowlist. Domain alone does not grant author/manager rights.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Allowlist</CardTitle>
        </CardHeader>
        <CardContent>
          <UsersAdmin
            allow={(allow ?? []) as unknown as AuthorizedUserRow[]}
            profiles={(profiles ?? []) as unknown as ProfileRow[]}
          />
        </CardContent>
      </Card>
    </main>
  );
}

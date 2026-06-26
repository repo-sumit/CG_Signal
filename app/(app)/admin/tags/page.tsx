import type { Metadata } from "next";
import { requireManager } from "@/lib/auth/guards";
import { listTags } from "@/lib/db/tags";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { TagsAdmin } from "@/components/admin/TagsAdmin";

export const metadata: Metadata = { title: "Tags" };
export const dynamic = "force-dynamic";

export default async function TagsPage() {
  await requireManager();
  const tags = await listTags();
  return (
    <main className="content-container max-w-3xl py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Tags</h1>
      <p className="mb-6 text-sm text-muted-foreground">Create or remove tags for posts.</p>
      <Card>
        <CardHeader>
          <CardTitle>All tags</CardTitle>
        </CardHeader>
        <CardContent>
          <TagsAdmin tags={tags} />
        </CardContent>
      </Card>
    </main>
  );
}

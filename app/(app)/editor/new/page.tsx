import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireWriter } from "@/lib/auth/guards";
import { listTags } from "@/lib/db/tags";
import { PostEditor } from "@/components/editor/PostEditorLoader";
import { WEEKLY_TEMPLATE } from "@/lib/editor/template";
import { publicEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { weekStartISO } from "@/lib/utils/dates";

export const metadata: Metadata = { title: "New post" };
export const dynamic = "force-dynamic";

export default async function NewEditorPage(
  props: {
    searchParams: Promise<{ force?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const { profile, userId } = await requireWriter();

  // Avoid accidentally creating a second draft for the same week. If one exists,
  // route the author to it. Override with /editor/new?force=1.
  if (searchParams.force !== "1") {
    const supabase = await createSupabaseServerClient();
    const { data: existing } = await supabase
      .from("posts")
      .select("id")
      .eq("author_id", userId)
      .eq("week_start_date", weekStartISO())
      .in("status", ["draft", "submitted"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      redirect(`/editor/${(existing as { id: string }).id}`);
    }
  }

  const tags = await listTags();
  const currentUser = {
    id: userId,
    name: (profile.full_name && profile.full_name.trim()) || profile.email,
    email: profile.email,
    avatarUrl: profile.avatar_url,
  };
  return (
    <PostEditor
      tags={tags}
      role={profile.role}
      requireReview={publicEnv.requireManagerReview}
      initialPost={{
        title: "",
        content_json: WEEKLY_TEMPLATE,
        status: "draft",
      }}
      collaboration={{
        // A brand-new post is owned by its creator. Collaborator management +
        // review comments unlock once the draft has been saved (so it has an id).
        canEdit: true,
        relationship: "owner",
        isOwner: true,
        canManageCollaborators: true,
        currentUser,
        owner: currentUser,
        collaborators: [],
        reviewComments: [],
        approvedTeammates: [],
        initialLock: null,
      }}
    />
  );
}

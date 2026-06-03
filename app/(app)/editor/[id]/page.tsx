import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireAuthor } from "@/lib/auth/guards";
import { listTags } from "@/lib/db/tags";
import { getPostById } from "@/lib/db/posts";
import { getCollaboratorRole, loadEditorCollaboration } from "@/lib/db/collaboration";
import { deriveAccess, type PostOwnerView } from "@/lib/auth/collaboration";
import { PostEditor } from "@/components/editor/PostEditorLoader";
import { publicEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit post" };
export const dynamic = "force-dynamic";

export default async function EditPostPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { profile, userId } = await requireAuthor();

  // getPostById is RLS-scoped: collaborators can now read drafts they're
  // invited to, so a null result means "not found OR no access" → notFound.
  const [post, tags] = await Promise.all([getPostById(params.id), listTags()]);
  if (!post) notFound();

  const supabase = await createSupabaseServerClient();
  const collaboratorRole = await getCollaboratorRole(supabase, post.id, userId);
  const access = deriveAccess({
    authorId: post.author_id,
    userId,
    role: profile.role,
    collaboratorRole,
  });
  if (!access.canOpen) {
    redirect("/me/posts");
  }

  const collaboration = await loadEditorCollaboration(post.id, {
    canManageCollaborators: access.canManageCollaborators,
  });

  // Resolve the cover asset's storage path so the editor can render a preview
  // without an extra client fetch. media_assets RLS now lets collaborators read
  // a shared draft's media, so this works for editors/reviewers too.
  let cover: { id: string; url: string } | null = null;
  if (post.cover_media_id) {
    const { data } = await supabase
      .from("media_assets")
      .select("id, storage_path")
      .eq("id", post.cover_media_id)
      .maybeSingle();
    const path = (data as { storage_path?: string | null } | null)?.storage_path;
    if (path) {
      cover = { id: post.cover_media_id, url: `/api/media/file?path=${encodeURIComponent(path)}` };
    }
  }

  const owner: PostOwnerView | null = post.author
    ? {
        id: post.author.id,
        name: (post.author.full_name && post.author.full_name.trim()) || post.author.email,
        email: post.author.email,
        avatarUrl: post.author.avatar_url,
      }
    : null;

  return (
    <PostEditor
      role={profile.role}
      tags={tags}
      requireReview={publicEnv.requireManagerReview}
      initialPost={{
        ...post,
        tag_ids: post.tags.map((t) => t.id),
        cover,
      }}
      collaboration={{
        canEdit: access.canEdit,
        relationship: access.relationship,
        isOwner: access.isOwner,
        canManageCollaborators: access.canManageCollaborators,
        currentUser: {
          id: userId,
          name: (profile.full_name && profile.full_name.trim()) || profile.email,
          email: profile.email,
          avatarUrl: profile.avatar_url,
        },
        owner,
        collaborators: collaboration.collaborators,
        reviewComments: collaboration.reviewComments,
        approvedTeammates: collaboration.approvedTeammates,
        initialLock: collaboration.lock,
      }}
    />
  );
}

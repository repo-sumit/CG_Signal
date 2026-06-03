"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, X, Users, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Select } from "@/components/ui/Select";
import {
  inviteCollaborator,
  removeCollaborator,
  updateCollaboratorRole,
} from "@/app/(app)/editor/actions";
import { COLLAB_ROLE_LABEL } from "@/lib/auth/collaboration";
import type {
  ApprovedTeammate,
  CollaboratorView,
  PostOwnerView,
} from "@/lib/auth/collaboration";
import type { PostCollaboratorRole } from "@/lib/db/types";

interface Props {
  postId?: string;
  canManage: boolean;
  owner: PostOwnerView | null;
  currentUserId: string;
  collaborators: CollaboratorView[];
  approvedTeammates: ApprovedTeammate[];
}

function RoleBadge({ role }: { role: PostCollaboratorRole | "owner" }) {
  if (role === "owner") return <Badge variant="blue">Owner</Badge>;
  return (
    <Badge variant={role === "editor" ? "default" : "secondary"}>{COLLAB_ROLE_LABEL[role]}</Badge>
  );
}

export function CollaboratorsPanel({
  postId,
  canManage,
  owner,
  currentUserId,
  collaborators,
  approvedTeammates,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inviteeId, setInviteeId] = useState("");
  const [inviteRole, setInviteRole] = useState<PostCollaboratorRole>("editor");

  // Eligible invitees = approved teammates who aren't the owner, an existing
  // collaborator, or the current user.
  const eligible = useMemo(() => {
    const taken = new Set<string>([
      ...(owner ? [owner.id] : []),
      currentUserId,
      ...collaborators.map((c) => c.userId),
    ]);
    return approvedTeammates.filter((t) => !taken.has(t.id));
  }, [approvedTeammates, collaborators, owner, currentUserId]);

  const handleInvite = () => {
    if (!postId || !inviteeId) return;
    startTransition(async () => {
      const res = await inviteCollaborator({ postId, userId: inviteeId, role: inviteRole });
      if (!res.ok) {
        toast.error(res.error || "Could not invite teammate.");
        return;
      }
      toast.success("Collaborator added.");
      setInviteeId("");
      router.refresh();
    });
  };

  const handleRemove = (userId: string, name: string) => {
    if (!postId) return;
    startTransition(async () => {
      const res = await removeCollaborator({ postId, userId });
      if (!res.ok) {
        toast.error(res.error || "Could not remove collaborator.");
        return;
      }
      toast.success(`Removed ${name}.`);
      router.refresh();
    });
  };

  const handleRoleChange = (userId: string, role: PostCollaboratorRole) => {
    if (!postId) return;
    startTransition(async () => {
      const res = await updateCollaboratorRole({ postId, userId, role });
      if (!res.ok) {
        toast.error(res.error || "Could not update role.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Users className="h-4 w-4" /> Collaborators
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* Owner */}
        {owner && (
          <div className="flex items-center gap-2">
            <Avatar src={owner.avatarUrl} name={owner.name} email={owner.email} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-ui text-portal-text">{owner.name}</div>
            </div>
            <RoleBadge role="owner" />
          </div>
        )}

        {/* Collaborators */}
        {collaborators.length === 0 ? (
          <p className="text-xs leading-relaxed text-portal-text-muted">
            No collaborators yet.
            <br />
            Invite a teammate to review or co-write this signal.
          </p>
        ) : (
          <ul className="space-y-2">
            {collaborators.map((c) => (
              <li key={c.userId} className="flex items-center gap-2">
                <Avatar src={c.avatarUrl} name={c.name} email={c.email} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-ui text-portal-text">{c.name}</div>
                </div>
                {canManage && postId ? (
                  <>
                    <Select
                      value={c.role}
                      onChange={(e) =>
                        handleRoleChange(c.userId, e.target.value as PostCollaboratorRole)
                      }
                      disabled={pending}
                      aria-label={`Role for ${c.name}`}
                      className="h-8 w-[7.5rem] rounded-md px-2 text-xs"
                    >
                      <option value="editor">Editor</option>
                      <option value="reviewer">Reviewer</option>
                    </Select>
                    <button
                      type="button"
                      onClick={() => handleRemove(c.userId, c.name)}
                      disabled={pending}
                      aria-label={`Remove ${c.name}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-portal-text-muted hover:bg-portal-panel-soft hover:text-portal-red disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <RoleBadge role={c.role} />
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Invite form */}
        {canManage &&
          (!postId ? (
            <p className="rounded-md border border-dashed border-portal-border-soft bg-portal-panel-soft p-2.5 text-[11px] leading-relaxed text-portal-text-muted">
              Save your draft first — then you can invite teammates to collaborate.
            </p>
          ) : (
            <div className="space-y-2 border-t border-portal-border-soft pt-3">
              <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                Invite a teammate
              </div>
              {eligible.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-portal-text-muted">
                  Everyone on the team is already on this post.
                </p>
              ) : (
                <>
                  <Select
                    value={inviteeId}
                    onChange={(e) => setInviteeId(e.target.value)}
                    disabled={pending}
                    aria-label="Choose a teammate to invite"
                    className="h-9 text-xs"
                  >
                    <option value="">Choose a teammate…</option>
                    {eligible.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                  <div className="flex items-center gap-2">
                    <Select
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as PostCollaboratorRole)}
                      disabled={pending}
                      aria-label="Collaborator role"
                      className="h-9 flex-1 text-xs"
                    >
                      <option value="editor">Editor</option>
                      <option value="reviewer">Reviewer</option>
                    </Select>
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleInvite}
                      disabled={pending || !inviteeId}
                    >
                      {pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <UserPlus className="h-3.5 w-3.5" />
                      )}
                      Invite
                    </Button>
                  </div>
                  <p className="text-[10px] leading-relaxed text-portal-text-muted">
                    Editors can co-write when they hold the edit lock. Reviewers can only leave
                    comments.
                  </p>
                </>
              )}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

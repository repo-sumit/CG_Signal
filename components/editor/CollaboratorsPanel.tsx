"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, X, Users, Loader2, Mail, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import {
  inviteCollaborator,
  inviteCollaboratorByEmail,
  cancelPendingInvite,
  removeCollaborator,
  updateCollaboratorRole,
} from "@/app/(app)/editor/actions";
import { COLLAB_ROLE_LABEL } from "@/lib/auth/collaboration";
import type {
  ApprovedTeammate,
  CollaboratorView,
  PendingInviteView,
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
  pendingInvites: PendingInviteView[];
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
  pendingInvites,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [inviteeId, setInviteeId] = useState("");
  const [inviteRole, setInviteRole] = useState<PostCollaboratorRole>("editor");
  const [search, setSearch] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");

  // Eligible invitees = any invitable ConveGenius user who isn't the owner, an
  // existing collaborator, or the current user.
  const eligible = useMemo(() => {
    const taken = new Set<string>([
      ...(owner ? [owner.id] : []),
      currentUserId,
      ...collaborators.map((c) => c.userId),
    ]);
    return approvedTeammates.filter((t) => !taken.has(t.id));
  }, [approvedTeammates, collaborators, owner, currentUserId]);

  // Search filters by name OR email so a big team list stays usable.
  const filteredEligible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter(
      (t) => t.name.toLowerCase().includes(q) || t.email.toLowerCase().includes(q),
    );
  }, [eligible, search]);

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
      setSearch("");
      router.refresh();
    });
  };

  const handleInviteByEmail = () => {
    if (!postId || !inviteEmail.trim()) return;
    startTransition(async () => {
      const res = await inviteCollaboratorByEmail({
        postId,
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      if (!res.ok) {
        toast.error(res.error || "Could not send invite.");
        return;
      }
      toast.success("Invite sent.");
      setInviteEmail("");
      router.refresh();
    });
  };

  const handleCancelInvite = (inviteId: string, email: string) => {
    if (!postId) return;
    startTransition(async () => {
      const res = await cancelPendingInvite({ postId, inviteId });
      if (!res.ok) {
        toast.error(res.error || "Could not cancel invite.");
        return;
      }
      toast.success(`Invite to ${email} cancelled.`);
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
            <div className="space-y-3 border-t border-portal-border-soft pt-3">
              {/* Pending email invites */}
              {pendingInvites.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                    Pending invites
                  </div>
                  <ul className="space-y-1.5">
                    {pendingInvites.map((inv) => (
                      <li key={inv.id} className="flex items-center gap-2">
                        <Clock className="h-3.5 w-3.5 shrink-0 text-portal-text-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-ui text-xs text-portal-text">{inv.email}</div>
                        </div>
                        <RoleBadge role={inv.role} />
                        <button
                          type="button"
                          onClick={() => handleCancelInvite(inv.id, inv.email)}
                          disabled={pending}
                          aria-label={`Cancel invite to ${inv.email}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-portal-text-muted hover:bg-portal-panel-soft hover:text-portal-red disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                Invite a teammate
              </div>

              {/* Role applies to whichever invite path is used. */}
              <Select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as PostCollaboratorRole)}
                disabled={pending}
                aria-label="Collaborator role"
                className="h-9 w-full text-xs"
              >
                <option value="editor">Editor — can co-write (with the edit lock)</option>
                <option value="reviewer">Reviewer — can only comment</option>
              </Select>

              {/* Pick an existing user */}
              {eligible.length > 0 && (
                <>
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search teammates by name or email…"
                    disabled={pending}
                    aria-label="Search teammates"
                    className="h-9 text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Select
                      value={inviteeId}
                      onChange={(e) => setInviteeId(e.target.value)}
                      disabled={pending}
                      aria-label="Choose a teammate to invite"
                      className="h-9 flex-1 text-xs"
                    >
                      <option value="">
                        {filteredEligible.length === 0 ? "No matches" : "Choose a teammate…"}
                      </option>
                      {filteredEligible.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} · {t.email}
                        </option>
                      ))}
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
                      Add
                    </Button>
                  </div>
                </>
              )}

              {/* Or invite by email (not-yet-registered ConveGenius users) */}
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="name@convegenius.ai"
                  disabled={pending}
                  aria-label="Invite by email"
                  className="h-9 flex-1 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleInviteByEmail}
                  disabled={pending || !inviteEmail.trim()}
                >
                  {pending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="h-3.5 w-3.5" />
                  )}
                  Email
                </Button>
              </div>
              <p className="text-[10px] leading-relaxed text-portal-text-muted">
                Invite anyone with a ConveGenius account. If they haven&apos;t signed in yet, the
                invite activates the first time they log in.
              </p>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Badge } from "@/components/ui/Badge";
import { upsertAuthorizedUser, removeAuthorizedUser } from "@/app/(app)/admin/actions";
import { weekdayLabel } from "@/lib/utils/dates";
import type { AuthorizedUserRow, ProfileRow } from "@/lib/db/types";

interface Props {
  allow: AuthorizedUserRow[];
  profiles: ProfileRow[];
}

export function UsersAdmin({ allow, profiles }: Props) {
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "writer" | "author" | "manager">("author");
  const [weekday, setWeekday] = useState<number | "">("");

  function add() {
    if (!email.trim()) return;
    startTransition(async () => {
      const res = await upsertAuthorizedUser({
        email,
        role,
        weekday: weekday === "" ? null : Number(weekday),
      });
      if (!res.ok) toast.error(res.error || "Failed.");
      else {
        toast.success("Added.");
        setEmail("");
      }
    });
  }

  function remove(e: string) {
    if (!window.confirm(`Remove ${e} from the allowlist?`)) return;
    startTransition(async () => {
      const res = await removeAuthorizedUser(e);
      if (!res.ok) toast.error(res.error || "Failed.");
      else toast.success("Removed.");
    });
  }

  const profileByEmail = new Map<string, ProfileRow>(profiles.map((p) => [p.email, p]));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-muted/40 p-3">
        <label className="flex flex-1 flex-col">
          <span className="text-xs font-medium text-muted-foreground">Email</span>
          <Input
            type="email"
            value={email}
            placeholder="name@convegenius.ai"
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col">
          <span className="text-xs font-medium text-muted-foreground">Role</span>
          <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="viewer">Viewer</option>
            <option value="writer">Writer</option>
            <option value="author">Author</option>
            <option value="manager">Manager</option>
          </Select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs font-medium text-muted-foreground">Weekday</span>
          <Select
            value={weekday}
            onChange={(e) => setWeekday(e.target.value === "" ? "" : (Number(e.target.value) as 1 | 2 | 3 | 4 | 5))}
          >
            <option value="">Unassigned</option>
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>{weekdayLabel(d)}</option>
            ))}
          </Select>
        </label>
        <Button onClick={add} disabled={pending}>
          <UserPlus className="mr-2 h-4 w-4" /> Add / update
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {allow.length === 0 && (
          <li className="p-4 text-center text-sm text-muted-foreground">No allowlisted users yet.</li>
        )}
        {allow.map((a) => {
          const profile = profileByEmail.get(a.email);
          return (
            <li key={a.email} className="flex items-center gap-3 p-3">
              <div className="flex-1">
                <div className="font-medium">{profile?.full_name ?? a.email}</div>
                <div className="text-xs text-muted-foreground">{a.email}</div>
              </div>
              <Badge variant={a.role === "manager" ? "default" : "secondary"} className="capitalize">
                {a.role}
              </Badge>
              <Badge variant="muted">
                {a.weekly_post_day ? weekdayLabel(a.weekly_post_day) : "—"}
              </Badge>
              <Badge variant={profile ? "success" : "outline"}>
                {profile ? "Signed in" : "Pending sign-in"}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => remove(a.email)}
                disabled={pending}
                title="Remove from allowlist"
                aria-label="Remove"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

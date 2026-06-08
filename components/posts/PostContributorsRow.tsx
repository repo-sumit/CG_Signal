import { Avatar } from "@/components/ui/Avatar";
import type { PostContributorRole } from "@/lib/db/types";

export interface PostContributorsRowItem {
  id: string;
  firstName: string;
  fullName: string;
  avatarUrl?: string | null;
  role?: PostContributorRole | string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  editor: "Editor",
  contributor: "Contributor",
};

/**
 * Multi-author byline for the public post detail page. Renders an avatar +
 * first name + role for each contributor, wrapping on narrow screens. Used only
 * when a post has more than one contributor; single-author posts keep the
 * original byline. Shows first name (full name in the tooltip) — never email.
 */
export function PostContributorsRow({ contributors }: { contributors: PostContributorsRowItem[] }) {
  if (contributors.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-3">
      {contributors.map((c) => (
        <li key={c.id} className="flex items-center gap-2" title={c.fullName || c.firstName}>
          <Avatar src={c.avatarUrl} name={c.fullName || c.firstName} size="md" />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-ui text-sm font-bold text-portal-text">{c.firstName}</div>
            {c.role && (
              <div className="text-[10px] uppercase tracking-wider text-portal-text-muted">
                {ROLE_LABEL[c.role] ?? c.role}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

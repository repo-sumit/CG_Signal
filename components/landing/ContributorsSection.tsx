import { ContributorCard } from "./ContributorCard";
import type { ContributorStats } from "@/lib/db/public";

interface Props {
  contributors: ContributorStats[];
}

export function ContributorsSection({ contributors }: Props) {
  if (contributors.length === 0) return null;
  return (
    <section className="feed-container w-full min-w-0 py-12 sm:py-16">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-portal-orange">The crew</div>
          <h2 className="mt-2 font-hero text-3xl font-bold uppercase tracking-tighter text-portal-text sm:text-4xl">
            Contributors
          </h2>
          <p className="mt-2 max-w-xl text-sm text-portal-text-muted">
            The five people transmitting from across ConveGenius — one per weekday.
          </p>
        </div>
        <div className="hidden shrink-0 text-[10px] uppercase tracking-wider text-portal-text-muted sm:block">
          {contributors.length} active
        </div>
      </div>

      {/* min-w-0 on the grid prevents children with intrinsic widths from
          forcing the grid past its container. */}
      <div className="grid w-full min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {contributors.map((c) => (
          <ContributorCard key={c.profile.id} stat={c} />
        ))}
      </div>
    </section>
  );
}

import { Card, CardContent } from "@/components/ui/Card";

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
}

export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
        {hint ? (
          <p className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

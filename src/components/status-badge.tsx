import { cn } from "@/lib/utils";
import type { DepositStatus, WithdrawalStatus } from "@/lib/types";

type Kind = DepositStatus | WithdrawalStatus | "active" | "inactive" | "suspended";

const STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  approved: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  processing: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  completed: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-700 border-red-500/30",
  requested: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  credits_pulled: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  paid: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  active: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  inactive: "bg-zinc-500/10 text-zinc-700 border-zinc-500/30",
  suspended: "bg-red-500/10 text-red-700 border-red-500/30",
};

const LABELS: Record<string, string> = {
  credits_pulled: "Credits Pulled",
};

export function StatusBadge({ status }: { status: Kind }) {
  const cls = STYLES[status] ?? "bg-zinc-500/10 text-zinc-700 border-zinc-500/30";
  const label = LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        cls,
      )}
    >
      {label}
    </span>
  );
}

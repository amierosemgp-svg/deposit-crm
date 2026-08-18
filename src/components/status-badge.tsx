import { cn } from "@/lib/utils";
import type {
  BankTransferStatus,
  DepositStatus,
  GameTransferStatus,
  WithdrawalStatus,
} from "@/lib/types";

type Kind =
  | DepositStatus
  | WithdrawalStatus
  | BankTransferStatus
  | GameTransferStatus
  | "active"
  | "inactive"
  | "suspended";

const STYLES: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  pending_match: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  matched: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  pending_confirmation: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  confirmed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  auto_confirmed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-red-500/10 text-red-700 dark:text-red-300",
  approved: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  processing: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  // A transfer being auto-recovered — deliberately louder than "pending", it
  // means something already went wrong once.
  solving: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/10 text-red-700 dark:text-red-300",
  requested: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  credits_pulled: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  paid: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  inactive: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  suspended: "bg-red-500/10 text-red-700 dark:text-red-300",
};

const LABELS: Record<string, string> = {
  solving: "Solving",
  credits_pulled: "Credits Pulled",
  pending_match: "Awaiting Bank Match",
  matched: "Bank Matched",
  pending_confirmation: "Awaiting Confirmation",
  auto_confirmed: "Auto-confirmed",
};

export function StatusBadge({
  status,
  // Same status word can mean different things per record type — a "pending"
  // game transfer is "Initializing" (waiting for the agent), not the same
  // "Pending" as a deposit awaiting CS.
  label: labelOverride,
}: {
  status: Kind;
  label?: string;
}) {
  const cls = STYLES[status] ?? "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  const label =
    labelOverride ??
    LABELS[status] ??
    status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        cls,
      )}
    >
      {label}
    </span>
  );
}

/** Marks whether a deposit/withdrawal was agent-detected ("Auto") or hand-entered ("Manual"). */
export function SourceBadge({
  source,
}: {
  source: "bot" | "manual" | null | undefined;
}) {
  const manual = source === "manual";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        manual
          ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
          : "bg-sky-500/10 text-sky-700 dark:text-sky-300",
      )}
    >
      {manual ? "Manual" : "Auto"}
    </span>
  );
}

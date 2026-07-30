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
  pending: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  pending_match: "bg-orange-500/10 text-orange-700 border-orange-500/30",
  matched: "bg-sky-500/10 text-sky-700 border-sky-500/30",
  pending_confirmation: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  confirmed: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  auto_confirmed: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  rejected: "bg-red-500/10 text-red-700 border-red-500/30",
  approved: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  processing: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  // A transfer being auto-recovered — deliberately louder than "pending", it
  // means something already went wrong once.
  solving: "bg-violet-500/10 text-violet-700 border-violet-500/30",
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
  // game transfer is "Initializing" (waiting for the bot), not the same
  // "Pending" as a deposit awaiting CS.
  label: labelOverride,
}: {
  status: Kind;
  label?: string;
}) {
  const cls = STYLES[status] ?? "bg-zinc-500/10 text-zinc-700 border-zinc-500/30";
  const label =
    labelOverride ??
    LABELS[status] ??
    status.charAt(0).toUpperCase() + status.slice(1);
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

/** Marks whether a deposit/withdrawal was bot-detected ("Auto") or hand-entered ("Manual"). */
export function SourceBadge({
  source,
}: {
  source: "bot" | "manual" | null | undefined;
}) {
  const manual = source === "manual";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        manual
          ? "bg-violet-500/10 text-violet-700 border-violet-500/30"
          : "bg-sky-500/10 text-sky-700 border-sky-500/30",
      )}
    >
      {manual ? "Manual" : "Auto"}
    </span>
  );
}

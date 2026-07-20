import type { LucideIcon } from "lucide-react";
import {
  Banknote,
  Building2,
  Gift,
  ScrollText,
  UserCog,
  Wallet,
} from "lucide-react";

export type ReportTone =
  | "emerald"
  | "blue"
  | "amber"
  | "purple"
  | "rose"
  | "slate";

export type ReportDef = {
  id: string;
  title: string;
  /** Compact label for the sidebar menu. */
  shortTitle: string;
  description: string;
  icon: LucideIcon;
  tone: ReportTone;
};

export const REPORT_TONE_CLASSES: Record<ReportTone, string> = {
  emerald: "bg-emerald-500/10 text-emerald-600",
  blue: "bg-blue-500/10 text-blue-600",
  amber: "bg-amber-500/10 text-amber-600",
  purple: "bg-purple-500/10 text-purple-600",
  rose: "bg-rose-500/10 text-rose-600",
  slate: "bg-slate-500/10 text-slate-600",
};

export const REPORT_DEFS: ReportDef[] = [
  {
    id: "daily_deposits",
    shortTitle: "Daily Deposits",
    title: "Daily Deposits Report",
    description:
      "Every completed deposit with player, bonus %, game, CS agent, and top-up reference.",
    icon: Wallet,
    tone: "emerald",
  },
  {
    id: "daily_withdrawals",
    shortTitle: "Daily Withdrawals",
    title: "Daily Withdrawals Report",
    description:
      "All withdrawal requests with pulled amount, bank payout status, and processing CS agent.",
    icon: Banknote,
    tone: "blue",
  },
  {
    id: "ggr_summary",
    shortTitle: "GGR Summary",
    title: "GGR Summary",
    description:
      "Per-company gross gaming revenue: deposits − withdrawals − bonuses.",
    icon: Building2,
    tone: "purple",
  },
  {
    id: "cs_performance",
    shortTitle: "CS Performance",
    title: "CS Agent Performance",
    description:
      "Transactions handled, volume, and approval times per agent for the period.",
    icon: UserCog,
    tone: "amber",
  },
  {
    id: "bonus_payout",
    shortTitle: "Bonus Payout",
    title: "Bonus Payout Report",
    description:
      "Total bonuses issued — broken down by bonus %, game provider, and company.",
    icon: Gift,
    tone: "rose",
  },
  {
    id: "bank_reconciliation",
    shortTitle: "Bank Reconciliation",
    title: "Bank Reconciliation",
    description:
      "Bank-detected deposits vs CRM-recorded vs game top-ups, with discrepancy flags.",
    icon: ScrollText,
    tone: "slate",
  },
];

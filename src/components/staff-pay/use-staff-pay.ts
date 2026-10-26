"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";

/** A month's days worked and off, and what they do to the pay (lib/salary `Attendance`). */
export type AttendanceSummary = {
  counted: number;
  worked: number;
  off: number;
  off_told: number;
  off_untold: number;
  free_used: number;
  charged_told: number;
  charged_untold: number;
  deduction: number;
  bonus: number;
  amount: number;
  complete: boolean;
  /** Clocked in by the month's end; a month before that can't be paid. */
  started: boolean;
};

/** GET /api/staff-pay, as the Salary and Staff Penalty sheets read it. */
export type StaffRow = {
  user_id: number;
  username: string;
  full_name: string;
  status: "active" | "inactive";
  company_entity_id: number;
  base: number;
  base_set: boolean;
  attendance: AttendanceSummary;
  pending_adjustments: number;
  would_pay: number;
  would_carry: number;
  paid_salary_id: number | null;
};

export type SalaryPayment = {
  salary_id: number;
  user_id: number;
  company_entity_id: number;
  period_month: string;
  hours_worked: number;
  days_worked: number;
  tier_id: number | null;
  tier_name: string | null;
  tier_basis: "monthly" | "hourly" | null;
  tier_rate: number | null;
  base_amount: number;
  attendance_amount: number;
  /** Null on salaries paid under the old tier ladder. */
  attendance: AttendanceSummary | null;
  adjustments_total: number;
  net_amount: number;
  carried_forward: number;
  paid_from_account_id: number | null;
  paid_from_cash_entity_id: number | null;
  paid_at: string;
  status: "paid" | "reversed";
  reversed_at: string | null;
  reversed_by_user_id: number | null;
  notes: string | null;
  recorded_by_user_id: number;
};

export type AdjustmentKind = "bonus" | "deduction" | "penalty" | "carry" | "advance";

export type SalaryAdjustment = {
  adjustment_id: number;
  user_id: number;
  company_entity_id: number;
  kind: AdjustmentKind;
  amount: number;
  reason: string;
  occurred_at: string;
  penalty_id: number | null;
  carried_from_salary_id: number | null;
  salary_id: number | null;
  created_by_user_id: number | null;
};

export type PenaltySource = "deposit" | "free_credit" | "game_transfer" | "withdrawal" | "other";

export type StaffPenalty = {
  penalty_id: number;
  user_id: number;
  company_entity_id: number;
  source_type: PenaltySource;
  source_id: number | null;
  player_id: number | null;
  occurred_at: string;
  credit_injected: number;
  credit_retrieved: number;
  loss_amount: number;
  share_pct: number;
  amount: number;
  reason: string;
  notes: string | null;
  status: "active" | "void";
  voided_at: string | null;
  recorded_by_user_id: number;
};

export type LeaveKind = "mc" | "annual" | "emergency" | "other";

export type StaffLeave = {
  leave_id: number;
  user_id: number;
  company_entity_id: number;
  from_day: string;
  to_day: string;
  kind: LeaveKind;
  notified: boolean;
  reason: string;
  status: "active" | "void";
  voided_at: string | null;
  voided_by_user_id: number | null;
  recorded_by_user_id: number;
  created_at: string;
};

export type StaffPay = {
  month: string;
  staff: StaffRow[];
  payments: SalaryPayment[];
  adjustments: SalaryAdjustment[];
  penalties: StaffPenalty[];
  leaves: StaffLeave[];
  share_pct: number;
};

export const ADJUSTMENT_LABEL: Record<AdjustmentKind, string> = {
  bonus: "Bonus",
  deduction: "Deduction",
  penalty: "Staff penalty",
  carry: "Advance carried over",
  advance: "Advance",
};

export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = {
  mc: "MC",
  annual: "Annual leave",
  emergency: "Emergency leave",
  other: "Other",
};

/** "2026-10-30" → "30/10/2026", the sheet's way. */
export const sheetDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${d}/${m}/${y}`;
};

/** Days a leave covers, both ends included. */
export const leaveDays = (l: Pick<StaffLeave, "from_day" | "to_day">) =>
  Math.round((Date.parse(`${l.to_day}T00:00:00Z`) - Date.parse(`${l.from_day}T00:00:00Z`)) / 86_400_000) + 1;

export const PENALTY_SOURCE_LABEL: Record<PenaltySource, string> = {
  deposit: "Deposit",
  free_credit: "Free credit",
  game_transfer: "Game transfer",
  withdrawal: "Withdrawal",
  other: "Other",
};

/** This month, business time — "2026-10". */
export function currentMonth(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
}

/** "2026-10" → "Oct 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-MY", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export async function send(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `Request failed (${res.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/**
 * The staff-pay figures for a month. Polled like the other sheets (a colleague's
 * penalty should show up without a reload) and refetched whenever the store
 * moves, since a salary paid changes the bank cards above as well.
 */
export function useStaffPay(month: string) {
  const dataVersion = useStore((s) => s.dataVersion);
  const [data, setData] = useState<StaffPay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/staff-pay?month=${month}`);
      const d = (await res.json().catch(() => null)) as (StaffPay & { error?: string }) | null;
      if (!res.ok || !d) {
        setError(d?.error ?? `Could not load staff pay (${res.status})`);
        return;
      }
      setError(null);
      setData(d);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load, dataVersion]);

  return { data, loading, error, reload: load };
}

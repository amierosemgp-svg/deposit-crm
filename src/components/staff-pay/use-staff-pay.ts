"use client";

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";

/** GET /api/staff-pay, as the Salary and Staff Penalty sheets read it. */
export type StaffRow = {
  user_id: number;
  username: string;
  full_name: string;
  status: "active" | "inactive";
  company_entity_id: number;
  hours: number;
  days: number;
  tier_id: number | null;
  tier_name: string | null;
  base: number;
  pending_adjustments: number;
  paid_salary_id: number | null;
};

export type SalaryTier = {
  tier_id: number;
  company_entity_id: number;
  name: string;
  min_hours: number;
  min_days: number;
  basis: "monthly" | "hourly";
  default_amount: number;
  status: "active" | "inactive";
};

export type TierRate = { user_id: number; tier_id: number; amount: number };

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

export type AdjustmentKind = "bonus" | "deduction" | "penalty" | "carry";

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

export type StaffPay = {
  month: string;
  staff: StaffRow[];
  tiers: SalaryTier[];
  rates: TierRate[];
  payments: SalaryPayment[];
  adjustments: SalaryAdjustment[];
  penalties: StaffPenalty[];
  share_pct: number;
};

export const ADJUSTMENT_LABEL: Record<AdjustmentKind, string> = {
  bonus: "Bonus",
  deduction: "Deduction",
  penalty: "Staff penalty",
  carry: "Carried over",
};

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

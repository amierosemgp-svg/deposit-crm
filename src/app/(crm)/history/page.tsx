"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import type { AuditEntry } from "@/lib/types";
import { formatRM, formatDateTime } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { PlayerNameLink } from "@/components/player-name-link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Filter, ScrollText } from "lucide-react";

type AuditType = AuditEntry["type"];

const TYPE_META: Record<AuditType, { label: string; className: string }> = {
  deposit: {
    label: "Deposit",
    className: "bg-emerald-500/10 text-emerald-700",
  },
  withdrawal: {
    label: "Withdrawal",
    className: "bg-blue-500/10 text-blue-700",
  },
  game_topup: {
    label: "Game Top-up",
    className: "bg-sky-500/10 text-sky-700",
  },
  game_transfer: {
    label: "Game Transfer",
    className: "bg-purple-500/10 text-purple-700",
  },
  credit_pull: {
    label: "Credit Pull",
    className: "bg-indigo-500/10 text-indigo-700",
  },
  bank_transfer: {
    label: "Bank Transfer",
    className: "bg-amber-500/10 text-amber-700",
  },
  bo_adjustment: {
    label: "BO Adjustment",
    className: "bg-rose-500/10 text-rose-700",
  },
  player_import: {
    label: "Player Import",
    className: "bg-zinc-500/10 text-zinc-700",
  },
};

const TYPE_ORDER: AuditType[] = [
  "deposit",
  "withdrawal",
  "game_topup",
  "game_transfer",
  "credit_pull",
  "bank_transfer",
  "bo_adjustment",
  "player_import",
];

function referenceOf(e: AuditEntry): string {
  const d = e.details ?? {};
  const candidate =
    d["topup_reference"] ?? d["reference"] ?? d["transaction_ref"];
  if (typeof candidate === "string" && candidate) return candidate;
  if (typeof candidate === "number") return String(candidate);
  if (e.reference_id != null) return `#${e.reference_id}`;
  return "—";
}

const REFERENCE_KEYS = new Set([
  "topup_reference",
  "reference",
  "transaction_ref",
]);

function detailsSummary(e: AuditEntry): string {
  const d = e.details ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (REFERENCE_KEYS.has(k)) continue;
    if (v == null || typeof v === "object") continue;
    parts.push(`${k.replaceAll("_", " ")}: ${v}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" · ") || "—";
}

export default function HistoryPage() {
  const auditLog = useStore((s) => s.auditLog);
  const playerById = useStore((s) => s.playerById);
  const userName = useStore((s) => s.userName);
  const companiesFn = useStore((s) => s.companies);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);
  const [type, setType] = useState<string>("all");
  const [q, setQ] = useState("");

  const activeCompany = companiesFn().find(
    (c) => c.company_id === selectedCompanyId,
  );

  const filtered = useMemo(() => {
    const sorted = [...auditLog].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    return sorted
      .filter((e) =>
        // Entries with no player (system events) stay visible in every scope.
        e.player_id == null
          ? selectedCompanyId === null && selectedLeaderId === null
          : companyInScope(playerById(e.player_id)?.company_entity_id),
      )
      .filter((e) => type === "all" || e.type === type)
      .filter((e) => {
        if (!q) return true;
        const p = e.player_id != null ? playerById(e.player_id) : undefined;
        const hay =
          `${referenceOf(e)} ${p?.full_name ?? ""} ${p?.username ?? ""}`.toLowerCase();
        return hay.includes(q.toLowerCase());
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditLog, selectedCompanyId, selectedLeaderId, type, q, playerById]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Transaction History</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full server-side audit trail of every money and credit movement
          {activeCompany && (
            <>
              {" "}
              ·{" "}
              <span className="font-medium text-foreground">
                {activeCompany.company_name}
              </span>
            </>
          )}
        </p>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={type} onValueChange={(v) => setType(v ?? "all")}>
            <SelectTrigger className="h-8 w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPE_ORDER.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_META[t].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search player, reference…"
              className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} records
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ScrollText className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">
              {q || type !== "all"
                ? "No records match your filters"
                : "No activity recorded yet"}
            </p>
            <p className="text-[12px] text-muted-foreground max-w-sm">
              {q || type !== "all"
                ? "Try clearing the search or choosing a different type."
                : "Deposits, withdrawals, transfers and adjustments will appear here as they happen."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date</th>
                  <th className="px-3 py-2.5 text-left font-medium">Type</th>
                  <th className="px-3 py-2.5 text-left font-medium">Player</th>
                  <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Amount</th>
                  <th className="px-3 py-2.5 text-left font-medium">Game</th>
                  <th className="px-3 py-2.5 text-left font-medium">By</th>
                  <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Reference</th>
                  <th className="px-3 py-2.5 text-left font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const p =
                    e.player_id != null ? playerById(e.player_id) : undefined;
                  const meta = TYPE_META[e.type];
                  const signed = e.type === "bo_adjustment";
                  return (
                    <tr
                      key={e.transaction_id}
                      className="border-t hover:bg-muted/30"
                    >
                      <td className="px-3 py-2 whitespace-nowrap text-[12px]">
                        {formatDateTime(e.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${meta.className}`}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {e.player_id != null ? (
                          <PlayerNameLink playerId={e.player_id}>
                            {p?.username ?? `P-${e.player_id}`}
                          </PlayerNameLink>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium whitespace-nowrap ${
                          signed
                            ? e.amount >= 0
                              ? "text-emerald-700"
                              : "text-rose-700"
                            : ""
                        }`}
                      >
                        {e.type === "player_import" && e.amount === 0
                          ? "—"
                          : signed
                            ? `${e.amount >= 0 ? "+" : "−"}${formatRM(Math.abs(e.amount))}`
                            : formatRM(e.amount)}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        {e.game_name ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted-foreground">
                        {userName(e.user_id)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                        {referenceOf(e)}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-muted-foreground max-w-[260px] truncate">
                        {detailsSummary(e)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

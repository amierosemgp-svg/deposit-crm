"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Coins,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { COMPANIES, USERS } from "@/lib/mock-data";
import { formatRelative } from "@/lib/format";
import { GAMES, type ProviderBoAccount } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BoAccountFormModal } from "@/components/bo-account-form-modal";
import { BoCreditAdjustModal } from "@/components/bo-credit-adjust-modal";
import { cn } from "@/lib/utils";

function fmtCredit(n: number) {
  return n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function ProviderAccountsPage() {
  const accounts = useStore((s) => s.providerBoAccounts);
  const adjustments = useStore((s) => s.providerBoAdjustments);
  const deleteAccount = useStore((s) => s.deleteProviderBoAccount);

  const [companyFilter, setCompanyFilter] = useState<string>("all");
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderBoAccount | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<ProviderBoAccount | null>(null);
  const [adjustDirection, setAdjustDirection] = useState<"topup" | "deduct">("topup");

  const filtered = useMemo(
    () =>
      accounts
        .filter((a) => companyFilter === "all" || String(a.company_id) === companyFilter)
        .filter((a) => gameFilter === "all" || a.game_name === gameFilter)
        .sort(
          (a, b) =>
            a.company_id - b.company_id ||
            a.game_name.localeCompare(b.game_name) ||
            a.bo_username.localeCompare(b.bo_username),
        ),
    [accounts, companyFilter, gameFilter],
  );

  const totalCredit = useMemo(
    () => filtered.reduce((s, a) => s + a.current_credit, 0),
    [filtered],
  );
  const activeCount = filtered.filter((a) => a.status === "active").length;
  const lowCreditCount = filtered.filter(
    (a) => a.status === "active" && a.current_credit < 5000,
  ).length;

  // Per-game totals (filtered scope)
  const perGame = useMemo(() => {
    return GAMES.map((g) => ({
      game: g,
      total: filtered
        .filter((a) => a.game_name === g)
        .reduce((s, a) => s + a.current_credit, 0),
      count: filtered.filter((a) => a.game_name === g).length,
    }));
  }, [filtered]);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(account: ProviderBoAccount) {
    setEditing(account);
    setFormOpen(true);
  }
  function openAdjust(account: ProviderBoAccount, dir: "topup" | "deduct") {
    setAdjustTarget(account);
    setAdjustDirection(dir);
    setAdjustOpen(true);
  }
  function handleDelete(account: ProviderBoAccount) {
    if (account.current_credit > 0) {
      toast.error(
        "Cannot delete a BO account with non-zero credit. Deduct or transfer credit first.",
      );
      return;
    }
    if (
      !confirm(
        `Delete BO account "${account.bo_username}" (${account.game_name})? This cannot be undone.`,
      )
    )
      return;
    deleteAccount(account.bo_account_id);
    toast.success("BO account deleted");
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Provider BO Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Game-provider back-office logins and the wholesale credit each holds
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={openCreate} size="sm" className="cursor-pointer">
            <Plus className="h-3.5 w-3.5" />
            Add BO Account
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Total Credit Pool
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {fmtCredit(totalCredit)}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Across {filtered.length} BO account{filtered.length === 1 ? "" : "s"}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Active Accounts
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {activeCount}
            <span className="text-base font-normal text-muted-foreground">
              {" "}
              / {filtered.length}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Inactive accounts are excluded from top-up routing
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Low-Credit Alerts
          </div>
          <div
            className={cn(
              "mt-1 text-2xl font-semibold tabular-nums",
              lowCreditCount > 0 ? "text-amber-600" : "text-foreground",
            )}
          >
            {lowCreditCount}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Active accounts under 5,000 credits
          </div>
        </Card>
      </div>

      <Card className="p-4 gap-0">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
          Credit by game
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {perGame.map((g) => (
            <div key={g.game} className="rounded-md border bg-muted/20 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">{g.game}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {fmtCredit(g.total)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {g.count} account{g.count === 1 ? "" : "s"}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={companyFilter}
            onValueChange={(v) => setCompanyFilter(v ?? "all")}
          >
            <SelectTrigger className="h-8 w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All companies</SelectItem>
              {COMPANIES.map((c) => (
                <SelectItem key={c.company_id} value={String(c.company_id)}>
                  {c.company_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={gameFilter} onValueChange={(v) => setGameFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All games</SelectItem>
              {GAMES.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filtered.length} account{filtered.length === 1 ? "" : "s"} shown
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Game / BO Login</th>
                <th className="px-3 py-2.5 text-left font-medium">Company</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">
                  Credit Balance
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-12 text-center text-sm text-muted-foreground"
                  >
                    No BO accounts. Click <strong>Add BO Account</strong> to create one.
                  </td>
                </tr>
              )}
              {filtered.map((a) => {
                const company = COMPANIES.find((c) => c.company_id === a.company_id);
                const isLow = a.status === "active" && a.current_credit < 5000;
                return (
                  <tr key={a.bo_account_id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-md",
                            a.status === "active"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </div>
                        <div>
                          <div className="text-sm font-medium leading-tight">
                            {a.game_name}
                          </div>
                          <div className="text-[11px] text-muted-foreground leading-tight font-mono">
                            {a.bo_username}
                            {a.bo_label && (
                              <span className="ml-1.5 italic font-sans">
                                · {a.bo_label}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {company?.company_name ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {isLow && (
                          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                        )}
                        <span
                          className={cn(
                            "font-semibold tabular-nums",
                            a.current_credit === 0 && "text-muted-foreground",
                            isLow && "text-amber-700",
                          )}
                        >
                          {fmtCredit(a.current_credit)}
                        </span>
                      </div>
                      {isLow && (
                        <div className="text-[10px] text-amber-600 mt-0.5">
                          Low credit
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openAdjust(a, "topup")}
                          disabled={a.status !== "active"}
                          className="cursor-pointer h-7 px-2 text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50"
                          title="Top up credit"
                        >
                          <ArrowUpCircle className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openAdjust(a, "deduct")}
                          disabled={a.status !== "active" || a.current_credit <= 0}
                          className="cursor-pointer h-7 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                          title="Deduct credit"
                        >
                          <ArrowDownCircle className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(a)}
                          className="cursor-pointer h-7 px-2"
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(a)}
                          className="cursor-pointer h-7 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Coins className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Recent Credit Adjustments</h2>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {adjustments.length} total
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">When</th>
                <th className="px-3 py-2.5 text-left font-medium">BO Account</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">
                  Change
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Reason</th>
                <th className="px-3 py-2.5 text-left font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    No credit adjustments yet.
                  </td>
                </tr>
              )}
              {adjustments.map((j) => {
                const acct = accounts.find((a) => a.bo_account_id === j.bo_account_id);
                const handler = USERS.find((u) => u.user_id === j.handled_by_user_id);
                const positive = j.amount > 0;
                return (
                  <motion.tr
                    key={j.adjustment_id}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="border-t hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">
                      {formatRelative(j.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-[12px] font-medium">
                        {acct?.game_name ?? "—"}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        {acct?.bo_username ?? `BO-${j.bo_account_id}`}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-semibold tabular-nums",
                          positive ? "text-emerald-700" : "text-rose-600",
                        )}
                      >
                        {positive ? (
                          <ArrowUpCircle className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDownCircle className="h-3.5 w-3.5" />
                        )}
                        {positive ? "+" : ""}
                        {fmtCredit(j.amount)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[12px] max-w-md truncate">
                      {j.reason}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {handler?.full_name ?? `User ${j.handled_by_user_id}`}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <BoAccountFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        account={editing}
      />
      <BoCreditAdjustModal
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        account={adjustTarget}
        defaultDirection={adjustDirection}
      />
    </div>
  );
}

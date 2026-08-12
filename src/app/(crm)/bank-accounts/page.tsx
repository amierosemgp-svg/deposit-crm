"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  Hourglass,
  Landmark,
  Pencil,
  Plus,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime, formatRelative } from "@/lib/format";
import type { BankAccount, BankTransfer } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { Switch } from "@/components/ui/switch";
import { BankAccountFormModal } from "@/components/bank-account-form-modal";
import { ListLoading } from "@/components/list-loading";
import { BankTransferModal } from "@/components/bank-transfer-modal";
import { cn } from "@/lib/utils";

function maskAccountNumber(num: string) {
  const digits = num.replace(/\s+/g, "");
  if (digits.length <= 4) return digits;
  return `•••• ${digits.slice(-4)}`;
}

function countdownTo(expiresAt: string, now: number) {
  const diff = new Date(expiresAt).getTime() - now;
  if (diff <= 0) return "auto-confirming now";
  const mins = Math.floor(diff / 60_000);
  const days = Math.floor(mins / (60 * 24));
  const hrs = Math.floor((mins % (60 * 24)) / 60);
  const rem = mins % 60;
  if (days > 0) return `auto-confirms in ${days}d ${hrs}h`;
  if (hrs > 0) return `auto-confirms in ${hrs}h ${rem}m`;
  return `auto-confirms in ${rem}m`;
}

function RoleBadge({ role }: { role: BankAccount["role"] }) {
  return role === "deposit" ? (
    <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
      Deposit · Collection
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300 whitespace-nowrap">
      Withdrawal · Payout
    </span>
  );
}

function EntityTypeChip({ type }: { type: string }) {
  const label =
    type === "leader" ? "Leader" : type === "company" ? "Company" : type;
  return (
    <span className="inline-flex items-center rounded-md border bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
      {label}
    </span>
  );
}

export default function BankAccountsPage() {
  const accounts = useStore((s) => s.bankAccounts);
  const transfers = useStore((s) => s.bankTransfers);
  const entities = useStore((s) => s.entities);
  const me = useStore((s) => s.me);
  const hydrated = useStore((s) => s.hydrated);
  const entityName = useStore((s) => s.entityName);
  const userName = useStore((s) => s.userName);
  const deleteAccount = useStore((s) => s.deleteBankAccount);
  const updateAccount = useStore((s) => s.updateBankAccount);
  const confirmTransfer = useStore((s) => s.confirmBankTransfer);
  const rejectTransfer = useStore((s) => s.rejectBankTransfer);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const companyInScope = useStore((s) => s.companyInScope);

  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<BankAccount | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDefaultFrom, setTransferDefaultFrom] = useState<number | null>(null);
  const [actingTransferId, setActingTransferId] = useState<number | null>(null);

  // Live tick for the auto-confirm countdowns
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const canManage =
    !!me && (me.role === "super_admin" || me.role === "company_leader");

  const managesEntity = (entityId: number) =>
    !!me && (me.ownedEntityIds === null || me.ownedEntityIds.includes(entityId));

  const filteredAccounts = useMemo(
    () =>
      accounts
        .filter((a) => companyInScope(a.entity_id))
        .sort(
          (a, b) =>
            a.entity_id - b.entity_id || a.bank_name.localeCompare(b.bank_name),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, selectedCompanyId, selectedLeaderId],
  );

  // Group by entity, preserving sorted order
  const grouped = useMemo(() => {
    const map = new Map<number, BankAccount[]>();
    for (const a of filteredAccounts) {
      const list = map.get(a.entity_id) ?? [];
      list.push(a);
      map.set(a.entity_id, list);
    }
    return Array.from(map.entries()).map(([entityId, accts]) => ({
      entityId,
      entity: entities.find((e) => e.entity_id === entityId),
      accounts: accts,
    }));
  }, [filteredAccounts, entities]);

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.account_id, a])),
    [accounts],
  );

  const pendingTransfers = useMemo(
    () =>
      transfers.filter(
        (t) =>
          t.status === "pending_confirmation" &&
          (accountById.has(t.from_account_id) || accountById.has(t.to_account_id)),
      ),
    [transfers, accountById],
  );

  const incomingPending = pendingTransfers.filter((t) => {
    const to = accountById.get(t.to_account_id);
    return !!to && managesEntity(to.entity_id);
  });
  const outgoingPending = pendingTransfers.filter(
    (t) => !incomingPending.includes(t),
  );

  const sortedTransfers = useMemo(
    () =>
      [...transfers].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [transfers],
  );

  const totalBalance = useMemo(
    () => filteredAccounts.reduce((sum, a) => sum + a.current_balance, 0),
    [filteredAccounts],
  );
  const activeCount = filteredAccounts.filter((a) => a.status === "active").length;

  function openCreate() {
    setEditingAccount(null);
    setFormOpen(true);
  }
  function openEdit(account: BankAccount) {
    setEditingAccount(account);
    setFormOpen(true);
  }
  async function handleDelete(account: BankAccount) {
    if (
      !confirm(
        `Delete ${account.bank_name} ${account.account_number}? This cannot be undone.`,
      )
    )
      return;
    const result = await deleteAccount(account.account_id);
    if (!result.ok) {
      toast.error(result.error ?? "Could not delete bank account");
      return;
    }
    toast.success("Bank account deleted");
  }
  async function toggleStatus(account: BankAccount, active: boolean) {
    const result = await updateAccount(account.account_id, {
      status: active ? "active" : "inactive",
    });
    if (!result.ok) {
      toast.error(result.error ?? "Could not update status");
      return;
    }
    toast.success(
      `${account.bank_name} ${account.account_number} ${active ? "activated" : "deactivated"}`,
    );
  }
  function openTransferFor(account: BankAccount) {
    setTransferDefaultFrom(account.account_id);
    setTransferOpen(true);
  }
  async function handleConfirm(t: BankTransfer) {
    setActingTransferId(t.transfer_id);
    const result = await confirmTransfer(t.transfer_id);
    setActingTransferId(null);
    if (!result.ok) {
      toast.error(result.error ?? "Could not confirm transfer");
      return;
    }
    toast.success(`Transfer of ${formatRM(t.amount)} confirmed`);
  }
  async function handleReject(t: BankTransfer) {
    if (!confirm(`Reject this transfer of ${formatRM(t.amount)}? The sender will be refunded.`))
      return;
    setActingTransferId(t.transfer_id);
    const result = await rejectTransfer(t.transfer_id);
    setActingTransferId(null);
    if (!result.ok) {
      toast.error(result.error ?? "Could not reject transfer");
      return;
    }
    toast.success("Transfer rejected — sender refunded");
  }

  function transferRoute(t: BankTransfer) {
    const from = accountById.get(t.from_account_id);
    const to = accountById.get(t.to_account_id);
    return { from, to };
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Bank Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Entity-owned collection &amp; payout accounts and treasury transfers
            {selectedCompanyId !== null && (
              <>
                {" "}
                ·{" "}
                <span className="font-medium text-foreground">
                  {entityName(selectedCompanyId)}
                </span>
              </>
            )}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setTransferDefaultFrom(null);
                setTransferOpen(true);
              }}
              variant="outline"
              size="sm"
              className="cursor-pointer"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              New Transfer
            </Button>
            <Button onClick={openCreate} size="sm" className="cursor-pointer">
              <Plus className="h-3.5 w-3.5" />
              Add Account
            </Button>
          </div>
        )}
      </div>

      {/* Pending confirmations */}
      {pendingTransfers.length > 0 && (
        <Card className="overflow-hidden p-0 gap-0 border-amber-500/40">
          <div className="flex items-center gap-2 border-b bg-amber-500/5 px-4 py-2.5">
            <Hourglass className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <h2 className="text-sm font-semibold">Pending Confirmations</h2>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {pendingTransfers.length} awaiting action
            </span>
          </div>
          <div className="divide-y">
            {incomingPending.map((t) => {
              const { from, to } = transferRoute(t);
              return (
                <div
                  key={t.transfer_id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    <ArrowDownLeft className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-semibold">{formatRM(t.amount)}</span>{" "}
                      <span className="text-muted-foreground">incoming from</span>{" "}
                      <span className="font-medium">
                        {from
                          ? `${from.bank_name} ${maskAccountNumber(from.account_number)}`
                          : "external account"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        ({from ? entityName(from.entity_id) : "—"})
                      </span>{" "}
                      <ArrowRight className="inline h-3 w-3 text-muted-foreground" />{" "}
                      <span className="font-medium">
                        {to
                          ? `${to.bank_name} ${maskAccountNumber(to.account_number)}`
                          : "—"}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>Initiated by {userName(t.initiated_by_user_id)}</span>
                      {t.reference && <span className="font-mono">{t.reference}</span>}
                      {t.expires_at && (
                        <span className="font-medium text-amber-700 dark:text-amber-300">
                          {countdownTo(t.expires_at, now)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={t.status} />
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => handleConfirm(t)}
                          disabled={actingTransferId === t.transfer_id}
                          className="cursor-pointer h-7"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Confirm
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleReject(t)}
                          disabled={actingTransferId === t.transfer_id}
                          className="cursor-pointer h-7 text-rose-600 dark:text-rose-400 hover:text-rose-700"
                        >
                          <X className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {outgoingPending.map((t) => {
              const { from, to } = transferRoute(t);
              return (
                <div
                  key={t.transfer_id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <ArrowUpRight className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-semibold">{formatRM(t.amount)}</span>{" "}
                      <span className="text-muted-foreground">outgoing to</span>{" "}
                      <span className="font-medium">
                        {to
                          ? `${to.bank_name} ${maskAccountNumber(to.account_number)}`
                          : "—"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        ({to ? entityName(to.entity_id) : "—"})
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>
                        From{" "}
                        {from
                          ? `${from.bank_name} ${maskAccountNumber(from.account_number)}`
                          : "—"}
                      </span>
                      <span className="italic">Waiting for recipient confirmation</span>
                      {t.expires_at && (
                        <span className="font-medium text-amber-700 dark:text-amber-300">
                          {countdownTo(t.expires_at, now)}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={t.status} />
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Total Balance
          </div>
          <div className="mt-1 text-2xl font-semibold">{formatRM(totalBalance)}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Across {filteredAccounts.length} account{filteredAccounts.length === 1 ? "" : "s"}
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
              / {filteredAccounts.length}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Inactive accounts hidden from transfer picker
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Internal Transfers
          </div>
          <div className="mt-1 text-2xl font-semibold">{transfers.length}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {pendingTransfers.length} pending confirmation
          </div>
        </Card>
      </div>

      {/* Accounts grouped by entity */}
      {!hydrated ? (
        <Card className="p-0">
          <ListLoading label="Loading bank accounts…" className="py-14" />
        </Card>
      ) : grouped.length === 0 ? (
        <Card className="p-0">
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Landmark className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="mt-3 text-sm font-semibold">No bank accounts yet</h3>
            <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">
              Bank accounts belong to leaders and companies. Deposit accounts collect
              player payments (watched by the agent); withdrawal accounts pay out players.
            </p>
            {canManage && (
              <Button onClick={openCreate} size="sm" className="mt-4 cursor-pointer">
                <Plus className="h-3.5 w-3.5" />
                Add Account
              </Button>
            )}
          </div>
        </Card>
      ) : (
        grouped.map(({ entityId, entity, accounts: entityAccounts }) => (
          <Card key={entityId} className="overflow-hidden p-0 gap-0">
            <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
              <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold">{entityName(entityId)}</span>
              {entity && <EntityTypeChip type={entity.entity_type} />}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {entityAccounts.length} account{entityAccounts.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2.5 text-left font-medium">Bank</th>
                    <th className="px-3 py-2.5 text-left font-medium">Account</th>
                    <th className="px-3 py-2.5 text-left font-medium">Role</th>
                    <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">
                      Balance
                    </th>
                    <th className="px-3 py-2.5 text-left font-medium">Status</th>
                    {canManage && (
                      <th className="px-3 py-2.5 text-right font-medium">Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {entityAccounts.map((a) => (
                    <tr key={a.account_id} className="border-t hover:bg-muted/30">
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
                            <Landmark className="h-3.5 w-3.5" />
                          </div>
                          <div>
                            <div className="text-sm font-medium leading-tight">
                              {a.bank_name}
                            </div>
                            {a.label && (
                              <div className="text-[10px] text-muted-foreground leading-tight">
                                {a.label}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-[12px] font-mono">
                          {maskAccountNumber(a.account_number)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {a.account_holder}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <RoleBadge role={a.role} />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div
                          className={cn(
                            "font-semibold tabular-nums",
                            a.current_balance === 0 && "text-muted-foreground",
                          )}
                        >
                          {formatRM(a.current_balance)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {canManage && managesEntity(a.entity_id) ? (
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={a.status === "active"}
                              onCheckedChange={(v) => void toggleStatus(a, v)}
                              aria-label={`Toggle ${a.bank_name} active`}
                            />
                            <span
                              className={cn(
                                "text-[11px] font-medium",
                                a.status === "active"
                                  ? "text-emerald-700 dark:text-emerald-300"
                                  : "text-muted-foreground",
                              )}
                            >
                              {a.status === "active" ? "Active" : "Inactive"}
                            </span>
                          </div>
                        ) : (
                          <StatusBadge status={a.status} />
                        )}
                      </td>
                      {canManage && (
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openTransferFor(a)}
                              disabled={
                                a.status !== "active" ||
                                a.current_balance <= 0 ||
                                !managesEntity(a.entity_id)
                              }
                              className="cursor-pointer h-7 px-2"
                              title="Transfer from this account"
                            >
                              <ArrowRightLeft className="h-3.5 w-3.5" />
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
                              className="cursor-pointer h-7 px-2 text-rose-600 dark:text-rose-400 hover:text-rose-700 hover:bg-rose-50"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      {/* Transfer history */}
      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Transfer History</h2>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {transfers.length} total
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">When</th>
                <th className="px-3 py-2.5 text-left font-medium">From → To</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">
                  Amount
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-left font-medium">Reference</th>
                <th className="px-3 py-2.5 text-left font-medium">Initiated By</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">
                  Confirmed At
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedTransfers.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading transfers…" />
                    ) : (
                      "No transfers yet. Funds moved between entity accounts will appear here."
                    )}
                  </td>
                </tr>
              )}
              {sortedTransfers.map((t) => {
                const { from, to } = transferRoute(t);
                return (
                  <motion.tr
                    key={t.transfer_id}
                    layout
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="border-t hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-[11px] text-muted-foreground">
                      {formatRelative(t.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <span>
                          <span className="font-mono">
                            {from ? maskAccountNumber(from.account_number) : "—"}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {from ? entityName(from.entity_id) : "Unknown"}
                          </span>
                        </span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span>
                          <span className="font-mono">
                            {to ? maskAccountNumber(to.account_number) : "—"}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            {to ? entityName(to.entity_id) : "Unknown"}
                          </span>
                        </span>
                      </div>
                      {t.notes && (
                        <div className="text-[10px] text-muted-foreground italic mt-0.5">
                          {t.notes}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap tabular-nums">
                      {formatRM(t.amount)}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-3 py-2 text-[11px] font-mono text-muted-foreground">
                      {t.reference ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {userName(t.initiated_by_user_id)}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">
                      {t.confirmed_at ? formatDateTime(t.confirmed_at) : "—"}
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <BankAccountFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        account={editingAccount}
      />
      <BankTransferModal
        open={transferOpen}
        onOpenChange={setTransferOpen}
        defaultFromAccountId={transferDefaultFrom}
      />
    </div>
  );
}

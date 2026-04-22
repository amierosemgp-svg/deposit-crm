"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowRightLeft,
  Landmark,
  Pencil,
  Plus,
  Trash2,
  Wallet,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { COMPANIES, USERS } from "@/lib/mock-data";
import { formatRM, formatRelative } from "@/lib/format";
import type { CompanyBankAccount } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { BankAccountFormModal } from "@/components/bank-account-form-modal";
import { BankTransferModal } from "@/components/bank-transfer-modal";
import { cn } from "@/lib/utils";

export default function BankAccountsPage() {
  const accounts = useStore((s) => s.companyBankAccounts);
  const transfers = useStore((s) => s.bankTransfers);
  const deleteAccount = useStore((s) => s.deleteCompanyBankAccount);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);

  const [formOpen, setFormOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<CompanyBankAccount | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDefaultFrom, setTransferDefaultFrom] = useState<number | null>(null);

  const filteredAccounts = useMemo(
    () =>
      accounts
        .filter((a) => selectedCompanyId === null || a.company_id === selectedCompanyId)
        .sort((a, b) => a.company_id - b.company_id || a.bank_name.localeCompare(b.bank_name)),
    [accounts, selectedCompanyId],
  );

  const activeCompany = COMPANIES.find((c) => c.company_id === selectedCompanyId);

  const totalBalance = useMemo(
    () => filteredAccounts.reduce((sum, a) => sum + a.current_balance, 0),
    [filteredAccounts],
  );
  const activeCount = filteredAccounts.filter((a) => a.status === "active").length;

  function openCreate() {
    setEditingAccount(null);
    setFormOpen(true);
  }
  function openEdit(account: CompanyBankAccount) {
    setEditingAccount(account);
    setFormOpen(true);
  }
  function handleDelete(account: CompanyBankAccount) {
    if (account.current_balance > 0) {
      toast.error(
        "Cannot delete an account with a non-zero balance. Transfer the funds out first.",
      );
      return;
    }
    if (
      !confirm(
        `Delete ${account.bank_name} ${account.account_number}? This cannot be undone.`,
      )
    )
      return;
    deleteAccount(account.account_id);
    toast.success("Bank account deleted");
  }
  function openTransferFor(account: CompanyBankAccount) {
    setTransferDefaultFrom(account.account_id);
    setTransferOpen(true);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Bank Accounts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Company-owned receiving accounts and treasury transfers
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
            Transfer
          </Button>
          <Button onClick={openCreate} size="sm" className="cursor-pointer">
            <Plus className="h-3.5 w-3.5" />
            Add Bank Account
          </Button>
        </div>
      </div>

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
            All-time treasury transfers
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden p-0 gap-0">
        <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
          <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground">
            {activeCompany
              ? activeCompany.company_name
              : "All companies"}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filteredAccounts.length} account{filteredAccounts.length === 1 ? "" : "s"} shown
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Bank</th>
                <th className="px-3 py-2.5 text-left font-medium">Account</th>
                <th className="px-3 py-2.5 text-left font-medium">Company</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">
                  Balance
                </th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAccounts.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-12 text-center text-sm text-muted-foreground"
                  >
                    No bank accounts. Click <strong>Add Bank Account</strong> to create one.
                  </td>
                </tr>
              )}
              {filteredAccounts.map((a) => {
                const company = COMPANIES.find((c) => c.company_id === a.company_id);
                return (
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
                      <div className="text-[12px] font-mono">{a.account_number}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {a.account_holder}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[12px]">
                      {company?.company_name ?? "—"}
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
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openTransferFor(a)}
                          disabled={a.status !== "active" || a.current_balance <= 0}
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
          <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Recent Internal Transfers</h2>
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
                <th className="px-3 py-2.5 text-left font-medium">Reference</th>
                <th className="px-3 py-2.5 text-left font-medium">By</th>
                <th className="px-3 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-sm text-muted-foreground"
                  >
                    No transfers yet.
                  </td>
                </tr>
              )}
              {transfers.map((t) => {
                const from = accounts.find((a) => a.account_id === t.from_account_id);
                const to = accounts.find((a) => a.account_id === t.to_account_id);
                const handler = USERS.find((u) => u.user_id === t.handled_by_user_id);
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
                          <span className="font-medium">
                            {from?.bank_name ?? "Unknown"}
                          </span>{" "}
                          <span className="font-mono text-muted-foreground">
                            {from?.account_number.slice(-4) ?? "----"}
                          </span>
                        </span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span>
                          <span className="font-medium">
                            {to?.bank_name ?? "Unknown"}
                          </span>{" "}
                          <span className="font-mono text-muted-foreground">
                            {to?.account_number.slice(-4) ?? "----"}
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
                    <td className="px-3 py-2 text-[11px] font-mono text-muted-foreground">
                      {t.reference ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {handler?.full_name ?? `User ${t.handled_by_user_id}`}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={t.status === "completed" ? "completed" : "failed"} />
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

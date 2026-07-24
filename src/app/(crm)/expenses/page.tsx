"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Plus,
  Receipt,
  Search,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/types";

const CATEGORY_META: Record<ExpenseCategory, { label: string; cls: string }> = {
  salary: { label: "Salary", cls: "bg-blue-500/10 text-blue-700" },
  sim_card: { label: "SIM Card", cls: "bg-emerald-500/10 text-emerald-700" },
  subscription: { label: "Subscription", cls: "bg-purple-500/10 text-purple-700" },
  rent: { label: "Rent", cls: "bg-amber-500/10 text-amber-700" },
  utilities: { label: "Utilities", cls: "bg-cyan-500/10 text-cyan-700" },
  equipment: { label: "Equipment", cls: "bg-slate-500/10 text-slate-700" },
  marketing: { label: "Marketing", cls: "bg-rose-500/10 text-rose-700" },
  other: { label: "Other", cls: "bg-zinc-500/10 text-zinc-700" },
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function ExpensesPage() {
  const me = useStore((s) => s.me);
  const expenses = useStore((s) => s.expenses);
  const hydrated = useStore((s) => s.hydrated);
  const userName = useStore((s) => s.userName);
  const entityName = useStore((s) => s.entityName);
  const deleteExpense = useStore((s) => s.deleteExpense);
  const companies = useStore((s) => s.companies)();

  const [dateFrom, setDateFrom] = useState(daysAgoStr(30));
  const [dateTo, setDateTo] = useState(todayStr());
  const [category, setCategory] = useState("all");
  const [companyId, setCompanyId] = useState("all");
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const isAdmin = me?.role === "super_admin";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return expenses
      .filter((e) => {
        const day = e.expense_date.slice(0, 10);
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
        if (category !== "all" && e.category !== category) return false;
        if (companyId !== "all" && String(e.company_entity_id ?? "") !== companyId)
          return false;
        if (q) {
          const hay = `${e.description} ${e.notes ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.expense_date.localeCompare(a.expense_date));
  }, [expenses, dateFrom, dateTo, category, companyId, query]);

  const total = filtered.reduce((acc, e) => acc + e.amount, 0);
  const byCategory = useMemo(() => {
    const m = new Map<ExpenseCategory, number>();
    for (const e of filtered) m.set(e.category, (m.get(e.category) ?? 0) + e.amount);
    return [...m.entries()].sort(([, a], [, b]) => b - a);
  }, [filtered]);

  async function handleDelete(expenseId: number) {
    if (deletingId !== null) return;
    setDeletingId(expenseId);
    const res = await deleteExpense(expenseId);
    setDeletingId(null);
    if (res.ok) toast.success("Expense deleted");
    else toast.error(res.error ?? "Failed to delete expense");
  }

  function setPreset(days: number | null) {
    if (days === null) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(daysAgoStr(days));
      setDateTo(todayStr());
    }
  }

  if (me && !isAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Expenses</h1>
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Only admins can view and record expenses.
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Operational spending — salaries, SIM cards, subscriptions, and more
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="shrink-0 cursor-pointer">
          <Plus className="h-3.5 w-3.5" />
          Add Expense
        </Button>
      </div>

      {/* Filters */}
      <Card className="p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                From
              </span>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 w-[140px]"
              />
            </div>
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                To
              </span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 w-[140px]"
              />
            </div>
            <div className="flex gap-1 pb-0.5">
              {(
                [
                  ["30D", 30],
                  ["90D", 90],
                  ["All", null],
                ] as const
              ).map(([label, days]) => (
                <button
                  key={label}
                  onClick={() => setPreset(days)}
                  className="h-7 cursor-pointer rounded-md border px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Category
            </span>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v ?? "all")}
              items={[
                { value: "all", label: "All Categories" },
                ...EXPENSE_CATEGORIES.map((c) => ({
                  value: c,
                  label: CATEGORY_META[c].label,
                })),
              ]}
            >
              <SelectTrigger className="h-8 w-[150px] cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  All Categories
                </SelectItem>
                {EXPENSE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="cursor-pointer">
                    {CATEGORY_META[c].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Company
            </span>
            <Select
              value={companyId}
              onValueChange={(v) => setCompanyId(v ?? "all")}
              items={[
                { value: "all", label: "All Companies" },
                ...companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                })),
              ]}
            >
              <SelectTrigger className="h-8 w-[160px] cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  All Companies
                </SelectItem>
                {companies.map((c) => (
                  <SelectItem
                    key={c.company_id}
                    value={String(c.company_id)}
                    className="cursor-pointer"
                  >
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-[180px] flex-1 space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Search
            </span>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Description, notes…"
                className="h-8 pl-8"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card className="p-0 gap-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            {filtered.length} expense{filtered.length === 1 ? "" : "s"} ·{" "}
            <span className="font-medium text-foreground">{formatRM(total)}</span>{" "}
            total
          </span>
          <div className="flex flex-wrap gap-1.5">
            {byCategory.slice(0, 4).map(([c, amt]) => (
              <span
                key={c}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                  CATEGORY_META[c].cls,
                )}
              >
                {CATEGORY_META[c].label} · {formatRM(amt)}
              </span>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date</th>
                <th className="px-3 py-2.5 text-left font-medium">Category</th>
                <th className="px-3 py-2.5 text-left font-medium">Description</th>
                <th className="px-3 py-2.5 text-left font-medium">Company</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Recorded by</th>
                <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.expense_id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2.5 text-[12px] whitespace-nowrap">
                    {e.expense_date.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
                        CATEGORY_META[e.category].cls,
                      )}
                    >
                      {CATEGORY_META[e.category].label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-[12px] font-medium">{e.description}</div>
                    {e.notes && (
                      <div className="text-[11px] text-muted-foreground truncate max-w-[280px]">
                        {e.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[12px]">
                    {e.company_entity_id != null
                      ? entityName(e.company_entity_id)
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-[12px]">
                    {userName(e.recorded_by_user_id)}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-[12px] font-medium">
                    {formatRM(e.amount)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void handleDelete(e.expense_id)}
                      disabled={deletingId !== null}
                      title="Delete"
                      className="cursor-pointer text-muted-foreground hover:text-rose-600"
                    >
                      {deletingId === e.expense_id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-12 text-center text-xs text-muted-foreground"
                  >
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading expenses…" />
                    ) : expenses.length === 0 ? (
                      "No expenses recorded yet. Use “Add Expense” to record the first one."
                    ) : (
                      "No expenses match the current filters."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot className="border-t bg-muted/40 font-medium">
                <tr>
                  <td className="px-3 py-2.5 text-[12px]" colSpan={5}>
                    Total
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap text-[12px]">
                    {formatRM(total)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      <AddExpenseDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddExpenseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createExpense = useStore((s) => s.createExpense);
  const companies = useStore((s) => s.companies)();

  const [date, setDate] = useState(todayStr());
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [companyId, setCompanyId] = useState<string>("none");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const amt = Number.parseFloat(amount);
  const isValid =
    date !== "" &&
    category !== "" &&
    description.trim() !== "" &&
    Number.isFinite(amt) &&
    amt > 0;

  function reset() {
    setDate(todayStr());
    setCategory("");
    setDescription("");
    setAmount("");
    setCompanyId("none");
    setNotes("");
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    const res = await createExpense({
      expense_date: date,
      category: category as ExpenseCategory,
      description: description.trim(),
      amount: amt,
      company_entity_id: companyId === "none" ? null : Number(companyId),
      notes: notes.trim() || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to record expense");
      return;
    }
    toast.success("Expense recorded");
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md p-0 overflow-hidden gap-0">
        <DialogTitle className="sr-only">Add expense</DialogTitle>

        <div className="flex items-center gap-3 border-b px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Receipt className="h-4.5 w-4.5" />
          </div>
          <div>
            <h2 className="text-base font-semibold leading-tight">Add expense</h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              Record an operational cost
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ex-date">
                Date <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="ex-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Category <span className="text-rose-600">*</span>
              </Label>
              <Select value={category || null} onValueChange={(v) => setCategory(v ?? "")}>
                <SelectTrigger className="h-8 w-full cursor-pointer">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c} className="cursor-pointer">
                      {CATEGORY_META[c].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ex-desc">
              Description <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="ex-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="July payroll — CS team"
              maxLength={200}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ex-amount">
                Amount (RM) <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="ex-amount"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Company (optional)</Label>
              <Select
                value={companyId}
                onValueChange={(v) => setCompanyId(v ?? "none")}
                items={[
                  { value: "none", label: "— General —" },
                  ...companies.map((c) => ({
                    value: String(c.company_id),
                    label: c.company_name,
                  })),
                ]}
              >
                <SelectTrigger className="h-8 w-full cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="cursor-pointer">
                    — General —
                  </SelectItem>
                  {companies.map((c) => (
                    <SelectItem
                      key={c.company_id}
                      value={String(c.company_id)}
                      className="cursor-pointer"
                    >
                      {c.company_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ex-notes">Notes</Label>
            <textarea
              id="ex-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Invoice #, vendor, period covered…"
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || submitting}
              className="cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Record expense
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

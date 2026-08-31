"use client";

/**
 * Transactions — the client's workbook, rebuilt as one CRM page.
 *
 * Layout mirrors the sheet they run the business from: worksheet tabs pinned
 * at the top (Deposit / Withdrawal / Game Transfer / Expenses), the company
 * info block (bank balances, kiosk credits, month totals) always visible under
 * them, and the transaction rows filling the rest of the screen in the same
 * column order as the workbook. New transactions are typed or pasted into the
 * entry rows below the green line, Excel keys throughout — see SheetGrid for
 * the keyboard model.
 */

import { useCallback, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { formatClock } from "@/lib/format";
import { extractSenderName } from "@/lib/bank-remark";
import {
  SheetGrid,
  type DraftStatus,
  type SheetColumn,
  type SheetRow,
} from "@/components/sheet/sheet-grid";
import { CompanyInfoPanel } from "@/components/sheet/company-info-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, RefreshCw, Save, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EXPENSE_CATEGORIES,
  type Deposit,
  type Expense,
  type GameTransfer,
  type Player,
  type Withdrawal,
} from "@/lib/types";

type TabKey = "deposit" | "withdrawal" | "transfer" | "expense";

const MIN_BLANK_ROWS = 8;

function sheetDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function fmtAmount(n: number): string {
  return n.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]|RM/gi, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * The workbook writes bonus rates as fractions (0.15); the CRM stores percent
 * (15). Accept both, plus "15%" — anything under 1 is read as a fraction so a
 * pasted sheet column lands right without re-typing.
 */
function parseBonusPct(raw: string): number | null {
  const cleaned = raw.replace(/[%\s]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 1 ? n * 100 : n;
}

/** "31/8/2026" (the workbook's style) or "2026-08-31" → "YYYY-MM-DD". */
function parseSheetDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${yyyy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const DEPOSIT_STATUS_LABEL: Record<Deposit["status"], string> = {
  pending_match: "Awaiting match",
  matched: "Matched",
  pending: "Pending",
  approved: "Approved",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

const WITHDRAWAL_STATUS_LABEL: Record<Withdrawal["status"], string> = {
  requested: "Requested",
  credits_pulled: "Credits pulled",
  paid: "Paid",
  failed: "Failed",
};

const TRANSFER_STATUS_LABEL: Record<GameTransfer["status"], string> = {
  pending: "Initializing",
  solving: "Solving",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

function depositTone(s: Deposit["status"]): SheetRow["tone"] {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "pending" || s === "pending_match" || s === "matched") return "warning";
  return "default";
}

function withdrawalTone(s: Withdrawal["status"]): SheetRow["tone"] {
  if (s === "paid") return "success";
  if (s === "failed") return "danger";
  if (s === "requested") return "warning";
  return "default";
}

function transferTone(s: GameTransfer["status"]): SheetRow["tone"] {
  if (s === "completed") return "success";
  if (s === "failed") return "danger";
  if (s === "pending" || s === "solving") return "warning";
  return "default";
}

function contactType(p: Player | undefined): string {
  if (!p) return "";
  if (p.telegram_username) return "Telegram";
  if (p.wechat_id) return "WeChat";
  if (p.contact_number) return "Phone";
  return "";
}

function gameUsername(p: Player | undefined, game: string | null | undefined): string {
  if (!p?.game_accounts?.length) return "";
  if (game) {
    const exact = p.game_accounts.find(
      (g) => g.game_name.toLowerCase() === game.toLowerCase(),
    );
    if (exact) return exact.game_username;
  }
  return p.game_accounts[0]?.game_username ?? "";
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: d?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

const blankRow = (n: number) => Array<string>(n).fill("");

/** Keep the entry area padded with blank rows so there is always room to type. */
function padDrafts(drafts: string[][], nCols: number): string[][] {
  const next = drafts.filter((d) => d.length === nCols || d.some((v) => v));
  let trailing = 0;
  for (let i = next.length - 1; i >= 0 && next[i].every((v) => !v); i--) trailing++;
  const want = Math.max(MIN_BLANK_ROWS - next.length, 3 - trailing);
  for (let i = 0; i < want; i++) next.push(blankRow(nCols));
  return next;
}

const ENTRY_HINT: Record<TabKey, string> = {
  deposit: "Entry: Member Code · Product · Bonus % · Bank · Amount — the rest fills itself",
  withdrawal:
    "Entry: Member Code · Product · Bank · Amount (or ALL) · Bank Account — the rest fills itself",
  transfer: "Entry: Member Code · From · To · Amount (or ALL) — the rest fills itself",
  expense: "Entry: Date · Category · Description · Amount · Company · Notes",
};

export default function TransactionsPage() {
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const gameTransfers = useStore((s) => s.gameTransfers);
  const expenses = useStore((s) => s.expenses);
  const players = useStore((s) => s.players);
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const companyInScope = useStore((s) => s.companyInScope);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const refresh = useStore((s) => s.refresh);
  const gamesFn = useStore((s) => s.games);
  const banksFn = useStore((s) => s.banks);
  const companiesFn = useStore((s) => s.companies);
  const userName = useStore((s) => s.userName);

  const games = gamesFn();
  const banks = banksFn();
  const companies = companiesFn();
  const isViewer = me?.role === "viewer";
  const isAdmin = me?.role === "super_admin";

  const [tab, setTab] = useState<TabKey>("deposit");
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [month, setMonth] = useState<string>(currentMonth);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // A status from one tab means nothing on the next — reset on switch.
  const switchTab = useCallback((next: TabKey) => {
    setTab(next);
    setStatusFilter("all");
  }, []);

  // ---- columns (sheet order, workbook labels) ----

  const columnsByTab = useMemo<Record<TabKey, SheetColumn[]>>(
    () => ({
      deposit: [
        { key: "remark", label: "Remark / Name", width: 200 },
        { key: "contact", label: "Contact Type", width: 100 },
        { key: "date", label: "Date", width: 82, align: "center" },
        { key: "time", label: "Time", width: 56, align: "center" },
        { key: "member", label: "Member Code", width: 110, entry: true, required: true },
        { key: "username", label: "Username", width: 130 },
        { key: "product", label: "Product", width: 110, entry: true, options: games },
        { key: "bonuspct", label: "Bonus %", width: 76, align: "right", numeric: true, entry: true },
        { key: "bank", label: "Bank", width: 110, entry: true, required: true, options: banks },
        { key: "amount", label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true },
        { key: "bonus", label: "Bonus", width: 90, align: "right", numeric: true },
        { key: "status", label: "Status", width: 116 },
      ],
      withdrawal: [
        { key: "date", label: "Date", width: 82, align: "center" },
        { key: "time", label: "Time", width: 56, align: "center" },
        { key: "member", label: "Member Code", width: 110, entry: true, required: true },
        { key: "username", label: "Username", width: 130 },
        { key: "product", label: "Product", width: 110, entry: true, required: true, options: games },
        { key: "bank", label: "Bank", width: 110, entry: true, options: banks },
        { key: "amount", label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true },
        { key: "account", label: "Bank Account", width: 150, entry: true },
        { key: "remark2", label: "Remark 2", width: 200 },
        { key: "status", label: "Status", width: 116 },
      ],
      transfer: [
        { key: "date", label: "Date", width: 82, align: "center" },
        { key: "time", label: "Time", width: 56, align: "center" },
        { key: "member", label: "Member Code", width: 110, entry: true, required: true },
        { key: "username", label: "Username", width: 130 },
        { key: "from", label: "From Game", width: 110, entry: true, required: true, options: games },
        { key: "to", label: "To Game", width: 110, entry: true, required: true, options: games },
        { key: "amount", label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true },
        { key: "status", label: "Status", width: 116 },
        { key: "note", label: "Note", width: 240 },
      ],
      expense: [
        { key: "date", label: "Date", width: 92, align: "center", entry: true, required: true },
        { key: "category", label: "Category", width: 110, entry: true, required: true, options: [...EXPENSE_CATEGORIES] },
        { key: "description", label: "Description", width: 260, entry: true, required: true },
        { key: "amount", label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true },
        {
          key: "company",
          label: "Company",
          width: 150,
          entry: true,
          options: companies.map((c) => c.company_name),
        },
        { key: "notes", label: "Notes", width: 240, entry: true },
        { key: "by", label: "Recorded By", width: 130 },
      ],
    }),
    [games, banks, companies],
  );

  const columns = columnsByTab[tab];

  // ---- drafts, one set per tab so switching loses nothing ----

  const [draftsByTab, setDraftsByTab] = useState<Record<TabKey, string[][]>>(() => ({
    deposit: padDrafts([], 12),
    withdrawal: padDrafts([], 10),
    transfer: padDrafts([], 9),
    expense: padDrafts([], 7),
  }));
  // Server rejections from the last save, keyed by the draft row's identity.
  const [commitErrors, setCommitErrors] = useState<Map<string, string>>(new Map());

  const drafts = draftsByTab[tab];

  const onDraftsChange = useCallback(
    (next: string[][]) =>
      setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(next, columns.length) })),
    [tab, columns.length],
  );

  // ---- lookups ----

  const playerByCode = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of players) m.set(p.username.trim().toLowerCase(), p);
    return m;
  }, [players]);

  const gameByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of games) m.set(g.toLowerCase(), g);
    return m;
  }, [games]);

  const companyByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of companies) m.set(c.company_name.trim().toLowerCase(), c.company_id);
    return m;
  }, [companies]);

  const companyNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of companies) m.set(c.company_id, c.company_name);
    return m;
  }, [companies]);

  const playerById = useMemo(() => {
    const m = new Map<number, Player>();
    for (const p of players) m.set(p.player_id, p);
    return m;
  }, [players]);

  // ---- committed rows ----

  const matchesSearch = useCallback(
    (cells: string[]) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return cells.some((c) => c.toLowerCase().includes(q));
    },
    [search],
  );

  const depositRows = useMemo<SheetRow[]>(() => {
    return deposits
      .filter((d) => d.company_entity_id === null || companyInScope(d.company_entity_id))
      .filter((d) => month === "all" || d.deposit_date.slice(0, 7) === month)
      .filter((d) => statusFilter === "all" || d.status === statusFilter)
      .sort((a, b) => a.deposit_date.localeCompare(b.deposit_date))
      .map((d) => {
        const p = d.player_id ? playerById.get(d.player_id) : undefined;
        const pct = d.bonus_percentage;
        return {
          id: d.deposit_id,
          tone: depositTone(d.status),
          cells: [
            p?.full_name ??
              extractSenderName(d.bank_description) ??
              d.bank_account_holder ??
              "",
            contactType(p),
            sheetDate(d.deposit_date),
            d.deposit_time_known ? formatClock(d.deposit_date) : "",
            d.player_username ?? p?.username ?? "",
            gameUsername(p, d.selected_game),
            d.selected_game ?? "",
            pct ? String(pct) : "",
            d.bank_name,
            fmtAmount(d.deposit_amount),
            d.bonus_amount ? fmtAmount(d.bonus_amount) : "",
            DEPOSIT_STATUS_LABEL[d.status],
          ],
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposits, playerById, month, statusFilter, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const withdrawalRows = useMemo<SheetRow[]>(() => {
    return withdrawals
      .filter((w) => {
        const p = playerById.get(w.player_id);
        return !p || companyInScope(p.company_entity_id);
      })
      .filter((w) => month === "all" || w.created_at.slice(0, 7) === month)
      .filter((w) => statusFilter === "all" || w.status === statusFilter)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((w) => {
        const p = playerById.get(w.player_id);
        const amount =
          w.status === "paid" || w.status === "credits_pulled"
            ? w.credit_pulled_amount || w.requested_amount
            : w.requested_amount;
        return {
          id: w.withdrawal_id,
          tone: withdrawalTone(w.status),
          cells: [
            sheetDate(w.created_at),
            formatClock(w.created_at),
            p?.username ?? "",
            gameUsername(p, w.game_name),
            w.game_name,
            w.bank_name ?? "",
            w.withdraw_all && !amount ? "ALL" : fmtAmount(amount),
            w.bank_account_number ?? "",
            p?.full_name ?? "",
            WITHDRAWAL_STATUS_LABEL[w.status],
          ],
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawals, playerById, month, statusFilter, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const transferRows = useMemo<SheetRow[]>(() => {
    return gameTransfers
      .filter((t) => {
        const p = playerById.get(t.player_id);
        return !p || companyInScope(p.company_entity_id);
      })
      .filter((t) => month === "all" || t.created_at.slice(0, 7) === month)
      .filter((t) => statusFilter === "all" || t.status === statusFilter)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => {
        const p = playerById.get(t.player_id);
        return {
          id: t.transfer_id,
          tone: transferTone(t.status),
          cells: [
            sheetDate(t.created_at),
            formatClock(t.created_at),
            p?.username ?? "",
            gameUsername(p, t.from_game),
            t.from_game,
            t.to_game,
            t.transfer_all && !t.transfer_amount ? "ALL" : fmtAmount(t.transfer_amount),
            TRANSFER_STATUS_LABEL[t.status],
            t.note ?? "",
          ],
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameTransfers, playerById, month, statusFilter, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const expenseRows = useMemo<SheetRow[]>(() => {
    return expenses
      .filter((e) => e.company_entity_id === null || companyInScope(e.company_entity_id))
      .filter((e) => month === "all" || e.expense_date.slice(0, 7) === month)
      .sort((a, b) => a.expense_date.localeCompare(b.expense_date))
      .map((e: Expense) => ({
        id: e.expense_id,
        tone: "default" as const,
        cells: [
          sheetDate(e.expense_date),
          e.category,
          e.description,
          fmtAmount(e.amount),
          e.company_entity_id ? (companyNameById.get(e.company_entity_id) ?? "") : "",
          e.notes ?? "",
          userName(e.recorded_by_user_id),
        ],
      }))
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, companyNameById, month, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const rowsByTab: Record<TabKey, SheetRow[]> = {
    deposit: depositRows,
    withdrawal: withdrawalRows,
    transfer: transferRows,
    expense: expenseRows,
  };
  const rows = rowsByTab[tab];

  // ---- validation ----

  type Parsed =
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; error: string };

  const parseDepositDraft = useCallback(
    (d: string[]): Parsed => {
      const [, , , , member, , product, bonuspct, bank, amount] = d;
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const amt = parseAmount(amount);
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${amount}"` };
      if (!bank.trim()) return { ok: false, error: "Bank is required" };
      let selected_game: string | undefined;
      if (product.trim()) {
        const g = gameByName.get(product.trim().toLowerCase());
        if (!g) return { ok: false, error: `Unknown product "${product.trim()}"` };
        selected_game = g;
      }
      const pct = parseBonusPct(bonuspct);
      if (pct === null) return { ok: false, error: `Bad bonus % "${bonuspct}"` };
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          amount: amt,
          bank_name: bank.trim(),
          // Entered from the workbook = the money is already in the bank, so it
          // goes straight to the CS queue instead of waiting for a bank match.
          status: "pending",
          ...(selected_game ? { selected_game } : {}),
          ...(pct ? { bonus_percentage: pct } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseWithdrawalDraft = useCallback(
    (d: string[]): Parsed => {
      const [, , member, , product, bank, amount, account] = d;
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const g = gameByName.get(product.trim().toLowerCase());
      if (!g) return { ok: false, error: `Unknown product "${product.trim()}"` };
      const all = amount.trim().toLowerCase() === "all";
      const amt = all ? null : parseAmount(amount);
      if (!all && (amt === null || amt <= 0))
        return { ok: false, error: `Bad amount "${amount}" (number or ALL)` };
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          game_name: g,
          ...(all ? { withdraw_all: true } : { requested_amount: amt }),
          ...(bank.trim() ? { bank_name: bank.trim() } : {}),
          ...(account.trim() ? { bank_account_number: account.trim() } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseTransferDraft = useCallback(
    (d: string[]): Parsed => {
      const [, , member, , from, to, amount] = d;
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const fromGame = gameByName.get(from.trim().toLowerCase());
      if (!fromGame) return { ok: false, error: `Unknown game "${from.trim()}"` };
      const toGame = gameByName.get(to.trim().toLowerCase());
      if (!toGame) return { ok: false, error: `Unknown game "${to.trim()}"` };
      if (fromGame === toGame) return { ok: false, error: "From and To are the same game" };
      const all = amount.trim().toLowerCase() === "all";
      const amt = all ? null : parseAmount(amount);
      if (!all && (amt === null || amt <= 0))
        return { ok: false, error: `Bad amount "${amount}" (number or ALL)` };
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          from_game: fromGame,
          to_game: toGame,
          ...(all ? { transfer_all: true } : { amount: amt }),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseExpenseDraft = useCallback(
    (d: string[]): Parsed => {
      const [date, category, description, amount, company, notes] = d;
      const expense_date = date.trim()
        ? parseSheetDate(date)
        : new Date().toISOString().slice(0, 10);
      if (!expense_date) return { ok: false, error: `Bad date "${date.trim()}" (use 31/8/2026)` };
      const cat = category.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!(EXPENSE_CATEGORIES as readonly string[]).includes(cat))
        return { ok: false, error: `Unknown category "${category.trim()}"` };
      if (!description.trim()) return { ok: false, error: "Description is required" };
      const amt = parseAmount(amount);
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${amount}"` };
      let company_entity_id: number | null = null;
      if (company.trim()) {
        const id = companyByName.get(company.trim().toLowerCase());
        if (!id) return { ok: false, error: `Unknown company "${company.trim()}"` };
        company_entity_id = id;
      }
      return {
        ok: true,
        payload: {
          expense_date,
          category: cat,
          description: description.trim(),
          amount: amt,
          company_entity_id,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      };
    },
    [companyByName],
  );

  const parseByTab: Record<TabKey, (d: string[]) => Parsed> = {
    deposit: parseDepositDraft,
    withdrawal: parseWithdrawalDraft,
    transfer: parseTransferDraft,
    expense: parseExpenseDraft,
  };
  const parseDraft = parseByTab[tab];

  const draftKey = useCallback((d: string[]) => `${tab}:${d.join(" ")}`, [tab]);

  const draftStatus = useCallback(
    (d: string[]): DraftStatus => {
      if (d.every((v) => !v.trim())) return { state: "empty" };
      const rejected = commitErrors.get(draftKey(d));
      if (rejected) return { state: "error", message: rejected };
      const parsed = parseDraft(d);
      return parsed.ok
        ? { state: "ready" }
        : { state: "error", message: parsed.error };
    },
    [parseDraft, commitErrors, draftKey],
  );

  const readyCount = useMemo(
    () => drafts.filter((d) => draftStatus(d).state === "ready").length,
    [drafts, draftStatus],
  );

  // ---- commit ----

  const COMMIT_PATH: Record<TabKey, string> = {
    deposit: "/api/deposits",
    withdrawal: "/api/withdrawals",
    transfer: "/api/game-transfers",
    expense: "/api/expenses",
  };

  const handleCommit = useCallback(async () => {
    if (saving || isViewer) return;
    const jobs = drafts
      .map((d, i) => ({ d, i, parsed: parseDraft(d) }))
      .filter((j) => !j.d.every((v) => !v.trim()) && j.parsed.ok) as Array<{
      d: string[];
      i: number;
      parsed: { ok: true; payload: Record<string, unknown> };
    }>;
    if (!jobs.length) {
      toast.info("No ready rows to save — fix the rows marked ! first.");
      return;
    }
    setSaving(true);
    const path = COMMIT_PATH[tab];
    const succeeded = new Set<number>();
    const failures = new Map<string, string>(commitErrors);
    // Sequential on purpose: keeps server order = sheet order, and one clear
    // error per row instead of a burst of races.
    for (const job of jobs) {
      const res = await post(path, job.parsed.payload);
      if (res.ok) {
        succeeded.add(job.i);
        failures.delete(draftKey(job.d));
      } else {
        failures.set(draftKey(job.d), res.error ?? "Save failed");
      }
    }
    const remaining = drafts.filter((_, i) => !succeeded.has(i));
    setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(remaining, columns.length) }));
    setCommitErrors(failures);
    setSaving(false);
    await refresh();
    const failed = jobs.length - succeeded.size;
    const noun = { deposit: "deposit", withdrawal: "withdrawal", transfer: "transfer", expense: "expense" }[tab];
    if (failed) {
      toast.error(
        `${succeeded.size} saved, ${failed} rejected — rejected rows stay below with the reason on the ! marker.`,
      );
    } else {
      toast.success(`${succeeded.size} ${noun}${succeeded.size === 1 ? "" : "s"} saved`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, isViewer, drafts, parseDraft, tab, commitErrors, draftKey, columns.length, refresh]);

  // ---- filters ----

  const monthOptions = useMemo(() => {
    const set = new Set<string>([currentMonth]);
    for (const d of deposits) set.add(d.deposit_date.slice(0, 7));
    for (const w of withdrawals) set.add(w.created_at.slice(0, 7));
    for (const t of gameTransfers) set.add(t.created_at.slice(0, 7));
    for (const e of expenses) set.add(e.expense_date.slice(0, 7));
    return [...set].sort().reverse();
  }, [deposits, withdrawals, gameTransfers, expenses, currentMonth]);

  const statusOptionsByTab: Record<TabKey, [string, string][]> = {
    deposit: Object.entries(DEPOSIT_STATUS_LABEL),
    withdrawal: Object.entries(WITHDRAWAL_STATUS_LABEL),
    transfer: Object.entries(TRANSFER_STATUS_LABEL),
    expense: [],
  };
  const statusOptions = statusOptionsByTab[tab];

  const tabs: { key: TabKey; label: string }[] = [
    { key: "deposit", label: "Deposit" },
    { key: "withdrawal", label: "Withdrawal" },
    { key: "transfer", label: "Game Transfer" },
    // Expenses are super-admin only — same rule as the Expenses page itself.
    ...(isAdmin ? [{ key: "expense" as const, label: "Expenses" }] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Worksheet tabs — pinned at the very top, Excel style. */}
      <div className="flex shrink-0 items-end gap-0.5 border-b border-border bg-muted/40 px-2 pt-1.5">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            className={cn(
              "cursor-pointer rounded-t-md border border-b-0 border-border px-4 py-1.5 text-[13px]",
              tab === key
                ? "-mb-px border-t-2 border-t-emerald-600 bg-background font-semibold text-emerald-700 dark:border-t-emerald-400 dark:text-emerald-400"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-3 pb-1.5 text-[11px] text-muted-foreground">
          {ENTRY_HINT[tab]}
        </span>
      </div>

      {/* Always-on-top company info, like the workbook's frozen rows. */}
      <div className="shrink-0 px-3 pt-2">
        <CompanyInfoPanel month={month === "all" ? "all" : month} />
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rows…"
            className="h-8 w-52 pl-7 text-[13px]"
          />
        </div>
        <Select value={month} onValueChange={(v) => setMonth(v ?? "all")}>
          <SelectTrigger className="h-8 w-36 cursor-pointer text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All months</SelectItem>
            {monthOptions.map((m) => (
              <SelectItem key={m} value={m}>
                {new Date(`${m}-01T00:00:00`).toLocaleString("en-US", {
                  month: "short",
                  year: "numeric",
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {statusOptions.length > 0 && (
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-40 cursor-pointer text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statusOptions.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-xs text-muted-foreground">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer gap-1.5"
            onClick={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
          {!isViewer && (
            <Button
              size="sm"
              className="h-8 cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
              disabled={saving || readyCount === 0}
              onClick={handleCommit}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save {readyCount > 0 ? `${readyCount} row${readyCount === 1 ? "" : "s"}` : "rows"}
              <span className="hidden text-[10px] opacity-70 lg:inline">Ctrl+↵</span>
            </Button>
          )}
        </div>
      </div>

      {/* The grid fills everything that's left. */}
      <SheetGrid
        key={tab}
        columns={columns}
        rows={rows}
        drafts={drafts}
        onDraftsChange={onDraftsChange}
        draftStatus={draftStatus}
        onCommit={handleCommit}
        readOnly={isViewer}
        // Re-fires after hydration so the initial jump lands on the entry
        // rows once the committed rows are actually there.
        focusKey={`${tab}:${hydrated}`}
      />
    </div>
  );
}

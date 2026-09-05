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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { formatClock, formatRelative, formatRM } from "@/lib/format";
import { extractSenderName } from "@/lib/bank-remark";
import { usePlayerProfile } from "@/components/player-name-link";
import {
  SheetGrid,
  type DraftStatus,
  type SheetColumn,
  type SheetRow,
  type SheetSuggestion,
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
import {
  ConfirmActionDialog,
  type SummaryRow,
} from "@/components/confirm-action-dialog";
import {
  Ban,
  CheckCircle2,
  HandCoins,
  Loader2,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  User,
  UserCheck,
  UserMinus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BONUS_PERIOD_LABELS,
  BONUS_TYPE_LABELS,
  EXPENSE_CATEGORIES,
  OPEN_BOT_COMMAND_STATUSES,
  type BonusOption,
  type BotCommand,
  type Deposit,
  type Expense,
  type GameTransfer,
  type Player,
  type Withdrawal,
} from "@/lib/types";

type TabKey = "deposit" | "withdrawal" | "freecredit" | "transfer" | "expense";

/**
 * Column order per sheet, in workflow order: who handles it, then everything
 * CS fills in for a new row (grouped so a Tab-run walks straight through
 * them), then what the CRM derives — status, when it happened, remarks.
 * Every column index in this file comes from here, so reordering a sheet is
 * a one-line change.
 */
const COLUMN_KEYS = {
  deposit: [
    "assignee", "member", "product", "username", "amount", "bonuspct", "bonus",
    "bank", "status", "date", "time", "remark", "bankdesc",
  ],
  withdrawal: [
    "assignee", "member", "product", "username", "amount", "bank", "account",
    "status", "date", "time", "remark2",
  ],
  freecredit: [
    "by", "member", "product", "username", "amount", "mode", "remark",
    "status", "date", "time",
  ],
  transfer: [
    "assignee", "member", "from", "username", "to", "amount",
    "status", "date", "time", "note",
  ],
  expense: ["by", "date", "category", "description", "amount", "company", "notes"],
} as const satisfies Record<TabKey, readonly string[]>;

type ColKey<T extends TabKey> = (typeof COLUMN_KEYS)[T][number];

/** Column index by key, per sheet: `COL.deposit.amount`. */
const COL = Object.fromEntries(
  (Object.keys(COLUMN_KEYS) as TabKey[]).map((tab) => [
    tab,
    Object.fromEntries(COLUMN_KEYS[tab].map((k, i) => [k, i])),
  ]),
) as { [T in TabKey]: Record<ColKey<T>, number> };

/** Cells in a sheet's column order from a record keyed by column. */
function toCells<T extends TabKey>(tab: T, rec: Partial<Record<ColKey<T>, string>>): string[] {
  return (COLUMN_KEYS[tab] as readonly ColKey<T>[]).map((k) => rec[k] ?? "");
}

/** Per tab, which entry cell holds the game login and which holds its game. */
const LOGIN_COLS: Record<TabKey, { userCol: number; gameCol: number } | null> = {
  deposit: { userCol: COL.deposit.username, gameCol: COL.deposit.product },
  withdrawal: { userCol: COL.withdrawal.username, gameCol: COL.withdrawal.product },
  freecredit: { userCol: COL.freecredit.username, gameCol: COL.freecredit.product },
  transfer: { userCol: COL.transfer.username, gameCol: COL.transfer.from },
  expense: null,
};

/** One Free Credit ledger row, as GET /api/free-credits returns it. */
type FreeCredit = {
  transaction_id: number;
  created_at: string;
  player_id: number | null;
  entity_id: number | null;
  game_name: string | null;
  amount: number;
  user_id: number | null;
  reason: string | null;
  source: string;
  game_transfer_id: number | null;
};

const MIN_BLANK_ROWS = 8;

function sheetDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

/** Today, the workbook's way — what a fresh entry row's Date cell shows. */
function todaySheetDate(): string {
  const d = new Date();
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
  // "—"/"-" is the blank-bonus display; read it back as no bonus.
  if (!cleaned || cleaned === "—" || cleaned === "-") return 0;
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

/**
 * A fresh entry row. Not quite empty: the Date cell is pre-filled with today,
 * since a row typed now happened now (the server stamps the real time at
 * save; a bot-sourced row shows its own date and time once it's committed).
 */
function blankRow(tab: TabKey): string[] {
  const row = Array<string>(COLUMN_KEYS[tab].length).fill("");
  const dateCol = (COL[tab] as Record<string, number | undefined>).date;
  if (dateCol !== undefined) row[dateCol] = todaySheetDate();
  return row;
}

/**
 * "Blank" for an entry row means nothing typed — the auto-filled Date cell
 * doesn't count, or every padding row would read as a half-entered one.
 */
function isBlankDraft(tab: TabKey, d: string[]): boolean {
  const dateCol = (COL[tab] as Record<string, number | undefined>).date;
  return d.every((v, i) => i === dateCol || !v.trim());
}

/** Keep the entry area padded with blank rows so there is always room to type. */
function padDrafts(drafts: string[][], tab: TabKey): string[][] {
  const nCols = COLUMN_KEYS[tab].length;
  const next = drafts.filter((d) => d.length === nCols || d.some((v) => v));
  let trailing = 0;
  for (let i = next.length - 1; i >= 0 && isBlankDraft(tab, next[i]); i--) trailing++;
  const want = Math.max(MIN_BLANK_ROWS - next.length, 3 - trailing);
  for (let i = 0; i < want; i++) next.push(blankRow(tab));
  return next;
}

/**
 * Deposit drafts derive their Bonus cell: amount x bonus %. Recomputed on
 * every draft change so it tracks both inputs and clears when either goes.
 * (For a rebate plan the true basis is the period loss, not the deposit — the
 * server computes the real figure at save; this cell is the entry-time view.)
 */
function computeDepositBonus(drafts: string[][]): string[][] {
  const c = COL.deposit;
  return drafts.map((row) => {
    const amt = parseAmount(row[c.amount] ?? "");
    const pct = parseBonusPct(row[c.bonuspct] ?? "");
    const bonus = amt && pct ? fmtAmount((amt * pct) / 100) : "";
    if ((row[c.bonus] ?? "") === bonus) return row;
    const out = [...row];
    out[c.bonus] = bonus;
    return out;
  });
}

/** Cmd on macOS, Ctrl everywhere else — both for matching and for the chips. */
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const MOD_LABEL = IS_MAC ? "\u2318" : "Ctrl+";

/** Shortcut chip shown inside action buttons. `light` for solid backgrounds. */
/** The Crawl banks tooltip — what the last crawl did, in one line. */
function crawlHint(cmd: BotCommand | null): string {
  if (!cmd) {
    return "Re-read the banks now instead of waiting for the agent's next sweep";
  }
  const when = formatRelative(cmd.completed_at ?? cmd.created_at);
  switch (cmd.status) {
    case "pending":
      return `Queued ${when} — waiting for an agent to pick it up`;
    case "running":
      return `Crawling since ${when}${cmd.bot_id ? ` · ${cmd.bot_id}` : ""}`;
    case "completed": {
      const found = Number(cmd.result?.deposits_created ?? NaN);
      const seen = Number(cmd.result?.transactions_found ?? NaN);
      const detail = Number.isFinite(found)
        ? found === 1
          ? "1 new deposit"
          : `${found} new deposits`
        : Number.isFinite(seen)
          ? `${seen} transactions read`
          : "nothing reported";
      return `Last crawl finished ${when} — ${detail}`;
    }
    case "failed":
      return `Last crawl failed ${when}${cmd.error ? ` — ${cmd.error}` : ""}`;
    case "expired":
      return `Last crawl expired ${when} — no agent picked it up`;
  }
}

function Kbd({ k, light }: { k: string; light?: boolean }) {
  return (
    <kbd
      className={
        light
          ? "ml-0.5 rounded border border-white/40 bg-white/20 px-1 text-[10px] font-semibold text-white"
          : "ml-0.5 rounded border border-border bg-muted px-1 text-[10px] font-semibold text-muted-foreground"
      }
    >
      {k}
    </kbd>
  );
}

const ENTRY_HINT: Record<TabKey, string> = {
  deposit: "Entry: Member Code · Product · Bonus % · Bank · Amount — the rest fills itself",
  withdrawal:
    "Entry: Member Code · Product · Bank · Amount (or ALL) · Bank Account — the rest fills itself",
  freecredit:
    "Entry: Member Code · Product · Amount · Mode (bot / manual) · Remark — credit with no deposit behind it",
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
  const { openPlayer } = usePlayerProfile();
  const companyInScope = useStore((s) => s.companyInScope);
  const botCommands = useStore((s) => s.botCommands);
  const requestBankCrawl = useStore((s) => s.requestBankCrawl);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const refresh = useStore((s) => s.refresh);
  const setAssignment = useStore((s) => s.setAssignment);
  const updateDepositDraft = useStore((s) => s.updateDepositDraft);
  const approveDeposit = useStore((s) => s.approveDeposit);
  const completeDeposit = useStore((s) => s.completeDeposit);
  const rejectDeposit = useStore((s) => s.rejectDeposit);
  const reprocessDeposit = useStore((s) => s.reprocessDeposit);
  const pullCreditsForWithdrawal = useStore((s) => s.pullCreditsForWithdrawal);
  const markWithdrawalPaid = useStore((s) => s.markWithdrawalPaid);
  const rejectWithdrawal = useStore((s) => s.rejectWithdrawal);
  const reprocessGameTransfer = useStore((s) => s.reprocessGameTransfer);
  const deleteExpense = useStore((s) => s.deleteExpense);
  const fetchBonusOptions = useStore((s) => s.fetchBonusOptions);
  const gamesFn = useStore((s) => s.games);
  const banksFn = useStore((s) => s.banks);
  const companiesFn = useStore((s) => s.companies);
  const userName = useStore((s) => s.userName);

  const games = gamesFn();
  const banks = banksFn();
  const companies = companiesFn();
  const isViewer = me?.role === "viewer";
  const isAdmin = me?.role === "super_admin";

  // The Free Credit ledger lives outside /api/state — fetched here and
  // re-fetched alongside every store refresh this page triggers.
  const [freeCredits, setFreeCredits] = useState<FreeCredit[]>([]);
  const loadFreeCredits = useCallback(async () => {
    try {
      const res = await fetch("/api/free-credits");
      if (!res.ok) return;
      const data = (await res.json()) as { free_credits?: FreeCredit[] };
      setFreeCredits(data.free_credits ?? []);
    } catch {
      // Poll/refresh will retry; the tab just shows what it last had.
    }
  }, []);
  useEffect(() => {
    // Fetch-on-mount; the setState happens after the await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFreeCredits();
  }, [loadFreeCredits]);

  const [tab, setTab] = useState<TabKey>("deposit");
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [month, setMonth] = useState<string>(currentMonth);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [crawlRequesting, setCrawlRequesting] = useState(false);
  // Committed rows currently selected in the grid — what the action bar acts on.
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [acting, setActing] = useState(false);
  const [confirming, setConfirming] = useState<{
    kind: "reject-deposit" | "reject-withdrawal" | "delete-expense";
    ids: number[];
  } | null>(null);

  // A status from one tab means nothing on the next — reset on switch.
  const switchTab = useCallback((next: TabKey) => {
    setTab(next);
    setStatusFilter("all");
    setSelectedIds([]);
  }, []);

  // ---- columns (sheet order, workbook labels) ----

  // Typeahead for Member Code cells: every player in scope, code + name, so
  // CS can type a few letters of either and arrow-key the right one in.
  const memberSuggestions = useMemo(
    () =>
      players
        .filter((p) => companyInScope(p.company_entity_id))
        .map((p) => ({ value: p.username, hint: p.full_name })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [players, selectedCompanyId, selectedLeaderId],
  );

  const MODE_SUGGESTIONS = useMemo(
    () => [
      { value: "bot", hint: "agent tops up the game" },
      { value: "manual", hint: "CS already credited it in the back-office" },
    ],
    [],
  );

  // Column definitions by key; COLUMN_KEYS decides the order they appear in.
  const columnsByTab = useMemo<Record<TabKey, SheetColumn[]>>(() => {
    type Def = Omit<SheetColumn, "key">;
    const member: Def = { label: "Member Code", width: 110, entry: true, required: true, options: memberSuggestions, placeholder: "member code" };
    const username: Def = { label: "Username", width: 130, entry: true, placeholder: "game login" };
    const date: Def = { label: "Date", width: 82, align: "center" };
    const time: Def = { label: "Time", width: 56, align: "center" };
    const status: Def = { label: "Status", width: 116 };
    const assignee: Def = { label: "Assignee", width: 110 };
    const order = <T extends TabKey>(tab: T, defs: Record<ColKey<T>, Def>): SheetColumn[] =>
      (COLUMN_KEYS[tab] as readonly ColKey<T>[]).map((key) => ({ key, ...defs[key] }));
    return {
      deposit: order("deposit", {
        assignee,
        member,
        product: { label: "Product", width: 110, entry: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100" },
        bonuspct: { label: "Bonus %", width: 76, align: "right", numeric: true, entry: true, placeholder: "10", dropdown: true },
        bonus: { label: "Bonus", width: 90, align: "right", numeric: true },
        bank: { label: "Bank", width: 110, entry: true, required: true, options: banks, placeholder: "bank" },
        status,
        date,
        time,
        remark: { label: "Remark / Name", width: 200 },
        bankdesc: { label: "Bank Description", width: 260 },
      }),
      withdrawal: order("withdrawal", {
        assignee,
        member,
        product: { label: "Product", width: 110, entry: true, required: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100 / ALL" },
        bank: { label: "Bank", width: 110, entry: true, options: banks, placeholder: "bank" },
        account: { label: "Bank Account", width: 150, entry: true, placeholder: "account no." },
        status,
        date,
        time,
        remark2: { label: "Remark 2", width: 200 },
      }),
      freecredit: order("freecredit", {
        by: { label: "By", width: 130 },
        member,
        product: { label: "Product", width: 110, entry: true, required: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "50" },
        mode: { label: "Mode", width: 90, entry: true, options: MODE_SUGGESTIONS, placeholder: "bot / manual" },
        remark: { label: "Remark", width: 220, entry: true, placeholder: "reason (optional)" },
        status,
        date,
        time,
      }),
      transfer: order("transfer", {
        assignee,
        member,
        from: { label: "From Game", width: 110, entry: true, required: true, options: games, placeholder: "from game" },
        username,
        to: { label: "To Game", width: 110, entry: true, required: true, options: games, placeholder: "to game" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100 / ALL" },
        status,
        date,
        time,
        note: { label: "Note", width: 240 },
      }),
      expense: order("expense", {
        by: { label: "Recorded By", width: 130 },
        date: { label: "Date", width: 92, align: "center", entry: true, required: true, placeholder: "31/8/2026" },
        category: { label: "Category", width: 110, entry: true, required: true, options: [...EXPENSE_CATEGORIES], placeholder: "category" },
        description: { label: "Description", width: 260, entry: true, required: true, placeholder: "what it's for" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100" },
        company: { label: "Company", width: 150, entry: true, options: companies.map((c) => c.company_name), placeholder: "company" },
        notes: { label: "Notes", width: 240, entry: true, placeholder: "notes (optional)" },
      }),
    };
  }, [games, banks, companies, memberSuggestions, MODE_SUGGESTIONS]);

  const columns = columnsByTab[tab];

  // ---- drafts, one set per tab so switching loses nothing ----

  const [draftsByTab, setDraftsByTab] = useState<Record<TabKey, string[][]>>(() => ({
    deposit: padDrafts([], "deposit"),
    withdrawal: padDrafts([], "withdrawal"),
    freecredit: padDrafts([], "freecredit"),
    transfer: padDrafts([], "transfer"),
    expense: padDrafts([], "expense"),
  }));
  // Server rejections from the last save, keyed by the draft row's identity.
  const [commitErrors, setCommitErrors] = useState<Map<string, string>>(new Map());

  const drafts = draftsByTab[tab];

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

  const depositById = useMemo(() => {
    const m = new Map<number, Deposit>();
    for (const d of deposits) m.set(d.deposit_id, d);
    return m;
  }, [deposits]);

  /**
   * When a row's Member Code changes and resolves, pre-fill the rest of the
   * row from the player record — their last added game and its username, their
   * saved bank for a payout, their name. Only empty cells are filled, so a
   * typed or pasted value always wins, and it fires only on the member cell
   * actually changing, so clearing an auto-filled cell doesn't re-fill it.
   */
  const enrichMemberChanges = useCallback(
    (prev: string[][], next: string[][]): string[][] => {
      if (tab === "expense") return next;
      const memberCol = COL[tab].member;
      return next.map((row, i) => {
        const member = row[memberCol]?.trim().toLowerCase() ?? "";
        const prevMember = prev[i]?.[memberCol]?.trim().toLowerCase() ?? "";
        if (!member || member === prevMember) return row;
        const pl = playerByCode.get(member);
        if (!pl) return row;
        const out = [...row];
        const fill = (idx: number, val: string | undefined | null) => {
          if (val && !out[idx]?.trim()) out[idx] = val;
        };
        // "Last added" = the tail of the list; accounts are appended as CS
        // links them, so the tail is the one the player is currently on.
        const lastGame = pl.game_accounts?.length
          ? pl.game_accounts[pl.game_accounts.length - 1]
          : undefined;
        const lastBank = pl.bank_accounts?.length
          ? pl.bank_accounts[pl.bank_accounts.length - 1]
          : undefined;
        if (tab === "deposit") {
          const c = COL.deposit;
          fill(c.remark, pl.full_name);
          fill(c.username, lastGame?.game_username);
          fill(c.product, lastGame?.game_name);
        } else if (tab === "withdrawal") {
          const c = COL.withdrawal;
          fill(c.username, lastGame?.game_username);
          fill(c.product, lastGame?.game_name);
          fill(c.bank, lastBank?.bank_name);
          fill(c.account, lastBank?.account_number);
          fill(c.remark2, pl.full_name);
        } else if (tab === "freecredit") {
          const c = COL.freecredit;
          fill(c.username, lastGame?.game_username);
          fill(c.product, lastGame?.game_name);
        } else if (tab === "transfer") {
          const c = COL.transfer;
          fill(c.username, lastGame?.game_username);
          fill(c.from, lastGame?.game_name);
        }
        return out;
      });
    },
    [tab, playerByCode],
  );

  const onDraftsChange = useCallback(
    (next: string[][]) =>
      setDraftsByTab((prev) => {
        let processed = enrichMemberChanges(prev[tab], next);
        if (tab === "deposit") processed = computeDepositBonus(processed);
        return { ...prev, [tab]: padDrafts(processed, tab) };
      }),
    [tab, enrichMemberChanges],
  );


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
          cells: toCells("deposit", {
            assignee: d.assigned_to_user_id ? userName(d.assigned_to_user_id) : "",
            member: d.player_username ?? p?.username ?? "",
            product: d.selected_game ?? "",
            username: gameUsername(p, d.selected_game),
            amount: fmtAmount(d.deposit_amount),
            bonuspct: pct ? `${pct}%` : "—",
            bonus: d.bonus_amount ? fmtAmount(d.bonus_amount) : "—",
            bank: d.bank_name,
            status: DEPOSIT_STATUS_LABEL[d.status],
            // Bot-matched rows carry the bank's own timestamp; a sheet-entered
            // row only knows its date.
            date: sheetDate(d.deposit_date),
            time: d.deposit_time_known ? formatClock(d.deposit_date) : "",
            remark:
              p?.full_name ??
              extractSenderName(d.bank_description) ??
              d.bank_account_holder ??
              "",
            bankdesc: d.bank_description ?? "",
          }),
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
          cells: toCells("withdrawal", {
            assignee: w.assigned_to_user_id ? userName(w.assigned_to_user_id) : "",
            member: p?.username ?? "",
            product: w.game_name,
            username: gameUsername(p, w.game_name),
            amount: w.withdraw_all && !amount ? "ALL" : fmtAmount(amount),
            bank: w.bank_name ?? "",
            account: w.bank_account_number ?? "",
            status: WITHDRAWAL_STATUS_LABEL[w.status],
            date: sheetDate(w.created_at),
            time: formatClock(w.created_at),
            remark2: p?.full_name ?? "",
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawals, playerById, month, statusFilter, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const freeCreditRows = useMemo<SheetRow[]>(() => {
    // Live status for agent-queued rows comes off the referenced transfer.
    const transferById = new Map(gameTransfers.map((t) => [t.transfer_id, t]));
    return [...freeCredits]
      .filter((f) => f.entity_id === null || companyInScope(f.entity_id))
      .filter((f) => month === "all" || f.created_at.slice(0, 7) === month)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((f) => {
        const p = f.player_id ? playerById.get(f.player_id) : undefined;
        const transfer =
          f.game_transfer_id != null ? transferById.get(f.game_transfer_id) : undefined;
        const manual = f.source === "manual";
        // A completed transfer's figure is what the agent really moved.
        const amount =
          transfer && transfer.status === "completed"
            ? transfer.transfer_amount
            : f.amount;
        return {
          id: f.transaction_id,
          tone: manual
            ? ("success" as const)
            : transfer
              ? transferTone(transfer.status)
              : ("warning" as const),
          cells: toCells("freecredit", {
            by: userName(f.user_id),
            member: p?.username ?? "",
            product: f.game_name ?? "",
            username: gameUsername(p, f.game_name),
            amount: fmtAmount(amount),
            mode: manual ? "manual" : "bot",
            remark: f.reason ?? "",
            status: manual
              ? "Credited"
              : transfer
                ? TRANSFER_STATUS_LABEL[transfer.status]
                : "Queued",
            date: sheetDate(f.created_at),
            time: formatClock(f.created_at),
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeCredits, gameTransfers, playerById, month, matchesSearch, selectedCompanyId, selectedLeaderId]);

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
          cells: toCells("transfer", {
            assignee: t.assigned_to_user_id ? userName(t.assigned_to_user_id) : "",
            member: p?.username ?? "",
            from: t.from_game,
            username: gameUsername(p, t.from_game),
            to: t.to_game,
            amount: t.transfer_all && !t.transfer_amount ? "ALL" : fmtAmount(t.transfer_amount),
            status: TRANSFER_STATUS_LABEL[t.status],
            date: sheetDate(t.created_at),
            time: formatClock(t.created_at),
            note: t.note ?? "",
          }),
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
        cells: toCells("expense", {
          by: userName(e.recorded_by_user_id),
          date: sheetDate(e.expense_date),
          category: e.category,
          description: e.description,
          amount: fmtAmount(e.amount),
          company: e.company_entity_id ? (companyNameById.get(e.company_entity_id) ?? "") : "",
          notes: e.notes ?? "",
        }),
      }))
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, companyNameById, month, matchesSearch, selectedCompanyId, selectedLeaderId]);

  const rowsByTab: Record<TabKey, SheetRow[]> = {
    deposit: depositRows,
    withdrawal: withdrawalRows,
    freecredit: freeCreditRows,
    transfer: transferRows,
    expense: expenseRows,
  };
  const rows = rowsByTab[tab];

  // ---- bonus-plan typeahead for the deposit Bonus % cell ----

  // Eligibility fetched per player+amount, cached for the session. The value
  // that lands in the cell is just the percentage; the dropdown carries the
  // plan name and the computed bonus so the pick is informed.
  const [bonusOptionsCache, setBonusOptionsCache] = useState<Map<string, BonusOption[]>>(
    () => new Map(),
  );
  const bonusFetchInFlight = useRef<Set<string>>(new Set());

  const loadBonusOptions = useCallback(
    (playerId: number, amount: number, depositId?: number) => {
      const key = `${playerId}:${amount}:${depositId ?? 0}`;
      if (bonusOptionsCache.has(key) || bonusFetchInFlight.current.has(key)) return;
      bonusFetchInFlight.current.add(key);
      void fetchBonusOptions({ playerId, amount, depositId }).then((res) => {
        bonusFetchInFlight.current.delete(key);
        if (res.ok && res.options) {
          const options = res.options;
          setBonusOptionsCache((prev) => new Map(prev).set(key, options));
        }
      });
    },
    [bonusOptionsCache, fetchBonusOptions],
  );

  const handleEditStart = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (tab !== "deposit" || colIndex !== COL.deposit.bonuspct) return;
      if (rowIndex >= rows.length) {
        const d = drafts[rowIndex - rows.length];
        const pl = d
          ? playerByCode.get(d[COL.deposit.member]?.trim().toLowerCase() ?? "")
          : undefined;
        if (pl) loadBonusOptions(pl.player_id, parseAmount(d[COL.deposit.amount] ?? "") ?? 0);
      } else {
        // In-place edit on a saved pending deposit — pass the deposit id so a
        // recurring bonus doesn't count this very deposit against itself.
        const dep = depositById.get(Number(rows[rowIndex]?.id));
        if (dep?.player_id) {
          loadBonusOptions(dep.player_id, dep.deposit_amount, dep.deposit_id);
        }
      }
    },
    [tab, drafts, rows, playerByCode, depositById, loadBonusOptions],
  );

  /** BonusPicker-style rows from the fetched eligibility. */
  const buildBonusSuggestions = useCallback(
    (options: BonusOption[] | undefined, amt: number): SheetSuggestion[] => {
      if (!options) {
        return [
          { value: "", title: "Checking what this player qualifies for…", disabled: true },
        ];
      }
      const list: SheetSuggestion[] = [{ value: "", title: "No bonus" }];
      for (const o of options) {
        const badge = o.period ? BONUS_PERIOD_LABELS[o.period] : BONUS_TYPE_LABELS[o.type];
        if (o.eligible) {
          list.push({
            value: `${o.percentage}%`,
            title: o.name,
            badge,
            detail: `${o.percentage}% of ${
              o.type === "rebate" ? `${formatRM(o.basis_amount)} lost` : "the deposit"
            }`,
            figure: amt > 0 ? formatRM(o.bonus_amount) : `${o.percentage}%`,
          });
        } else {
          list.push({
            value: "",
            title: o.name,
            badge,
            detail: o.reason ?? "Not eligible",
            detailTone: "warning",
            figure: "—",
            disabled: true,
          });
        }
      }
      return list;
    },
    [],
  );

  const committedSuggestions = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (tab !== "deposit" || colIndex !== COL.deposit.bonuspct) return undefined;
      const dep = depositById.get(Number(rows[rowIndex]?.id));
      if (!dep?.player_id) return undefined;
      return buildBonusSuggestions(
        bonusOptionsCache.get(`${dep.player_id}:${dep.deposit_amount}:${dep.deposit_id}`),
        dep.deposit_amount,
      );
    },
    [tab, rows, depositById, bonusOptionsCache, buildBonusSuggestions],
  );

  const draftSuggestions = useCallback(
    (draftIndex: number, colIndex: number) => {
      const d = drafts[draftIndex];
      // Login picker: the player's linked logins for the row's game, so CS can
      // choose which account under that game the transaction hits.
      const loginCfg = LOGIN_COLS[tab];
      const memberCol = (COL[tab] as Record<string, number | undefined>).member;
      const memberOf = (row: string[] | undefined) =>
        row && memberCol !== undefined
          ? playerByCode.get(row[memberCol]?.trim().toLowerCase() ?? "")
          : undefined;
      if (loginCfg && colIndex === loginCfg.userCol) {
        const pl = memberOf(d);
        const gameCell = d?.[loginCfg.gameCol]?.trim().toLowerCase() ?? "";
        if (!pl || !gameCell) return undefined;
        const logins = (pl.game_accounts ?? []).filter(
          (a) => a.game_name.toLowerCase() === gameCell,
        );
        if (logins.length <= 1) return undefined; // one login: nothing to pick
        return logins.map((a) => ({ value: a.game_username, hint: a.game_name }));
      }
      if (tab !== "deposit" || colIndex !== COL.deposit.bonuspct) return undefined;
      const pl = memberOf(d);
      if (!pl) {
        // No player yet — eligibility is meaningless without one, so the
        // dropdown says only that, mirroring the Deposits page's picker.
        return [
          {
            value: "",
            title: "Please select a player first",
            detail: "Enter the Member Code — bonuses depend on the player",
            detailTone: "warning" as const,
            disabled: true,
          },
        ];
      }
      const amt = parseAmount(d[COL.deposit.amount] ?? "") ?? 0;
      return buildBonusSuggestions(
        bonusOptionsCache.get(`${pl.player_id}:${amt}:0`),
        amt,
      );
    },
    [tab, drafts, playerByCode, bonusOptionsCache, buildBonusSuggestions],
  );

  // ---- validation ----

  type Parsed =
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; error: string };

  const parseDepositDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.deposit;
      const member = d[c.member] ?? "";
      const username = d[c.username] ?? "";
      const product = d[c.product] ?? "";
      const bonuspct = d[c.bonuspct] ?? "";
      const bank = d[c.bank] ?? "";
      const amount = d[c.amount] ?? "";
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
          ...(selected_game && username.trim()
            ? { selected_game_username: username.trim() }
            : {}),
          ...(pct ? { bonus_percentage: pct } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseWithdrawalDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.withdrawal;
      const member = d[c.member] ?? "";
      const username = d[c.username] ?? "";
      const product = d[c.product] ?? "";
      const bank = d[c.bank] ?? "";
      const amount = d[c.amount] ?? "";
      const account = d[c.account] ?? "";
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
          ...(username.trim() ? { game_username: username.trim() } : {}),
          ...(all ? { withdraw_all: true } : { requested_amount: amt }),
          ...(bank.trim() ? { bank_name: bank.trim() } : {}),
          ...(account.trim() ? { bank_account_number: account.trim() } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseFreeCreditDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.freecredit;
      const member = d[c.member] ?? "";
      const username = d[c.username] ?? "";
      const product = d[c.product] ?? "";
      const amount = d[c.amount] ?? "";
      const mode = d[c.mode] ?? "";
      const remark = d[c.remark] ?? "";
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const g = gameByName.get(product.trim().toLowerCase());
      if (!g) return { ok: false, error: `Unknown product "${product.trim()}"` };
      // Mirror the server's check so the row errors before it is sent: the
      // credit must land in an account the player actually holds.
      const hasGame = (player.game_accounts ?? []).some(
        (a) => a.game_name.toLowerCase() === g.toLowerCase(),
      );
      if (!hasGame)
        return { ok: false, error: `${player.username} has no ${g} account linked` };
      const amt = parseAmount(amount);
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${amount}"` };
      const m = mode.trim().toLowerCase();
      let skip_bot: boolean;
      if (!m || ["bot", "agent", "auto"].includes(m)) skip_bot = false;
      else if (["manual", "cs", "hand"].includes(m)) skip_bot = true;
      else return { ok: false, error: `Mode must be "bot" or "manual", not "${mode.trim()}"` };
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          game_name: g,
          ...(username.trim() ? { game_username: username.trim() } : {}),
          amount: amt,
          skip_bot,
          ...(remark.trim() ? { reason: remark.trim() } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseTransferDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.transfer;
      const member = d[c.member] ?? "";
      const username = d[c.username] ?? "";
      const from = d[c.from] ?? "";
      const to = d[c.to] ?? "";
      const amount = d[c.amount] ?? "";
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
          ...(username.trim() ? { from_game_username: username.trim() } : {}),
          ...(all ? { transfer_all: true } : { amount: amt }),
        },
      };
    },
    [playerByCode, gameByName],
  );

  const parseExpenseDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.expense;
      const date = d[c.date] ?? "";
      const category = d[c.category] ?? "";
      const description = d[c.description] ?? "";
      const amount = d[c.amount] ?? "";
      const company = d[c.company] ?? "";
      const notes = d[c.notes] ?? "";
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
    freecredit: parseFreeCreditDraft,
    transfer: parseTransferDraft,
    expense: parseExpenseDraft,
  };
  const parseDraft = parseByTab[tab];

  const draftKey = useCallback((d: string[]) => `${tab}:${d.join(" ")}`, [tab]);

  const draftStatus = useCallback(
    (d: string[]): DraftStatus => {
      if (isBlankDraft(tab, d)) return { state: "empty" };
      const rejected = commitErrors.get(draftKey(d));
      if (rejected) return { state: "error", message: rejected };
      const parsed = parseDraft(d);
      return parsed.ok
        ? { state: "ready" }
        : { state: "error", message: parsed.error };
    },
    [tab, parseDraft, commitErrors, draftKey],
  );

  const readyCount = useMemo(
    () => drafts.filter((d) => draftStatus(d).state === "ready").length,
    [drafts, draftStatus],
  );

  // ---- in-place edits & workflow actions on saved rows ----

  const withdrawalById = useMemo(() => {
    const m = new Map<number, Withdrawal>();
    for (const w of withdrawals) m.set(w.withdrawal_id, w);
    return m;
  }, [withdrawals]);
  const transferByIdMap = useMemo(() => {
    const m = new Map<number, GameTransfer>();
    for (const t of gameTransfers) m.set(t.transfer_id, t);
    return m;
  }, [gameTransfers]);
  const expenseById = useMemo(() => {
    const m = new Map<number, Expense>();
    for (const e of expenses) m.set(e.expense_id, e);
    return m;
  }, [expenses]);

  /** Columns of a saved deposit row that edit in place, while it still can. */
  const DEPOSIT_EDITABLE_COLS = useMemo(
    () => new Set([COL.deposit.member, COL.deposit.product, COL.deposit.bonuspct]),
    [],
  );
  const committedEditable = useCallback(
    (rowIndex: number, colIndex: number): boolean => {
      if (tab !== "deposit" || isViewer) return false;
      if (!DEPOSIT_EDITABLE_COLS.has(colIndex)) return false;
      const dep = depositById.get(Number(rows[rowIndex]?.id));
      return !!dep && ["pending_match", "matched", "pending"].includes(dep.status);
    },
    [tab, isViewer, DEPOSIT_EDITABLE_COLS, depositById, rows],
  );

  const onCommittedEdit = useCallback(
    async (rowIndex: number, colIndex: number, value: string) => {
      const dep = depositById.get(Number(rows[rowIndex]?.id));
      if (!dep) return;
      const v = value.trim();
      if (colIndex === COL.deposit.member) {
        const pl = playerByCode.get(v.toLowerCase());
        if (!pl) {
          toast.error(`Unknown member code "${v}" — player not changed`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { player_id: pl.player_id });
        if (!res.ok) toast.error(res.error ?? "Failed to assign player");
      } else if (colIndex === COL.deposit.product) {
        if (!v) {
          const res = await updateDepositDraft(dep.deposit_id, { selected_game: null });
          if (!res.ok) toast.error(res.error ?? "Failed to clear game");
          return;
        }
        const g = gameByName.get(v.toLowerCase());
        if (!g) {
          toast.error(`Unknown product "${v}" — game not changed`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { selected_game: g });
        if (!res.ok) toast.error(res.error ?? "Failed to set game");
      } else if (colIndex === COL.deposit.bonuspct) {
        const pct = parseBonusPct(value);
        if (pct === null) {
          toast.error(`Bad bonus % "${value}"`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { bonus_percentage: pct });
        if (!res.ok) toast.error(res.error ?? "Failed to set bonus");
      }
    },
    [depositById, rows, playerByCode, gameByName, updateDepositDraft],
  );

  const selectedNumericIds = useMemo(
    () => selectedIds.map((id) => Number(id)).filter((n) => Number.isFinite(n)),
    [selectedIds],
  );
  const selectedDeposits = useMemo(
    () =>
      tab === "deposit"
        ? selectedNumericIds.map((id) => depositById.get(id)).filter((d): d is Deposit => !!d)
        : [],
    [tab, selectedNumericIds, depositById],
  );
  const selectedWithdrawals = useMemo(
    () =>
      tab === "withdrawal"
        ? selectedNumericIds
            .map((id) => withdrawalById.get(id))
            .filter((w): w is Withdrawal => !!w)
        : [],
    [tab, selectedNumericIds, withdrawalById],
  );
  const selectedTransfers = useMemo(
    () =>
      tab === "transfer"
        ? selectedNumericIds
            .map((id) => transferByIdMap.get(id))
            .filter((t): t is GameTransfer => !!t)
        : [],
    [tab, selectedNumericIds, transferByIdMap],
  );
  const selectedExpenses = useMemo(
    () =>
      tab === "expense"
        ? selectedNumericIds
            .map((id) => expenseById.get(id))
            .filter((e): e is Expense => !!e)
        : [],
    [tab, selectedNumericIds, expenseById],
  );

  /** Run one store action over ids, sequentially, and report the outcome. */
  const runBulk = useCallback(
    async (
      label: string,
      ids: number[],
      fn: (id: number) => Promise<{ ok: boolean; error?: string }>,
    ) => {
      if (!ids.length || acting) return;
      setActing(true);
      let ok = 0;
      const errors: string[] = [];
      for (const id of ids) {
        const res = await fn(id);
        if (res.ok) ok++;
        else errors.push(res.error ?? "failed");
      }
      setActing(false);
      setSelectedIds([]);
      if (errors.length) {
        toast.error(`${label}: ${ok} done, ${errors.length} failed — ${errors[0]}`);
      } else {
        toast.success(`${label}: ${ok} done`);
      }
    },
    [acting],
  );

  const assignKind =
    tab === "deposit" ? "deposit" : tab === "withdrawal" ? "withdrawal" : "game_transfer";

  // Are the selected rows already claimed by the current user? Drives the
  // Assign button flipping to Unassign — the visible proof the claim landed.
  const allMine = useMemo(() => {
    const assignees =
      tab === "deposit"
        ? selectedDeposits.map((d) => d.assigned_to_user_id)
        : tab === "withdrawal"
          ? selectedWithdrawals.map((w) => w.assigned_to_user_id)
          : tab === "transfer"
            ? selectedTransfers.map((t) => t.assigned_to_user_id)
            : [];
    return (
      assignees.length > 0 && assignees.every((a) => a != null && a === me?.user_id)
    );
  }, [tab, selectedDeposits, selectedWithdrawals, selectedTransfers, me]);

  const handleAssignToMe = useCallback(async () => {
    if (!selectedNumericIds.length || acting) return;
    const assign = !allMine; // second press releases the claim
    setActing(true);
    const res = await setAssignment({
      kind: assignKind,
      ids: selectedNumericIds,
      assign,
    });
    setActing(false);
    // Selection is kept on purpose: the button flipping to "Unassign" (and the
    // Assignee column filling in) is how the user sees the claim took.
    if (!res.ok) toast.error(res.error ?? "Failed to assign");
    else if (!assign) {
      toast.success(`${res.changed ?? selectedNumericIds.length} released`);
    } else if (res.skipped) {
      toast.warning(`${res.changed ?? 0} assigned to you — ${res.skipped} held by someone else`);
    } else {
      toast.success(`${res.changed ?? selectedNumericIds.length} assigned to you`);
    }
  }, [selectedNumericIds, acting, allMine, setAssignment, assignKind]);

  // Approve claims each deposit first — the server requires the approver to
  // hold the row, and doing the claim here saves a click on the obvious path.
  const handleApprove = useCallback(async () => {
    const ids = selectedDeposits
      .filter((d) => ["pending", "matched"].includes(d.status))
      .map((d) => d.deposit_id);
    await runBulk("Approve", ids, async (id) => {
      const dep = depositById.get(id);
      if (dep && dep.assigned_to_user_id !== me?.user_id) {
        await setAssignment({ kind: "deposit", id, assign: true });
      }
      return approveDeposit(id);
    });
  }, [selectedDeposits, runBulk, depositById, me, setAssignment, approveDeposit]);

  const can = useMemo(
    () => ({
      assign: tab !== "expense" && selectedNumericIds.length > 0,
      approve: selectedDeposits.some((d) => ["pending", "matched"].includes(d.status)),
      complete: selectedDeposits.some((d) => ["approved", "processing"].includes(d.status)),
      retryDep: selectedDeposits.some((d) => d.status === "failed"),
      rejectDep: selectedDeposits.some((d) =>
        ["pending_match", "matched", "pending"].includes(d.status),
      ),
      pull: selectedWithdrawals.some((w) => w.status === "requested"),
      paid: selectedWithdrawals.some((w) => w.status === "credits_pulled"),
      rejectWd: selectedWithdrawals.some((w) => w.status === "requested"),
      retryTf: selectedTransfers.some((t) => t.status === "failed"),
      delExp: tab === "expense" && selectedExpenses.length > 0,
    }),
    [tab, selectedNumericIds, selectedDeposits, selectedWithdrawals, selectedTransfers, selectedExpenses],
  );

  // The player behind the current selection — set only when every selected row
  // points at the same one, so "View player" is unambiguous. Free-credit rows
  // aren't selectable, so this covers deposit/withdrawal/transfer.
  const selectedPlayerId = useMemo(() => {
    const ids = new Set<number>();
    for (const d of selectedDeposits) if (d.player_id) ids.add(d.player_id);
    for (const w of selectedWithdrawals) ids.add(w.player_id);
    for (const t of selectedTransfers) ids.add(t.player_id);
    return ids.size === 1 ? [...ids][0] : null;
  }, [selectedDeposits, selectedWithdrawals, selectedTransfers]);

  const handleViewPlayer = useCallback(() => {
    if (selectedPlayerId) openPlayer(selectedPlayerId);
  }, [selectedPlayerId, openPlayer]);

  const handleComplete = useCallback(
    () =>
      runBulk(
        "Complete",
        selectedDeposits
          .filter((d) => ["approved", "processing"].includes(d.status))
          .map((d) => d.deposit_id),
        completeDeposit,
      ),
    [runBulk, selectedDeposits, completeDeposit],
  );
  const handleRetryDeposits = useCallback(
    () =>
      runBulk(
        "Retry",
        selectedDeposits.filter((d) => d.status === "failed").map((d) => d.deposit_id),
        reprocessDeposit,
      ),
    [runBulk, selectedDeposits, reprocessDeposit],
  );
  const handleRejectDeposits = useCallback(
    () =>
      setConfirming({
        kind: "reject-deposit",
        ids: selectedDeposits
          .filter((d) => ["pending_match", "matched", "pending"].includes(d.status))
          .map((d) => d.deposit_id),
      }),
    [selectedDeposits],
  );
  const handlePull = useCallback(
    () =>
      runBulk(
        "Pull credits",
        selectedWithdrawals
          .filter((w) => w.status === "requested")
          .map((w) => w.withdrawal_id),
        pullCreditsForWithdrawal,
      ),
    [runBulk, selectedWithdrawals, pullCreditsForWithdrawal],
  );
  const handleMarkPaid = useCallback(
    () =>
      runBulk(
        "Mark paid",
        selectedWithdrawals
          .filter((w) => w.status === "credits_pulled")
          .map((w) => w.withdrawal_id),
        (id) => markWithdrawalPaid(id),
      ),
    [runBulk, selectedWithdrawals, markWithdrawalPaid],
  );
  const handleRejectWithdrawals = useCallback(
    () =>
      setConfirming({
        kind: "reject-withdrawal",
        ids: selectedWithdrawals
          .filter((w) => w.status === "requested")
          .map((w) => w.withdrawal_id),
      }),
    [selectedWithdrawals],
  );
  const handleRetryTransfers = useCallback(
    () =>
      runBulk(
        "Retry",
        selectedTransfers.filter((t) => t.status === "failed").map((t) => t.transfer_id),
        reprocessGameTransfer,
      ),
    [runBulk, selectedTransfers, reprocessGameTransfer],
  );
  const handleDeleteExpenses = useCallback(
    () =>
      setConfirming({
        kind: "delete-expense",
        ids: selectedExpenses.map((e) => e.expense_id),
      }),
    [selectedExpenses],
  );

  // Single-letter shortcuts, live while saved rows are selected and no editor
  // is open. Capture phase, so the grid's type-to-edit never sees these keys.
  useEffect(() => {
    if (isViewer || !selectedIds.length || tab === "freecredit") return;
    const onKey = (e: KeyboardEvent) => {
      if (acting || confirming) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      // Esc clears bare; every action rides Ctrl so plain typing never fires one.
      if (k === "escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds([]);
        return;
      }
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || e.altKey || e.shiftKey) return;
      let run: (() => void) | null = null;
      if (k === "enter" && selectedPlayerId) run = handleViewPlayer;
      else if (k === "a" && can.assign) run = handleAssignToMe;
      else if (tab === "deposit") {
        if (k === "p" && can.approve) run = handleApprove;
        else if (k === "c" && can.complete) run = handleComplete;
        // ⌘I, not ⌘T — the browser reserves ⌘T / Ctrl+T for "new tab" and the
        // page never receives it.
        else if (k === "i" && can.retryDep) run = handleRetryDeposits;
        else if (k === "r" && can.rejectDep) run = handleRejectDeposits;
      } else if (tab === "withdrawal") {
        if (k === "p" && can.pull) run = handlePull;
        // ⌘B, not ⌘M — ⌘M minimises the window on macOS before the page sees it.
        else if (k === "b" && can.paid) run = handleMarkPaid;
        else if (k === "r" && can.rejectWd) run = handleRejectWithdrawals;
      } else if (tab === "transfer") {
        if (k === "i" && can.retryTf) run = handleRetryTransfers;
      } else if (tab === "expense") {
        if (k === "d" && can.delExp) run = handleDeleteExpenses;
      }
      if (run) {
        e.preventDefault();
        e.stopPropagation();
        void run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    isViewer, selectedIds.length, tab, acting, confirming, can,
    selectedPlayerId, handleViewPlayer,
    handleAssignToMe, handleApprove, handleComplete, handleRetryDeposits,
    handleRejectDeposits, handlePull, handleMarkPaid, handleRejectWithdrawals,
    handleRetryTransfers, handleDeleteExpenses,
  ]);

  // Shift+Cmd/Ctrl+Left/Right cycles the worksheet tabs — global, so it works
  // whether the focus is in the grid, a filter, or nowhere. Skips while a text
  // field is focused so it never fights caret movement.
  useEffect(() => {
    const order: TabKey[] = [
      "deposit",
      "withdrawal",
      "freecredit",
      "transfer",
      ...(isAdmin ? (["expense"] as TabKey[]) : []),
    ];
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!e.shiftKey || !mod || wrongMod || e.altKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      const i = order.indexOf(tab);
      const next = e.key === "ArrowLeft" ? i - 1 : i + 1;
      // Wrap around, so the ends meet like flipping through sheet tabs.
      switchTab(order[(next + order.length) % order.length]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tab, isAdmin, switchTab]);

  // ---- commit ----

  const COMMIT_PATH: Record<TabKey, string> = {
    deposit: "/api/deposits",
    withdrawal: "/api/withdrawals",
    freecredit: "/api/free-credits",
    transfer: "/api/game-transfers",
    expense: "/api/expenses",
  };

  const handleCommit = useCallback(async () => {
    if (saving || isViewer) return;
    const jobs = drafts
      .map((d, i) => ({ d, i, parsed: parseDraft(d) }))
      .filter((j) => !isBlankDraft(tab, j.d) && j.parsed.ok) as Array<{
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
    setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(remaining, tab) }));
    setCommitErrors(failures);
    setSaving(false);
    await Promise.all([refresh(), loadFreeCredits()]);
    const failed = jobs.length - succeeded.size;
    const noun = {
      deposit: "deposit",
      withdrawal: "withdrawal",
      freecredit: "free credit",
      transfer: "transfer",
      expense: "expense",
    }[tab];
    if (failed) {
      toast.error(
        `${succeeded.size} saved, ${failed} rejected — rejected rows stay below with the reason on the ! marker.`,
      );
    } else {
      toast.success(`${succeeded.size} ${noun}${succeeded.size === 1 ? "" : "s"} saved`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, isViewer, drafts, parseDraft, tab, commitErrors, draftKey, refresh, loadFreeCredits]);

  // Cmd/Ctrl+S saves the ready entry rows from anywhere on the page — and
  // preventDefault stops the browser's own "save this page" dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      if (!isViewer) void handleCommit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isViewer, handleCommit]);

  // ---- filters ----

  const monthOptions = useMemo(() => {
    const set = new Set<string>([currentMonth]);
    for (const d of deposits) set.add(d.deposit_date.slice(0, 7));
    for (const w of withdrawals) set.add(w.created_at.slice(0, 7));
    for (const t of gameTransfers) set.add(t.created_at.slice(0, 7));
    for (const f of freeCredits) set.add(f.created_at.slice(0, 7));
    for (const e of expenses) set.add(e.expense_date.slice(0, 7));
    return [...set].sort().reverse();
  }, [deposits, withdrawals, gameTransfers, freeCredits, expenses, currentMonth]);

  const statusOptionsByTab: Record<TabKey, [string, string][]> = {
    deposit: Object.entries(DEPOSIT_STATUS_LABEL),
    withdrawal: Object.entries(WITHDRAWAL_STATUS_LABEL),
    freecredit: [],
    transfer: Object.entries(TRANSFER_STATUS_LABEL),
    expense: [],
  };
  const statusOptions = statusOptionsByTab[tab];

  // What the confirm dialog shows and does, per pending destructive action.
  const confirmData = useMemo(() => {
    if (!confirming) return null;
    if (confirming.kind === "reject-deposit") {
      const list = confirming.ids
        .map((id) => depositById.get(id))
        .filter((d): d is Deposit => !!d);
      return {
        title: `Reject ${list.length} deposit${list.length === 1 ? "" : "s"}?`,
        description: "Rejected deposits are marked failed; nothing is credited.",
        confirmLabel: "Reject",
        summary: [
          { label: "Deposits", value: String(list.length) },
          {
            label: "Total amount",
            value: fmtAmount(list.reduce((a, d) => a + d.deposit_amount, 0)),
            emphasis: true,
          },
        ] as SummaryRow[],
        items: list.map((d) => ({
          key: d.deposit_id,
          label: d.player_username ?? "Unassigned",
          meta: d.bank_name,
          value: fmtAmount(d.deposit_amount),
        })),
        run: () => runBulk("Reject", list.map((d) => d.deposit_id), rejectDeposit),
      };
    }
    if (confirming.kind === "reject-withdrawal") {
      const list = confirming.ids
        .map((id) => withdrawalById.get(id))
        .filter((w): w is Withdrawal => !!w);
      return {
        title: `Reject ${list.length} withdrawal${list.length === 1 ? "" : "s"}?`,
        description: "The player keeps their credits; the request is marked failed.",
        confirmLabel: "Reject",
        summary: [
          { label: "Withdrawals", value: String(list.length) },
          {
            label: "Total requested",
            value: fmtAmount(list.reduce((a, w) => a + w.requested_amount, 0)),
            emphasis: true,
          },
        ] as SummaryRow[],
        items: list.map((w) => ({
          key: w.withdrawal_id,
          label: playerById.get(w.player_id)?.username ?? `#${w.withdrawal_id}`,
          meta: w.game_name,
          value: w.withdraw_all && !w.requested_amount ? "ALL" : fmtAmount(w.requested_amount),
        })),
        run: () =>
          runBulk("Reject", list.map((w) => w.withdrawal_id), rejectWithdrawal),
      };
    }
    const list = confirming.ids
      .map((id) => expenseById.get(id))
      .filter((e): e is Expense => !!e);
    return {
      title: `Delete ${list.length} expense${list.length === 1 ? "" : "s"}?`,
      description: "Deleted expenses are removed permanently.",
      confirmLabel: "Delete",
      summary: [
        { label: "Expenses", value: String(list.length) },
        {
          label: "Total amount",
          value: fmtAmount(list.reduce((a, e) => a + e.amount, 0)),
          emphasis: true,
        },
      ] as SummaryRow[],
      items: list.map((e) => ({
        key: e.expense_id,
        label: e.description,
        meta: e.category,
        value: fmtAmount(e.amount),
      })),
      run: () => runBulk("Delete", list.map((e) => e.expense_id), deleteExpense),
    };
  }, [
    confirming, depositById, withdrawalById, expenseById, playerById,
    runBulk, rejectDeposit, rejectWithdrawal, deleteExpense,
  ]);

  // ---- Crawl banks (deposit tab): ask the agent to re-read the banks now ----
  // The crawl that matters to what's on screen: the newest one covering the
  // selected company (an unscoped crawl covers every bank, this one included).
  const latestCrawl = useMemo(
    () =>
      botCommands.find(
        (c) =>
          c.command === "crawl_bank" &&
          (c.company_entity_id === null || companyInScope(c.company_entity_id)),
      ) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [botCommands, selectedCompanyId, selectedLeaderId],
  );
  const crawling =
    crawlRequesting ||
    (latestCrawl !== null && OPEN_BOT_COMMAND_STATUSES.includes(latestCrawl.status));

  const handleCrawl = useCallback(async () => {
    setCrawlRequesting(true);
    const res = await requestBankCrawl({ company_entity_id: selectedCompanyId });
    setCrawlRequesting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't request a bank crawl");
      return;
    }
    if (res.deduped) {
      toast.info("A bank crawl is already in progress");
      return;
    }
    if (!res.agentOnline) {
      toast.warning(
        "Crawl queued, but no agent is online. It runs as soon as one is back, or expires in 10 minutes.",
      );
      return;
    }
    toast.success("Bank crawl requested — the agent picks it up within ~30s");
  }, [requestBankCrawl, selectedCompanyId]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "deposit", label: "Deposit" },
    { key: "withdrawal", label: "Withdrawal" },
    { key: "freecredit", label: "Free Credit" },
    { key: "transfer", label: "Game Transfer" },
    // Expenses are super-admin only — same rule as the Expenses page itself.
    ...(isAdmin ? [{ key: "expense" as const, label: "Expenses" }] : []),
  ];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Always-on-top company info, above everything — the workbook's
          frozen block, in the dashboard's card language. */}
      <div className="shrink-0 px-3 pb-1 pt-2">
        <CompanyInfoPanel month={month === "all" ? "all" : month} />
      </div>

      {/* Worksheet tabs — Excel style. */}
      <div className="flex shrink-0 items-end gap-0.5 border-b border-border bg-muted/40 px-2 pt-1.5">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => switchTab(key)}
            className={cn(
              "cursor-pointer whitespace-nowrap rounded-t-md border border-b-0 border-border px-4 py-1.5 text-[13px]",
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
          {tab === "deposit" && !isViewer && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 cursor-pointer gap-1.5"
              onClick={handleCrawl}
              disabled={crawling}
              title={crawlHint(latestCrawl)}
            >
              {crawling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radar className="h-3.5 w-3.5" />
              )}
              {crawling
                ? latestCrawl?.status === "running"
                  ? "Crawling…"
                  : "Queued…"
                : "Crawl banks"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer gap-1.5"
            onClick={async () => {
              setRefreshing(true);
              await Promise.all([refresh(), loadFreeCredits()]);
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
              <span className="hidden text-[10px] opacity-70 lg:inline">{MOD_LABEL}S</span>
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
        committedEditable={committedEditable}
        onCommittedEdit={onCommittedEdit}
        onSelectedRowsChange={setSelectedIds}
        draftSuggestions={draftSuggestions}
        committedSuggestions={committedSuggestions}
        onEditStart={handleEditStart}
        // Re-fires after hydration so the initial jump lands on the entry
        // rows once the committed rows are actually there.
        focusKey={`${tab}:${hydrated}`}
      />

      {/* Floating action panel — pinned bottom-center over the sheet while
          saved rows are selected. Letters fire the actions; Esc clears. */}
      {!isViewer && selectedIds.length > 0 && tab !== "freecredit" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-14 z-40 flex justify-center">
          <div className="pointer-events-auto flex max-w-[92%] flex-wrap items-center justify-center gap-1.5 rounded-lg border border-emerald-600/40 bg-background/95 px-3 py-1.5 shadow-xl backdrop-blur">
            <span className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
              {selectedIds.length} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              title="Clear selection (Esc)"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {selectedPlayerId && (
              <Button
                size="xs"
                variant="outline"
                onClick={handleViewPlayer}
                title="Open the player's details"
                className="cursor-pointer gap-1"
              >
                <User className="h-3 w-3" />
                Player
                <Kbd k={`${MOD_LABEL}\u21B5`} />
              </Button>
            )}
            {can.assign && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleAssignToMe}
                title={allMine ? "Release your claim on these rows" : "Claim these rows"}
                className="cursor-pointer gap-1"
              >
                {allMine ? (
                  <>
                    <UserMinus className="h-3 w-3" />
                    Unassign
                  </>
                ) : (
                  <>
                    <UserCheck className="h-3 w-3" />
                    Assign to me
                  </>
                )}
                <Kbd k={`${MOD_LABEL}A`} />
              </Button>
            )}
            {can.approve && (
              <Button
                size="xs"
                disabled={acting}
                onClick={handleApprove}
                className="cursor-pointer gap-1 bg-emerald-700 text-white hover:bg-emerald-800"
              >
                <CheckCircle2 className="h-3 w-3" />
                Approve
                <Kbd k={`${MOD_LABEL}P`} light />
              </Button>
            )}
            {can.complete && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleComplete}
                className="cursor-pointer gap-1"
              >
                <CheckCircle2 className="h-3 w-3" />
                Complete
                <Kbd k={`${MOD_LABEL}C`} />
              </Button>
            )}
            {can.retryDep && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleRetryDeposits}
                className="cursor-pointer gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                Retry
                <Kbd k={`${MOD_LABEL}I`} />
              </Button>
            )}
            {can.rejectDep && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleRejectDeposits}
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Ban className="h-3 w-3" />
                Reject
                <Kbd k={`${MOD_LABEL}R`} />
              </Button>
            )}
            {can.pull && (
              <Button
                size="xs"
                disabled={acting}
                onClick={handlePull}
                className="cursor-pointer gap-1 bg-emerald-700 text-white hover:bg-emerald-800"
              >
                <HandCoins className="h-3 w-3" />
                Pull credits
                <Kbd k={`${MOD_LABEL}P`} light />
              </Button>
            )}
            {can.paid && (
              <Button
                size="xs"
                disabled={acting}
                onClick={handleMarkPaid}
                className="cursor-pointer gap-1 bg-emerald-700 text-white hover:bg-emerald-800"
              >
                <CheckCircle2 className="h-3 w-3" />
                Mark paid
                <Kbd k={`${MOD_LABEL}B`} light />
              </Button>
            )}
            {can.rejectWd && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleRejectWithdrawals}
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Ban className="h-3 w-3" />
                Reject
                <Kbd k={`${MOD_LABEL}R`} />
              </Button>
            )}
            {can.retryTf && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleRetryTransfers}
                className="cursor-pointer gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                Retry
                <Kbd k={`${MOD_LABEL}I`} />
              </Button>
            )}
            {can.delExp && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleDeleteExpenses}
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Trash2 className="h-3 w-3" />
                Delete
                <Kbd k={`${MOD_LABEL}D`} />
              </Button>
            )}
          </div>
        </div>
      )}

      {confirmData && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirming(null);
          }}
          title={confirmData.title}
          description={confirmData.description}
          summary={confirmData.summary}
          items={confirmData.items}
          confirmLabel={confirmData.confirmLabel}
          tone="danger"
          onConfirm={async () => {
            await confirmData.run();
            setConfirming(null);
          }}
        />
      )}
    </div>
  );
}

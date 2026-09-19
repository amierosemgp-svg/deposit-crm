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
import { useStore, type MutationResult } from "@/lib/store";
import { bonusOn } from "@/lib/bonus-math";
import { formatClock, formatRelative, formatRM } from "@/lib/format";
import { byBankOrder } from "@/lib/bank-order";
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
  Play,
  Radar,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Undo2,
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
  type BankCashOut,
  type BonusOption,
  type BotCommand,
  type Deposit,
  type Expense,
  type GameTransfer,
  type Player,
  type Withdrawal,
} from "@/lib/types";
import type { RebateLiveStatus, RebatePayoutLedgerRow } from "@/lib/rebates";
import {
  RANGE_PRESETS,
  inRange,
  presetRange,
  rangeLabel,
  type DateRange,
  type RangePreset,
} from "@/lib/date-range";

type TabKey =
  | "deposit"
  | "withdrawal"
  | "freecredit"
  | "transfer"
  | "leaderwithdrawal"
  | "rebate"
  | "leadertransfer"
  | "expense";

/**
 * Column order per sheet, in workflow order: who handles it, then everything
 * CS fills in for a new row (grouped so a Tab-run walks straight through
 * them), then what the CRM derives — status, when it happened, remarks.
 * Every column index in this file comes from here, so reordering a sheet is
 * a one-line change.
 */
const COLUMN_KEYS = {
  deposit: [
    "assign", "member", "product", "username", "amount", "bonuspct", "bonus",
    "total", "bank", "mode", "status", "date", "time", "remark", "bankdesc",
  ],
  withdrawal: [
    "assign", "member", "product", "username", "amount", "bank", "account",
    "holder", "paidfrom", "mode", "status", "date", "time", "remark2",
  ],
  freecredit: [
    "assign", "member", "product", "username", "amount", "mode", "remark",
    "status", "date", "time",
  ],
  transfer: [
    "assign", "member", "from", "username", "to", "to_username", "amount",
    "mode", "status", "date", "time", "note",
  ],
  expense: ["assign", "date", "category", "description", "amount", "company", "paidfrom", "notes"],
  // Cash a leader took out of a company bank account (see Bank Accounts).
  leaderwithdrawal: ["assign", "date", "time", "account", "amount", "takenby", "notes", "status"],
  // Generated rebate payouts, every plan together — read-only, paid from here.
  rebate: [
    "plan", "window", "member", "name", "product", "username", "deposits",
    "withdrawals", "loss", "pct", "amount", "status", "paidby", "paidat",
  ],
  // Settlements between leaders (super-admin only).
  leadertransfer: ["assign", "date", "time", "from", "fromaccount", "to", "toaccount", "amount", "note"],
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

/**
 * The Mode cell, both ways.
 *
 * One axis: was the work done by hand in the back-office, or by the agent?
 * Blank on entry means manual, matching every server default while the desk
 * runs everything itself. Blank on a saved row means the row predates the
 * column and nobody recorded which it was — an honest gap rather than a
 * guessed "Manual".
 */
function parseMode(
  cell: string | undefined,
): { ok: true; skip_bot: boolean } | { ok: false; error: string } {
  const m = (cell ?? "").trim().toLowerCase();
  if (!m || ["manual", "cs", "hand"].includes(m)) return { ok: true, skip_bot: true };
  if (["auto", "bot", "agent"].includes(m)) return { ok: true, skip_bot: false };
  return {
    ok: false,
    error: `Mode must be "manual" or "auto", not "${(cell ?? "").trim()}"`,
  };
}

function modeCell(skipBot: boolean | null | undefined): string {
  return skipBot == null ? "" : skipBot ? "Manual" : "Auto";
}

/**
 * Per tab, each (login cell, game cell) pair — the login is one of the
 * player's accounts under that game. A transfer has two: the account the
 * money leaves and the one it lands in.
 */
const LOGIN_PAIRS: Record<TabKey, Array<{ userCol: number; gameCol: number }>> = {
  deposit: [{ userCol: COL.deposit.username, gameCol: COL.deposit.product }],
  withdrawal: [{ userCol: COL.withdrawal.username, gameCol: COL.withdrawal.product }],
  freecredit: [{ userCol: COL.freecredit.username, gameCol: COL.freecredit.product }],
  transfer: [
    { userCol: COL.transfer.username, gameCol: COL.transfer.from },
    { userCol: COL.transfer.to_username, gameCol: COL.transfer.to },
  ],
  leaderwithdrawal: [],
  rebate: [],
  leadertransfer: [],
  expense: [],
};

/** One leader-to-leader settlement, as GET /api/leader-transfers returns it. */
type LeaderTransferRow = {
  transfer_id: number;
  from_leader_entity_id: number;
  to_leader_entity_id: number;
  amount: number;
  /** Where the money came from / went: an account, cash, or unrecorded. */
  from_account_id: number | null;
  to_account_id: number | null;
  from_cash: boolean;
  to_cash: boolean;
  note: string | null;
  created_by_user_id: number;
  created_at: string;
};

const REBATE_STATUS_LABEL: Record<RebateLiveStatus, string> = {
  pending: "Pending",
  queued: "Queued",
  processing: "Crediting",
  credited: "Credited",
  failed: "Failed",
  skipped: "Skipped",
};

/** "HH:MM" (or "H:MM") → hours and minutes, or null when it isn't one. */
function parseSheetTime(raw: string): [number, number] | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

/** What one company may still give away this month; null = uncapped. */
type FreeCreditAllowance = {
  company_entity_id: number;
  month: string;
  deposits: number;
  issued: number;
  allowance: number | null;
  left: number | null;
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

async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; error?: string; warning?: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await res.json().catch(() => null)) as
      | { error?: string; warning?: string }
      | null;
    if (!res.ok) {
      return { ok: false, error: d?.error ?? `Request failed (${res.status})` };
    }
    // Saved, but it couldn't finish — a manual deposit whose kiosk float was
    // short stops at "processing". Worth saying out loud: the row is there,
    // the top-up is not.
    return { ok: true, ...(d?.warning ? { warning: d.warning } : {}) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/**
 * Cells a fresh entry row starts with already filled: Date is today (a row
 * typed now happened now — the server stamps the real time at save; a
 * bot-sourced row shows its own date and time once committed), and "Assign
 * to me" is yes, since the CS typing the row is normally the one working it.
 */
function autoCells(tab: TabKey): Array<[number, string]> {
  const col = COL[tab] as Record<string, number | undefined>;
  const out: Array<[number, string]> = [];
  if (col.date !== undefined) out.push([col.date, todaySheetDate()]);
  if (col.assign !== undefined) out.push([col.assign, "yes"]);
  return out;
}

function blankRow(tab: TabKey): string[] {
  const row = Array<string>(COLUMN_KEYS[tab].length).fill("");
  for (const [i, v] of autoCells(tab)) row[i] = v;
  return row;
}

/**
 * "Blank" for an entry row means nothing typed — the auto-filled cells don't
 * count, or every padding row would read as a half-entered one.
 */
function isBlankDraft(tab: TabKey, d: string[]): boolean {
  const auto = new Set(autoCells(tab).map(([i]) => i));
  return d.every((v, i) => auto.has(i) || !v.trim());
}

/** The "Assign to me" cell: yes/no (and the usual spellings), blank = no. */
function parseAssign(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (!v || ["no", "n", "false", "0", "-", "—"].includes(v)) return false;
  if (["yes", "y", "true", "1", "me"].includes(v)) return true;
  return null;
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
 * Deposit drafts derive two cells: Bonus (amount x bonus %) and Total (what
 * actually reaches the player's game — amount plus whatever bonus there is).
 *
 * Recomputed on every draft change so both track their inputs and clear when
 * the amount goes. Total shows as soon as an amount is typed, with or without
 * a bonus, because a deposit with no bonus still has a total and CS should not
 * have to know which case they are in.
 *
 * (For a rebate plan the true basis is the period loss, not the deposit — the
 * server computes the real figure at save; these cells are the entry-time view.)
 */
function computeDepositDerived(drafts: string[][]): string[][] {
  const c = COL.deposit;
  return drafts.map((row) => {
    const amt = parseAmount(row[c.amount] ?? "");
    const pct = parseBonusPct(row[c.bonuspct] ?? "");
    const bonusValue = amt && pct ? bonusOn(amt, pct) : 0;
    const bonus = amt && pct ? fmtAmount(bonusValue) : "";
    const total = amt ? fmtAmount(amt + bonusValue) : "";
    if ((row[c.bonus] ?? "") === bonus && (row[c.total] ?? "") === total) return row;
    const out = [...row];
    out[c.bonus] = bonus;
    out[c.total] = total;
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
  leaderwithdrawal:
    "Entry: Date · Time · Bank Account · Amount · Taken By · Notes — cash a leader took out at the bank; the account is debited on save",
  rebate: "Generated on the Rebates page — select rows here to pay, skip or unskip them",
  leadertransfer:
    "Entry: From Leader · To Leader · Amount — name the bank account each end used, or Cash",
};

/** Either end of a leader settlement when no bank account was involved. */
const CASH = "Cash";

/** How a leader's own cash is written in the Expense sheet: "Leader One cash". */
const CASH_SUFFIX = "cash";

/** Stable empty map, so the alias memo below doesn't re-run every render. */
const EMPTY_ALIASES: Record<string, string> = {};
/** Likewise for the bonus rates, which are read straight out of settings. */
const EMPTY_RATES: number[] = [];

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
  const bankAccounts = useStore((s) => s.bankAccounts);
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const reverseBankCashOut = useStore((s) => s.reverseBankCashOut);
  const bonusPlans = useStore((s) => s.bonusPlans);

  const games = gamesFn();
  const banks = banksFn();
  const gameAliases = useStore((s) => s.settings.game_aliases) ?? EMPTY_ALIASES;
  const houseRates = useStore((s) => s.settings.bonus_options) ?? EMPTY_RATES;
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
  // Headroom left under the monthly free-credit cap, per company. Same
  // arithmetic the save enforces, so the sheet can't promise room that the
  // save then refuses.
  const [fcAllowance, setFcAllowance] = useState<FreeCreditAllowance[]>([]);
  const [fcCapPct, setFcCapPct] = useState(0);
  const loadAllowance = useCallback(async () => {
    try {
      const res = await fetch("/api/free-credits/allowance");
      if (!res.ok) return;
      const data = (await res.json()) as { allowances?: FreeCreditAllowance[]; pct?: number };
      setFcAllowance(data.allowances ?? []);
      setFcCapPct(data.pct ?? 0);
    } catch {
      // transient — the pill just keeps its last figure
    }
  }, []);
  // Leader cash-outs, rebate payouts and leader settlements live outside
  // /api/state too — same treatment.
  const [cashOuts, setCashOuts] = useState<BankCashOut[]>([]);
  const loadCashOuts = useCallback(async () => {
    try {
      const res = await fetch("/api/bank-accounts/cash-outs");
      if (!res.ok) return;
      const data = (await res.json()) as { cash_outs?: BankCashOut[] };
      setCashOuts(data.cash_outs ?? []);
    } catch {
      // transient — next refresh retries
    }
  }, []);
  const [rebatePayouts, setRebatePayouts] = useState<RebatePayoutLedgerRow[]>([]);
  const loadRebatePayouts = useCallback(async () => {
    try {
      const res = await fetch("/api/rebates/payouts");
      if (!res.ok) return;
      const data = (await res.json()) as { payouts?: RebatePayoutLedgerRow[] };
      setRebatePayouts(data.payouts ?? []);
    } catch {
      // transient
    }
  }, []);
  const [leaderTransfers, setLeaderTransfers] = useState<LeaderTransferRow[]>([]);
  const loadLeaderTransfers = useCallback(async () => {
    if (!isAdmin) return; // the ledger is super-admin only
    try {
      const res = await fetch("/api/leader-transfers");
      if (!res.ok) return;
      const data = (await res.json()) as { leader_transfers?: LeaderTransferRow[] };
      setLeaderTransfers(data.leader_transfers ?? []);
    } catch {
      // transient
    }
  }, [isAdmin]);
  const loadLedgers = useCallback(
    () =>
      Promise.all([
        loadFreeCredits(),
        loadAllowance(),
        loadCashOuts(),
        loadRebatePayouts(),
        loadLeaderTransfers(),
      ]),
    [loadFreeCredits, loadAllowance, loadCashOuts, loadRebatePayouts, loadLeaderTransfers],
  );
  useEffect(() => {
    // Fetch-on-mount; the setState happens after the await, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLedgers();
  }, [loadLedgers]);

  const [tab, setTab] = useState<TabKey>("deposit");
  // Date range over the sheet: a quick preset, or custom from/to days.
  const [preset, setPreset] = useState<RangePreset | "custom">("this_month");
  const [range, setRange] = useState<DateRange>(() => presetRange("this_month"));
  const applyPreset = useCallback((key: RangePreset) => {
    setPreset(key);
    setRange(presetRange(key));
  }, []);
  const setRangeEdge = useCallback((edge: "from" | "to", value: string) => {
    setPreset("custom");
    setRange((r) => ({ ...r, [edge]: value || null }));
  }, []);
  /**
   * Deposits and withdrawals for the range on screen.
   *
   * /api/state sends a fixed slice — the newest 500 — because it is one payload
   * polled every ten seconds by every open tab. At this house's volume that
   * reached back four days, so opening the month showed a fortnight of nothing
   * while the rows sat in the database. This asks for the period instead, and
   * carries the totals for the whole of it, not just the page.
   *
   * Falls back to the store's slice until the first response lands, so the
   * sheet is never empty while it loads.
   */
  const [rangeRows, setRangeRows] = useState<
    Partial<Record<TabKey, { rows: unknown[]; totals: { rows: number; amount: number } }>>
  >({});
  const loadRangeRows = useCallback(
    async (which: TabKey) => {
      /**
       * Pages until the range is complete, not just the first page of it.
       *
       * One request returns at most 2,000 rows. A month here is ~2,600
       * deposits, so a single page stopped three days into September and the
       * sheet looked like the month began on the 4th — the same blind spot as
       * the old 500-row cap, moved further back. The ceiling stops a year-wide
       * filter from pulling everything ever recorded in one go.
       */
      const PAGE = 2000;
      const MAX_PAGES = 10;
      try {
        let rows: unknown[] = [];
        let totals: { rows: number; amount: number } | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const qs = new URLSearchParams({
            sheet: which,
            limit: String(PAGE),
            offset: String(page * PAGE),
          });
          if (range.from) qs.set("from", range.from);
          if (range.to) qs.set("to", range.to);
          if (selectedCompanyId != null) qs.set("company", String(selectedCompanyId));
          const res = await fetch(`/api/worksheet/rows?${qs}`);
          if (!res.ok) return;
          const data = await res.json();
          rows = rows.concat(data.rows ?? []);
          totals ??= data.totals;
          if ((data.rows?.length ?? 0) < PAGE) break;
        }
        setRangeRows((prev) => ({
          ...prev,
          [which]: { rows, totals: totals ?? { rows: rows.length, amount: 0 } },
        }));
      } catch {
        // Keep whatever is on screen; the next refresh or poll retries.
      }
    },
    [range.from, range.to, selectedCompanyId],
  );
  /** Rebates are generated on their own page, so they have no range to fetch. */
  const RANGE_SHEETS = useMemo<TabKey[]>(
    () => ["deposit", "withdrawal", "transfer", "freecredit", "leaderwithdrawal", "leadertransfer", "expense"],
    [],
  );
  useEffect(() => {
    if (!RANGE_SHEETS.includes(tab)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRangeRows(tab);
    // The store polls /api/state every 10s; these rows no longer come from it,
    // so they need their own heartbeat or a colleague's entry never shows up.
    const timer = setInterval(() => void loadRangeRows(tab), 10_000);
    return () => clearInterval(timer);
  }, [tab, loadRangeRows, RANGE_SHEETS]);

  /**
   * What each sheet draws: the range fetch once it lands, the store's slice
   * until then, so the sheet is never blank while it loads.
   */
  const inRangeOr = useCallback(
    <T,>(which: TabKey, fallback: T[]): T[] => (rangeRows[which]?.rows as T[]) ?? fallback,
    [rangeRows],
  );

  // Status pills — any number lit; none lit = every status.
  const [statusFilters, setStatusFilters] = useState<Set<string>>(() => new Set());
  const toggleStatus = useCallback((value: string) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }, []);
  // Rebate sheet: which plans, which window.
  const [rebatePlanFilter, setRebatePlanFilter] = useState<Set<number>>(() => new Set());
  const [rebateWindowFilter, setRebateWindowFilter] = useState<string>("all");
  const [generatingRebate, setGeneratingRebate] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [crawlRequesting, setCrawlRequesting] = useState(false);
  // Committed rows currently selected in the grid — what the action bar acts on.
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [acting, setActing] = useState(false);
  const [confirming, setConfirming] = useState<{
    kind:
      | "reject-deposit"
      | "reject-withdrawal"
      | "delete-expense"
      | "reverse-cashout"
      | "pay-rebate"
      | "pay-rebate-manual";
    ids: number[];
  } | null>(null);

  // A status from one tab means nothing on the next — reset on switch.
  const switchTab = useCallback((next: TabKey) => {
    setTab(next);
    setStatusFilters(new Set());
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
      { value: "manual", hint: "CS does it in the back-office (default)" },
      { value: "auto", hint: "hand it to the agent" },
    ],
    [],
  );
  const ASSIGN_SUGGESTIONS = useMemo<SheetSuggestion[]>(
    () => [
      { value: "yes", hint: "claim it under my name on save" },
      { value: "no", hint: "leave it unassigned" },
    ],
    [],
  );
  // Bank accounts a cash-out can come from: "Bank number", company and balance
  // as the hint. Leaders by name, for who took the cash / who settles with whom.
  const ACCOUNT_SUGGESTIONS = useMemo<SheetSuggestion[]>(
    () =>
      bankAccounts
        .filter((a) => a.status === "active" && companyInScope(a.entity_id))
        // The workbook's order, so the list reads the same every time it opens.
        .sort(byBankOrder)
        .map((a) => ({
          value: `${a.bank_name} ${a.account_number}`,
          hint: `${entityName(a.entity_id)} · ${fmtAmount(a.current_balance)}`,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bankAccounts, entityName, selectedCompanyId, selectedLeaderId],
  );
  /** What an expense came out of: one of our accounts, or a leader's cash. */
  const PAID_FROM_SUGGESTIONS = useMemo<SheetSuggestion[]>(
    () => [
      ...bankAccounts
        .filter((a) => a.status === "active")
        .map((a) => ({
          value: a.label ?? `${a.bank_name} ${a.account_number}`,
          hint: `${entityName(a.entity_id)} · ${fmtAmount(a.current_balance)}`,
        })),
      ...entities
        .filter((e) => e.entity_type === "leader" && e.status === "active")
        .map((e) => ({ value: `${e.name} ${CASH_SUFFIX}`, hint: "the leader's own cash" })),
    ],
    [bankAccounts, entities, entityName],
  );

  /** Either end of a leader settlement: one of our accounts, or cash. */
  const END_SUGGESTIONS = useMemo<SheetSuggestion[]>(
    () => [
      { value: CASH, hint: "changed hands as cash — no account involved" },
      ...bankAccounts
        .filter((a) => a.status === "active")
        .map((a) => ({
          value: a.label ?? `${a.bank_name} ${a.account_number}`,
          hint: `${entityName(a.entity_id)} · ${fmtAmount(a.current_balance)}`,
        })),
    ],
    [bankAccounts, entityName],
  );
  /**
   * Our own bank accounts, for the cells that name one: which account took a
   * deposit, which one pays a withdrawal out.
   *
   * Not settings.banks — that is a catalogue of 25 bank *names*, which is what
   * the Bank cell used to offer. A name cannot be credited or debited; three
   * of this company's accounts are CIMB.
   */
  const OUR_ACCOUNTS = useMemo<SheetSuggestion[]>(
    () =>
      bankAccounts
        .filter((a) => a.status === "active" && companyInScope(a.entity_id))
        .map((a) => ({
          value: a.label || `${a.bank_name} ${a.account_number}`,
          hint: `${a.bank_name} · ${fmtAmount(a.current_balance)}`,
        })),
    [bankAccounts, companyInScope],
  );

  const LEADER_SUGGESTIONS = useMemo<SheetSuggestion[]>(
    () =>
      entities
        .filter((e) => e.entity_type === "leader" && e.status === "active")
        .map((e) => ({ value: e.name })),
    [entities],
  );
  const leaderByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entities) {
      if (e.entity_type === "leader") m.set(e.name.trim().toLowerCase(), e.entity_id);
    }
    return m;
  }, [entities]);
  const accountByLabel = useMemo(() => {
    const m = new Map<string, (typeof bankAccounts)[number]>();
    for (const a of bankAccounts) {
      // The label first, because that is what every dropdown offers: the lists
      // show "AMBANK 2" and "CIMB · Moganah", and a map keyed only on
      // "<bank> <number>" rejected the very value it had just suggested.
      if (a.label?.trim()) m.set(a.label.trim().toLowerCase(), a);
      m.set(`${a.bank_name} ${a.account_number}`.toLowerCase(), a);
      // The number alone is enough when it's unambiguous.
      if (!m.has(a.account_number.toLowerCase())) m.set(a.account_number.toLowerCase(), a);
    }
    return m;
  }, [bankAccounts]);

  // Column definitions by key; COLUMN_KEYS decides the order they appear in.
  const columnsByTab = useMemo<Record<TabKey, SheetColumn[]>>(() => {
    type Def = Omit<SheetColumn, "key">;
    const member: Def = { label: "Member Code", width: 110, entry: true, required: true, options: memberSuggestions, placeholder: "member code" };
    const username: Def = { label: "Username", width: 130, entry: true, placeholder: "game login" };
    /**
     * Who did the work: CS in the back-office, or the agent. Entered as well
     * as shown, so the row that switches a job to the agent is the same cell
     * that reports which one ran it — everything defaults to manual while the
     * desk is running by hand.
     */
    const mode: Def = { label: "Mode", width: 84, entry: true, options: MODE_SUGGESTIONS, placeholder: "manual" };
    const date: Def = { label: "Date", width: 82, align: "center" };
    const time: Def = { label: "Time", width: 56, align: "center" };
    const status: Def = { label: "Status", width: 116 };
    // Yes = claim the row under my name when it saves. Saved rows show "Yes"
    // when it's mine, the colleague's name when it's theirs, blank if nobody's.
    const assign: Def = {
      label: "Assign to me",
      width: 110,
      entry: true,
      options: ASSIGN_SUGGESTIONS,
      placeholder: "yes / no",
    };
    const order = <T extends TabKey>(tab: T, defs: Record<ColKey<T>, Def>): SheetColumn[] =>
      (COLUMN_KEYS[tab] as readonly ColKey<T>[]).map((key) => ({ key, ...defs[key] }));
    return {
      deposit: order("deposit", {
        assign,
        member,
        product: { label: "Product", width: 110, entry: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100" },
        bonuspct: { label: "Bonus %", width: 76, align: "right", numeric: true, entry: true, placeholder: "10", dropdown: true },
        bonus: { label: "Bonus", width: 90, align: "right", numeric: true },
        // Derived from the two cells before it, on saved rows and while typing
        // alike. Never an entry cell: a total someone can type is a total that
        // can disagree with the figures it is made of.
        total: { label: "Total", width: 100, align: "right", numeric: true },
        bank: { label: "Bank", width: 130, entry: true, required: true, options: OUR_ACCOUNTS, placeholder: "our account" },
        mode,
        status,
        date,
        time,
        remark: { label: "Remark / Name", width: 200 },
        bankdesc: { label: "Bank Description", width: 260 },
      }),
      withdrawal: order("withdrawal", {
        assign,
        member,
        product: { label: "Product", width: 110, entry: true, required: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100 / ALL" },
        bank: { label: "Bank", width: 110, entry: true, options: banks, dropdown: true, placeholder: "bank" },
        account: { label: "Bank Account", width: 150, entry: true, dropdown: true, placeholder: "account no." },
        // Whose account the money is going to. Withdrawals don't store a
        // holder, so it's read off the player's saved accounts — derived,
        // and there to be checked against the payout before it's sent.
        holder: { label: "Account Holder", width: 160 },
        // Which of OUR accounts the money leaves. The three columns before it
        // are the player's — where the payout goes — and none of them says
        // what to deduct, so a paid withdrawal moved no balance at all.
        paidfrom: {
          label: "Paid From",
          width: 150,
          entry: true,
          options: OUR_ACCOUNTS,
          placeholder: "our account",
        },
        mode,
        status,
        date,
        time,
        remark2: { label: "Remark 2", width: 200 },
      }),
      freecredit: order("freecredit", {
        assign,
        member,
        product: { label: "Product", width: 110, entry: true, required: true, options: games, placeholder: "game" },
        username,
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "50" },
        mode,
        remark: { label: "Remark", width: 220, entry: true, placeholder: "reason (optional)" },
        status,
        date,
        time,
      }),
      transfer: order("transfer", {
        assign,
        member,
        from: { label: "From Game", width: 110, entry: true, required: true, options: games, placeholder: "from game" },
        username: { label: "From Username", width: 130, entry: true, placeholder: "from login" },
        to: { label: "To Game", width: 110, entry: true, required: true, options: games, placeholder: "to game" },
        to_username: { label: "To Username", width: 130, entry: true, placeholder: "to login" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100 / ALL" },
        mode,
        status,
        date,
        time,
        note: { label: "Note", width: 240 },
      }),
      leaderwithdrawal: order("leaderwithdrawal", {
        assign,
        date: { label: "Date", width: 92, align: "center", entry: true, placeholder: "31/8/2026" },
        time: { label: "Time", width: 64, align: "center", entry: true, placeholder: "14:30" },
        account: { label: "Bank Account", width: 220, entry: true, required: true, options: ACCOUNT_SUGGESTIONS, placeholder: "bank account" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "500" },
        takenby: { label: "Taken By", width: 160, entry: true, required: true, options: LEADER_SUGGESTIONS, placeholder: "leader" },
        notes: { label: "Notes", width: 240, entry: true, placeholder: "receipt no. (optional)" },
        status: { label: "Status", width: 100 },
      }),
      rebate: order("rebate", {
        plan: { label: "Rebate Plan", width: 150 },
        window: { label: "Window", width: 150 },
        member: { label: "Member Code", width: 110 },
        name: { label: "Name", width: 160 },
        product: { label: "Product", width: 110 },
        username: { label: "Username", width: 130 },
        deposits: { label: "Deposits", width: 100, align: "right", numeric: true },
        withdrawals: { label: "Withdrawals", width: 100, align: "right", numeric: true },
        loss: { label: "Net Loss", width: 100, align: "right", numeric: true },
        pct: { label: "%", width: 56, align: "right" },
        amount: { label: "Rebate", width: 100, align: "right", numeric: true },
        status: { label: "Status", width: 100 },
        paidby: { label: "Paid By", width: 120 },
        paidat: { label: "Paid At", width: 130 },
      }),
      leadertransfer: order("leadertransfer", {
        assign,
        date,
        time,
        from: { label: "From Leader", width: 160, entry: true, required: true, options: LEADER_SUGGESTIONS, placeholder: "from leader" },
        fromaccount: { label: "From Account", width: 190, entry: true, options: END_SUGGESTIONS, placeholder: "bank account / Cash" },
        to: { label: "To Leader", width: 160, entry: true, required: true, options: LEADER_SUGGESTIONS, placeholder: "to leader" },
        toaccount: { label: "To Account", width: 190, entry: true, options: END_SUGGESTIONS, placeholder: "bank account / Cash" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "1000" },
        note: { label: "Note", width: 260, entry: true, placeholder: "what it settles (optional)" },
      }),
      expense: order("expense", {
        assign,
        date: { label: "Date", width: 92, align: "center", entry: true, required: true, placeholder: "31/8/2026" },
        category: { label: "Category", width: 110, entry: true, required: true, options: [...EXPENSE_CATEGORIES], placeholder: "category" },
        description: { label: "Description", width: 260, entry: true, required: true, placeholder: "what it's for" },
        amount: { label: "Amount", width: 100, align: "right", numeric: true, entry: true, required: true, placeholder: "100" },
        company: { label: "Company", width: 150, entry: true, options: companies.map((c) => c.company_name), placeholder: "company" },
        paidfrom: { label: "Paid From", width: 190, entry: true, options: PAID_FROM_SUGGESTIONS, placeholder: "bank account / leader cash" },
        notes: { label: "Notes", width: 240, entry: true, placeholder: "notes (optional)" },
      }),
    };
  }, [games, banks, companies, isAdmin, OUR_ACCOUNTS, memberSuggestions, MODE_SUGGESTIONS, ASSIGN_SUGGESTIONS, ACCOUNT_SUGGESTIONS, LEADER_SUGGESTIONS, END_SUGGESTIONS, PAID_FROM_SUGGESTIONS]);

  const columns = columnsByTab[tab];

  // ---- drafts, one set per tab so switching loses nothing ----

  /** Commits the cell being typed, so ⌘S doesn't save the row without it. */
  const flushEdit = useRef<
    null | (() => { draftIndex: number; col: number; value: string } | null)
  >(null);

  const [draftsByTab, setDraftsByTab] = useState<Record<TabKey, string[][]>>(() => ({
    deposit: padDrafts([], "deposit"),
    withdrawal: padDrafts([], "withdrawal"),
    freecredit: padDrafts([], "freecredit"),
    transfer: padDrafts([], "transfer"),
    leaderwithdrawal: padDrafts([], "leaderwithdrawal"),
    rebate: padDrafts([], "rebate"),
    leadertransfer: padDrafts([], "leadertransfer"),
    expense: padDrafts([], "expense"),
  }));
  // Server rejections from the last save, keyed by the draft row's identity.
  const [commitErrors, setCommitErrors] = useState<Map<string, string>>(new Map());

  const drafts = draftsByTab[tab];
  const draftsRaw = drafts;

  // ---- lookups ----

  const playerByCode = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of players) m.set(p.username.trim().toLowerCase(), p);
    return m;
  }, [players]);

  /**
   * Product name → catalogue name, including the operator's own spellings.
   *
   * Aliases are folded in after the catalogue, so a real game can never be
   * shadowed by an alias pointing somewhere else, and an alias whose target
   * has been removed from the catalogue is ignored rather than writing a name
   * nothing else knows.
   */
  const gameByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of games) m.set(g.toLowerCase(), g);
    for (const [alias, target] of Object.entries(gameAliases)) {
      const key = alias.trim().toLowerCase();
      if (!key || m.has(key)) continue;
      const canonical = games.find((g) => g.toLowerCase() === target.toLowerCase());
      if (canonical) m.set(key, canonical);
    }
    return m;
  }, [games, gameAliases]);

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
   * The player's saved bank account a payout is going to.
   *
   * A withdrawal stores only a bank name and an account number, so the holder
   * — the name CS checks against before releasing money — has to be matched
   * back off the player. The account number identifies it; the bank name is
   * the fallback for rows entered before the number was recorded.
   */
  /** One of our accounts by id, for showing which one a saved row used. */
  const ourAccountById = useCallback(
    (accountId?: number | null) =>
      accountId == null
        ? undefined
        : bankAccounts.find((a) => a.account_id === accountId),
    [bankAccounts],
  );

  const payoutAccountOf = useCallback(
    (player: Player | undefined, bankName?: string | null, accountNumber?: string | null) => {
      const accounts = player?.bank_accounts ?? [];
      const num = accountNumber?.trim();
      const bank = bankName?.trim().toLowerCase();
      return (
        (num ? accounts.find((b) => b.account_number.trim() === num) : undefined) ??
        (bank ? accounts.find((b) => b.bank_name.trim().toLowerCase() === bank) : undefined)
      );
    },
    [],
  );

  /**
   * When a row's Member Code changes and resolves, pre-fill the rest of the
   * row from the player record — their last added game and its username, their
   * saved bank for a payout, their name. Only empty cells are filled, so a
   * typed or pasted value always wins, and it fires only on the member cell
   * actually changing, so clearing an auto-filled cell doesn't re-fill it.
   */
  const enrichMemberChanges = useCallback(
    (prev: string[][], next: string[][]): string[][] => {
      const memberCol = (COL[tab] as Record<string, number | undefined>).member;
      if (memberCol === undefined) return next; // no player on this sheet
      return next.map((row, i) => {
        const member = row[memberCol]?.trim().toLowerCase() ?? "";
        const prevMember = prev[i]?.[memberCol]?.trim().toLowerCase() ?? "";
        const pl = member ? playerByCode.get(member) : undefined;
        if (!pl) return row;
        const out = [...row];
        /**
         * The login cell follows the game cell.
         *
         * Filling only an empty login was not enough: switching Mega888 to
         * 918Kiss left the Mega login sitting beside the new game, which reads
         * as an account the player does not have and books the transaction
         * against the wrong one. A login the sheet itself filled for the game
         * that was just replaced is stale, not typed, so it gets replaced too
         * — and cleared outright when the player holds no account on the new
         * game, since a wrong login is worse than an empty one. Anything CS
         * actually typed still wins.
         */
        let touched = false;
        for (const pair of LOGIN_PAIRS[tab]) {
          const game = out[pair.gameCol]?.trim().toLowerCase() ?? "";
          const prevGame = prev[i]?.[pair.gameCol]?.trim().toLowerCase() ?? "";
          if (game === prevGame) continue; // the game cell didn't move
          const accounts = pl.game_accounts ?? [];
          const login = out[pair.userCol]?.trim() ?? "";
          const isOf = (g: string) =>
            !!g &&
            accounts.some(
              (a) =>
                a.game_name.toLowerCase() === g &&
                a.game_username.toLowerCase() === login.toLowerCase(),
            );
          // Keep a login the player really holds on the new game, and keep
          // anything typed that the record doesn't recognise at all.
          if (login && (isOf(game) || !isOf(prevGame))) continue;
          const acct = accounts.find((a) => a.game_name.toLowerCase() === game);
          const next = acct?.game_username ?? "";
          if (next !== (out[pair.userCol] ?? "")) {
            out[pair.userCol] = next;
            touched = true;
          }
        }
        /**
         * Keep the payout cells telling one story.
         *
         * Holder is derived, never typed, so it re-reads off the player's
         * saved accounts whenever the bank or the number changes — it can't
         * sit stale beside a different account. And the two identifying cells
         * follow each other: a number identifies an account outright, so the
         * bank follows it; a bank with a single account on file brings its
         * number along. The row must never name one bank and another bank's
         * account — that is a payment to the wrong place.
         */
        if (tab === "withdrawal") {
          const c = COL.withdrawal;
          const bankNow = out[c.bank]?.trim() ?? "";
          const acctNow = out[c.account]?.trim() ?? "";
          const bankBefore = prev[i]?.[c.bank]?.trim() ?? "";
          const acctBefore = prev[i]?.[c.account]?.trim() ?? "";
          const accounts = pl.bank_accounts ?? [];

          if (acctNow !== acctBefore) {
            const match = accounts.find((b) => b.account_number.trim() === acctNow);
            if (match) {
              out[c.bank] = match.bank_name;
              out[c.holder] = match.account_holder;
            } else {
              // A number that isn't on file — a one-off payout. Nothing to
              // vouch for the holder, so say nothing rather than guess.
              out[c.holder] = "";
            }
            touched = true;
          } else if (bankNow !== bankBefore) {
            const atBank = accounts.filter(
              (b) => b.bank_name.trim().toLowerCase() === bankNow.toLowerCase(),
            );
            if (atBank.length === 1) {
              out[c.account] = atBank[0].account_number;
              out[c.holder] = atBank[0].account_holder;
            } else {
              // Several accounts at that bank, or none on file: the number is
              // CS's to pick, and it's left alone rather than guessed at.
              out[c.holder] =
                atBank.find((b) => b.account_number.trim() === acctNow)?.account_holder ?? "";
            }
            touched = true;
          }
        }
        if (member === prevMember) return touched ? out : row;
        /**
         * Same rule when the member cell changes: a game and login the sheet
         * filled in for the member who was there a moment ago belong to that
         * member, and left standing they would book this row against another
         * player's account. Cleared here so the fill below re-reads them off
         * the member who is actually in the cell now; a pair the new member
         * also holds, or one CS typed that no record knows, is left alone.
         */
        const prevPl = prevMember ? playerByCode.get(prevMember) : undefined;
        if (prevPl && prevPl.player_id !== pl.player_id) {
          const held = (
            who: typeof pl,
            game: string,
            login: string,
          ) =>
            (who.game_accounts ?? []).some(
              (a) =>
                a.game_name.toLowerCase() === game.toLowerCase() &&
                a.game_username.toLowerCase() === login.toLowerCase(),
            );
          for (const pair of LOGIN_PAIRS[tab]) {
            const game = out[pair.gameCol]?.trim() ?? "";
            const login = out[pair.userCol]?.trim() ?? "";
            if (!game && !login) continue;
            if (held(pl, game, login)) continue; // the new member holds it too
            if (!held(prevPl, game, login)) continue; // typed, not filled
            out[pair.gameCol] = "";
            out[pair.userCol] = "";
          }
        }
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
          fill(c.holder, lastBank?.account_holder);
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
        if (tab === "deposit") processed = computeDepositDerived(processed);
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

  /** The "Assign to me" cell of a saved row: Yes if mine, else the holder. */
  const assignCell = useCallback(
    (userId: number | null | undefined): string =>
      !userId ? "" : userId === me?.user_id ? "Yes" : userName(userId),
    [me?.user_id, userName],
  );

  const depositRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<Deposit>("deposit", deposits)
      .filter((d) => d.company_entity_id === null || companyInScope(d.company_entity_id))
      .filter((d) => inRange(d.deposit_date, range))
      .filter((d) => statusFilters.size === 0 || statusFilters.has(d.status))
      .sort((a, b) => a.deposit_date.localeCompare(b.deposit_date))
      .map((d) => {
        const p = d.player_id ? playerById.get(d.player_id) : undefined;
        const pct = d.bonus_percentage;
        return {
          id: d.deposit_id,
          tone: depositTone(d.status),
          cells: toCells("deposit", {
            assign: assignCell(d.assigned_to_user_id),
            member: d.player_username ?? p?.username ?? "",
            product: d.selected_game ?? "",
            username: gameUsername(p, d.selected_game),
            amount: fmtAmount(d.deposit_amount),
            bonuspct: pct ? `${pct}%` : "—",
            bonus: d.bonus_amount ? fmtAmount(d.bonus_amount) : "—",
            total: fmtAmount(d.total_amount),
            bank: ourAccountById(d.received_into_account_id)?.label ?? d.bank_name,
            mode: modeCell(d.skip_bot),
            status: DEPOSIT_STATUS_LABEL[d.status],
            // Bot-matched rows carry the bank's own timestamp; a sheet-entered
            // row only knows its date.
            date: sheetDate(d.deposit_date),
            time: d.deposit_time_known ? formatClock(d.deposit_date) : "",
            // Who the money is from, and — once someone has corrected the
            // row — who changed what. The correction goes first: it is the
            // thing being looked for when a figure is questioned.
            remark: [
              d.edit_note,
              p?.full_name ??
                extractSenderName(d.bank_description) ??
                d.bank_account_holder ??
                "",
            ]
              .filter(Boolean)
              .join(" · "),
            bankdesc: d.bank_description ?? "",
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposits, playerById, range, statusFilters, matchesSearch, assignCell, selectedCompanyId, selectedLeaderId, inRangeOr]);

  const withdrawalRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<Withdrawal>("withdrawal", withdrawals)
      .filter((w) => {
        const p = playerById.get(w.player_id);
        return !p || companyInScope(p.company_entity_id);
      })
      .filter((w) => inRange(w.created_at, range))
      .filter((w) => statusFilters.size === 0 || statusFilters.has(w.status))
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
            assign: assignCell(w.assigned_to_user_id),
            member: p?.username ?? "",
            product: w.game_name,
            username: gameUsername(p, w.game_name),
            amount: w.withdraw_all && !amount ? "ALL" : fmtAmount(amount),
            bank: w.bank_name ?? "",
            account: w.bank_account_number ?? "",
            holder:
              payoutAccountOf(p, w.bank_name, w.bank_account_number)?.account_holder ?? "",
            paidfrom: ourAccountById(w.paid_from_account_id)?.label ?? "",
            mode: modeCell(w.skip_bot),
            status: WITHDRAWAL_STATUS_LABEL[w.status],
            date: sheetDate(w.created_at),
            time: formatClock(w.created_at),
            remark2: [w.edit_note, p?.full_name ?? ""].filter(Boolean).join(" · "),
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdrawals, playerById, range, statusFilters, matchesSearch, assignCell, payoutAccountOf, selectedCompanyId, selectedLeaderId, inRangeOr]);

  const freeCreditRows = useMemo<SheetRow[]>(() => {
    // Live status for agent-queued rows comes off the referenced transfer.
    const transferById = new Map(gameTransfers.map((t) => [t.transfer_id, t]));
    // The status a row shows: credited by hand, or wherever its agent transfer is.
    const statusOf = (f: FreeCredit) => {
      if (f.source === "manual") return "credited";
      const t = f.game_transfer_id != null ? transferById.get(f.game_transfer_id) : undefined;
      return t ? t.status : "queued";
    };
    return [...inRangeOr<FreeCredit>("freecredit", freeCredits)]
      .filter((f) => f.entity_id === null || companyInScope(f.entity_id))
      .filter((f) => inRange(f.created_at, range))
      .filter((f) => statusFilters.size === 0 || statusFilters.has(statusOf(f)))
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
            assign: assignCell(f.user_id),
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
  }, [freeCredits, gameTransfers, playerById, range, statusFilters, matchesSearch, assignCell, selectedCompanyId, selectedLeaderId, inRangeOr]);

  const transferRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<GameTransfer>("transfer", gameTransfers)
      .filter((t) => {
        const p = playerById.get(t.player_id);
        return !p || companyInScope(p.company_entity_id);
      })
      .filter((t) => inRange(t.created_at, range))
      .filter((t) => statusFilters.size === 0 || statusFilters.has(t.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => {
        const p = playerById.get(t.player_id);
        return {
          id: t.transfer_id,
          tone: transferTone(t.status),
          cells: toCells("transfer", {
            assign: assignCell(t.assigned_to_user_id),
            member: p?.username ?? "",
            from: t.from_game,
            username: t.from_game_username ?? gameUsername(p, t.from_game),
            to: t.to_game,
            to_username: t.to_game_username ?? gameUsername(p, t.to_game),
            amount: t.transfer_all && !t.transfer_amount ? "ALL" : fmtAmount(t.transfer_amount),
            mode: modeCell(t.skip_bot),
            status: TRANSFER_STATUS_LABEL[t.status],
            date: sheetDate(t.created_at),
            time: formatClock(t.created_at),
            note: t.note ?? "",
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameTransfers, playerById, range, statusFilters, matchesSearch, assignCell, selectedCompanyId, selectedLeaderId, inRangeOr]);

  /** How an end reads back: the account's label, "Cash", or an em dash. */
  const transferEndLabel = useCallback(
    (accountId: number | null | undefined, cash: boolean | undefined) => {
      if (cash) return CASH;
      if (accountId == null) return "—";
      const a = bankAccounts.find((x) => x.account_id === accountId);
      return a ? (a.label ?? `${a.bank_name} ${a.account_number}`) : `#${accountId}`;
    },
    [bankAccounts],
  );

  const expenseRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<Expense>("expense", expenses)
      .filter((e) => e.company_entity_id === null || companyInScope(e.company_entity_id))
      .filter((e) => inRange(e.expense_date, range))
      .sort((a, b) => a.expense_date.localeCompare(b.expense_date))
      .map((e: Expense) => ({
        id: e.expense_id,
        tone: "default" as const,
        cells: toCells("expense", {
          assign: assignCell(e.recorded_by_user_id),
          date: sheetDate(e.expense_date),
          category: e.category,
          description: e.description,
          amount: fmtAmount(e.amount),
          company: e.company_entity_id ? (companyNameById.get(e.company_entity_id) ?? "") : "",
          paidfrom:
            e.paid_from_account_id != null
              ? transferEndLabel(e.paid_from_account_id, false)
              : e.paid_from_cash_entity_id != null
                ? `${entityName(e.paid_from_cash_entity_id)} ${CASH_SUFFIX}`
                : "",
          notes: e.notes ?? "",
        }),
      }))
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenses, companyNameById, range, matchesSearch, assignCell, selectedCompanyId, selectedLeaderId, transferEndLabel, entityName, inRangeOr]);

  const accountById = useMemo(
    () => new Map(bankAccounts.map((a) => [a.account_id, a])),
    [bankAccounts],
  );

  const leaderWithdrawalRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<BankCashOut>("leaderwithdrawal", cashOuts)
      .filter((c) => companyInScope(c.entity_id))
      .filter((c) => inRange(c.occurred_at, range))
      .filter(
        (c) =>
          statusFilters.size === 0 || statusFilters.has(c.reversed_at ? "reversed" : "debited"),
      )
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      .map((c) => {
        const a = accountById.get(c.account_id);
        return {
          id: c.cash_out_id,
          tone: c.reversed_at ? ("muted" as const) : ("default" as const),
          cells: toCells("leaderwithdrawal", {
            assign: assignCell(c.recorded_by_user_id),
            date: sheetDate(c.occurred_at),
            time: formatClock(c.occurred_at),
            account: a ? `${a.bank_name} ${a.account_number}` : `#${c.account_id}`,
            amount: fmtAmount(c.amount),
            takenby: c.taken_by,
            notes: c.notes ?? "",
            status: c.reversed_at ? "Reversed" : "Debited",
          }),
        };
      })
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashOuts, accountById, range, statusFilters, matchesSearch, assignCell, selectedCompanyId, selectedLeaderId, inRangeOr]);

  const rebateRows = useMemo<SheetRow[]>(() => {
    const tone = (st: RebateLiveStatus): SheetRow["tone"] =>
      st === "credited"
        ? "success"
        : st === "failed"
          ? "danger"
          : st === "pending"
            ? "warning"
            : st === "skipped"
              ? "muted"
              : "default";
    return rebatePayouts
      .filter((r) => r.company_entity_id === null || companyInScope(r.company_entity_id))
      .filter((r) => inRange(r.window_end, range))
      .filter((r) => rebatePlanFilter.size === 0 || rebatePlanFilter.has(r.plan_id))
      .filter((r) => rebateWindowFilter === "all" || r.window_start === rebateWindowFilter)
      .filter((r) => statusFilters.size === 0 || statusFilters.has(r.live_status))
      .sort((a, b) => a.window_end.localeCompare(b.window_end) || b.net_loss - a.net_loss)
      .map((r) => ({
        id: r.payout_id,
        tone: tone(r.live_status),
        cells: toCells("rebate", {
          plan: `${r.plan_name} · ${BONUS_PERIOD_LABELS[r.period]}`,
          window: `${sheetDate(r.window_start)} – ${sheetDate(r.window_end)}`,
          member: r.username,
          name: r.full_name,
          product: r.game_name ?? "",
          username: r.game_username ?? "",
          deposits: fmtAmount(r.deposits_total),
          withdrawals: fmtAmount(r.withdrawals_total),
          loss: fmtAmount(r.net_loss),
          pct: `${r.percentage}%`,
          amount: fmtAmount(r.amount),
          status: REBATE_STATUS_LABEL[r.live_status],
          paidby: r.paid_by_user_id ? userName(r.paid_by_user_id) : "",
          paidat: r.paid_at ? `${sheetDate(r.paid_at)} ${formatClock(r.paid_at)}` : "",
        }),
      }))
      .filter((r) => matchesSearch(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebatePayouts, range, statusFilters, rebatePlanFilter, rebateWindowFilter, matchesSearch, userName, selectedCompanyId, selectedLeaderId]);

  const leaderTransferRows = useMemo<SheetRow[]>(() => {
    return inRangeOr<LeaderTransferRow>("leadertransfer", leaderTransfers)
      .filter((t) => inRange(t.created_at, range))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((t) => ({
        id: t.transfer_id,
        tone: "default" as const,
        cells: toCells("leadertransfer", {
          assign: assignCell(t.created_by_user_id),
          date: sheetDate(t.created_at),
          time: formatClock(t.created_at),
          from: entityName(t.from_leader_entity_id),
          fromaccount: transferEndLabel(t.from_account_id, t.from_cash),
          to: entityName(t.to_leader_entity_id),
          toaccount: transferEndLabel(t.to_account_id, t.to_cash),
          amount: fmtAmount(t.amount),
          note: t.note ?? "",
        }),
      }))
      .filter((r) => matchesSearch(r.cells));
  }, [leaderTransfers, range, matchesSearch, assignCell, entityName, transferEndLabel, inRangeOr]);

  const rowsByTab: Record<TabKey, SheetRow[]> = {
    deposit: depositRows,
    withdrawal: withdrawalRows,
    freecredit: freeCreditRows,
    transfer: transferRows,
    leaderwithdrawal: leaderWithdrawalRows,
    rebate: rebateRows,
    leadertransfer: leaderTransferRows,
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
    (options: BonusOption[] | undefined, amt: number, rates: number[]): SheetSuggestion[] => {
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
      /**
       * The house's own rates, under whatever plans the player qualifies for.
       *
       * A plan is a rule — claimable once per period, once ever for a welcome —
       * and most of what this desk pays has no rule at all: 5% and 10% go on
       * almost every deposit, several times a day. Those cannot be plans, so
       * without this the dropdown offered two welcome bonuses and nothing else,
       * and the everyday rate had to be typed from memory.
       */
      for (const pct of rates) {
        if (pct <= 0) continue;
        list.push({
          value: `${pct}%`,
          title: `General bonus ${pct}%`,
          badge: "General",
          detail: "No rule attached — available on any deposit, any number of times",
          figure: amt > 0 ? formatRM(bonusOn(amt, pct)) : `${pct}%`,
        });
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
        houseRates,
      );
    },
    [tab, rows, depositById, bonusOptionsCache, buildBonusSuggestions, houseRates],
  );

  const draftSuggestions = useCallback(
    (draftIndex: number, colIndex: number) => {
      const d = drafts[draftIndex];
      // Login picker: the player's linked logins for the row's game, so CS can
      // choose which account under that game the transaction hits.
      const loginCfg = LOGIN_PAIRS[tab].find((pair) => pair.userCol === colIndex);
      const memberCol = (COL[tab] as Record<string, number | undefined>).member;
      const memberOf = (row: string[] | undefined) =>
        row && memberCol !== undefined
          ? playerByCode.get(row[memberCol]?.trim().toLowerCase() ?? "")
          : undefined;
      /**
       * Game cells: the games this player actually holds an account on, so CS
       * picks from the four the member has rather than scrolling every kiosk
       * the house runs and choosing one the transaction can't land in.
       *
       * Falls back to the column's full list when the row has no player yet,
       * or the player has nothing linked — an empty dropdown would be a dead
       * end, and the list is a suggestion, not a restriction: a typed game
       * still goes through.
       */
      const gameCols = new Set(LOGIN_PAIRS[tab].map((pair) => pair.gameCol));
      if (gameCols.has(colIndex)) {
        const pl = memberOf(d);
        const accounts = pl?.game_accounts ?? [];
        if (!accounts.length) return undefined;
        const byGame = new Map<string, string[]>();
        for (const a of accounts) {
          const list = byGame.get(a.game_name) ?? [];
          list.push(a.game_username);
          byGame.set(a.game_name, list);
        }
        return [...byGame].map(([game, logins]) => ({
          value: game,
          hint: logins.length > 1 ? `${logins.length} logins` : logins[0],
        }));
      }
      if (loginCfg) {
        const pl = memberOf(d);
        const gameCell = d?.[loginCfg.gameCol]?.trim().toLowerCase() ?? "";
        if (!pl || !gameCell) return undefined;
        const logins = (pl.game_accounts ?? []).filter(
          (a) => a.game_name.toLowerCase() === gameCell,
        );
        if (logins.length <= 1) return undefined; // one login: nothing to pick
        return logins.map((a) => ({ value: a.game_username, hint: a.game_name }));
      }
      /**
       * Payout bank cells: the player's own saved accounts, holder and all —
       * so CS pays the account on file instead of retyping one off a chat,
       * and can see which of several it is. Falls through to the column's
       * plain bank list when the row has no player yet, or the player has
       * nothing on file.
       */
      if (
        tab === "withdrawal" &&
        (colIndex === COL.withdrawal.bank || colIndex === COL.withdrawal.account)
      ) {
        const pl = memberOf(d);
        const accounts = pl?.bank_accounts ?? [];
        if (!accounts.length) return undefined;
        const isBankCell = colIndex === COL.withdrawal.bank;
        // On the account cell, a bank already chosen narrows the list to it.
        const bankCell = d?.[COL.withdrawal.bank]?.trim().toLowerCase() ?? "";
        const shown =
          !isBankCell && bankCell
            ? accounts.filter((b) => b.bank_name.trim().toLowerCase() === bankCell)
            : accounts;
        const list = shown.length ? shown : accounts;
        return list.map((b) => ({
          value: isBankCell ? b.bank_name : b.account_number,
          title: isBankCell ? b.bank_name : b.account_number,
          detail: b.account_holder,
          figure: isBankCell ? b.account_number : b.bank_name,
        }));
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
        houseRates,
      );
    },
    [tab, drafts, playerByCode, bonusOptionsCache, buildBonusSuggestions, houseRates],
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
      const assign = parseAssign(d[c.assign] ?? "");
      if (assign === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const amt = parseAmount(amount);
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${amount}"` };
      if (!bank.trim()) return { ok: false, error: "Bank is required" };
      // The cell names one of our accounts. Resolving it here is what lets the
      // completion credit a balance rather than just record a bank's name.
      const into = accountByLabel.get(bank.trim().toLowerCase());
      if (!into)
        return {
          ok: false,
          error: `"${bank.trim()}" is not one of our accounts — pick one from the list`,
        };
      let selected_game: string | undefined;
      if (product.trim()) {
        const g = gameByName.get(product.trim().toLowerCase());
        if (!g) return { ok: false, error: `Unknown product "${product.trim()}"` };
        selected_game = g;
      }
      const pct = parseBonusPct(bonuspct);
      if (pct === null) return { ok: false, error: `Bad bonus % "${bonuspct}"` };
      const mode = parseMode(d[c.mode]);
      if (!mode.ok) return mode;
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          amount: amt,
          bank_name: into.bank_name,
          received_into_account_id: into.account_id,
          // Entered from the workbook = the money is already in the bank, so it
          // goes straight to the CS queue instead of waiting for a bank match.
          status: "pending",
          ...(selected_game ? { selected_game } : {}),
          ...(selected_game && username.trim()
            ? { selected_game_username: username.trim() }
            : {}),
          ...(pct ? { bonus_percentage: pct } : {}),
          skip_bot: mode.skip_bot,
          ...(assign ? { assign_to_me: true } : {}),
        },
      };
    },
    [playerByCode, gameByName, accountByLabel],
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
      const assign = parseAssign(d[c.assign] ?? "");
      if (assign === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
      const player = playerByCode.get(member.trim().toLowerCase());
      if (!player) return { ok: false, error: `Unknown member code "${member.trim()}"` };
      const g = gameByName.get(product.trim().toLowerCase());
      if (!g) return { ok: false, error: `Unknown product "${product.trim()}"` };
      const all = amount.trim().toLowerCase() === "all";
      const amt = all ? null : parseAmount(amount);
      if (!all && (amt === null || amt <= 0))
        return { ok: false, error: `Bad amount "${amount}" (number or ALL)` };
      const mode = parseMode(d[c.mode]);
      if (!mode.ok) return mode;
      const paidCell = (d[c.paidfrom] ?? "").trim();
      const paidFrom = paidCell ? accountByLabel.get(paidCell.toLowerCase()) : undefined;
      if (paidCell && !paidFrom)
        return {
          ok: false,
          error: `"${paidCell}" is not one of our accounts — pick one from the list`,
        };
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          game_name: g,
          skip_bot: mode.skip_bot,
          ...(paidFrom ? { paid_from_account_id: paidFrom.account_id } : {}),
          ...(username.trim() ? { game_username: username.trim() } : {}),
          ...(all ? { withdraw_all: true } : { requested_amount: amt }),
          ...(bank.trim() ? { bank_name: bank.trim() } : {}),
          ...(account.trim() ? { bank_account_number: account.trim() } : {}),
          ...(assign ? { assign_to_me: true } : {}),
        },
      };
    },
    [playerByCode, gameByName, accountByLabel],
  );

  const parseFreeCreditDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.freecredit;
      if (parseAssign(d[c.assign] ?? "") === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
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
      const parsedMode = parseMode(mode);
      if (!parsedMode.ok) return parsedMode;
      const skip_bot = parsedMode.skip_bot;
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
      const toUsername = d[c.to_username] ?? "";
      const amount = d[c.amount] ?? "";
      const assign = parseAssign(d[c.assign] ?? "");
      if (assign === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
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
      const mode = parseMode(d[c.mode]);
      if (!mode.ok) return mode;
      return {
        ok: true,
        payload: {
          player_id: player.player_id,
          from_game: fromGame,
          to_game: toGame,
          skip_bot: mode.skip_bot,
          ...(username.trim() ? { from_game_username: username.trim() } : {}),
          ...(toUsername.trim() ? { to_game_username: toUsername.trim() } : {}),
          ...(all ? { transfer_all: true } : { amount: amt }),
          ...(assign ? { assign_to_me: true } : {}),
        },
      };
    },
    [playerByCode, gameByName],
  );

  /**
   * A typed "Paid From": one of our accounts by label, or "<leader> cash".
   * Blank leaves it unrecorded, as every expense entered before the column.
   */
  const resolvePaidFrom = useCallback(
    (
      raw: string,
    ):
      | { ok: true; account_id?: number; cash_entity_id?: number }
      | { ok: false } => {
      const v = raw.trim();
      if (!v) return { ok: true };
      const account = bankAccounts.find(
        (a) =>
          (a.label ?? "").trim().toLowerCase() === v.toLowerCase() ||
          `${a.bank_name} ${a.account_number}`.toLowerCase() === v.toLowerCase(),
      );
      if (account) return { ok: true, account_id: account.account_id };
      // "<leader> cash" — the suffix is what marks it as cash rather than an
      // account, so a leader named after a bank can't be mistaken for one.
      const lower = v.toLowerCase();
      if (lower.endsWith(` ${CASH_SUFFIX}`)) {
        const name = v.slice(0, -(CASH_SUFFIX.length + 1)).trim().toLowerCase();
        const id = leaderByName.get(name);
        if (id) return { ok: true, cash_entity_id: id };
      }
      return { ok: false };
    },
    [bankAccounts, leaderByName],
  );

  const parseExpenseDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.expense;
      if (parseAssign(d[c.assign] ?? "") === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
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
      const paidCell = (d[c.paidfrom] ?? "").trim();
      const paid = resolvePaidFrom(paidCell);
      if (!paid.ok)
        return {
          ok: false,
          error: `Unknown source "${paidCell}" — pick an account, or "<leader> cash"`,
        };
      return {
        ok: true,
        payload: {
          expense_date,
          category: cat,
          description: description.trim(),
          amount: amt,
          company_entity_id,
          ...(paid.account_id ? { paid_from_account_id: paid.account_id } : {}),
          ...(paid.cash_entity_id
            ? { paid_from_cash_entity_id: paid.cash_entity_id }
            : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      };
    },
    [companyByName, resolvePaidFrom],
  );

  const parseLeaderWithdrawalDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.leaderwithdrawal;
      if (parseAssign(d[c.assign] ?? "") === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
      const accountCell = (d[c.account] ?? "").trim();
      const account = accountByLabel.get(accountCell.toLowerCase());
      if (!account) return { ok: false, error: `Unknown bank account "${accountCell}"` };
      if (!companyInScope(account.entity_id))
        return { ok: false, error: `${account.bank_name} ${account.account_number} is outside your scope` };
      const amt = parseAmount(d[c.amount] ?? "");
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${d[c.amount]}"` };
      if (amt > account.current_balance)
        return { ok: false, error: `Exceeds the account balance (${fmtAmount(account.current_balance)})` };
      const takenCell = (d[c.takenby] ?? "").trim();
      if (!takenCell) return { ok: false, error: "Say who took the cash" };
      const leaderId = leaderByName.get(takenCell.toLowerCase()) ?? null;
      const dateCell = (d[c.date] ?? "").trim();
      const ymd = dateCell ? parseSheetDate(dateCell) : new Date().toISOString().slice(0, 10);
      if (!ymd) return { ok: false, error: `Bad date "${dateCell}" (use 31/8/2026)` };
      const timeCell = (d[c.time] ?? "").trim();
      const hm = timeCell ? parseSheetTime(timeCell) : null;
      if (timeCell && !hm) return { ok: false, error: `Bad time "${timeCell}" (use 14:30)` };
      const [y, m, day] = ymd.split("-").map(Number);
      // No time typed = now on that date, so the record isn't stamped at midnight.
      const nowD = new Date();
      const occurred = hm
        ? new Date(y, m - 1, day, hm[0], hm[1])
        : new Date(y, m - 1, day, nowD.getHours(), nowD.getMinutes());
      if (occurred.getTime() > Date.now() + 5 * 60_000)
        return { ok: false, error: "The withdrawal time can't be in the future" };
      const notes = (d[c.notes] ?? "").trim();
      return {
        ok: true,
        payload: {
          account_id: account.account_id,
          amount: amt,
          ...(leaderId ? { taken_by_entity_id: leaderId } : { taken_by: takenCell }),
          occurred_at: occurred.toISOString(),
          ...(notes ? { notes } : {}),
        },
      };
    },
    [accountByLabel, leaderByName, companyInScope],
  );

  /**
   * A typed end: the word "cash", one of our accounts by label, or blank for
   * an end nobody recorded. Matched on label first, then on "bank number", so
   * either spelling from the dropdown resolves.
   */
  const resolveTransferEnd = useCallback(
    (raw: string): { ok: true; account_id?: number; cash?: boolean } | { ok: false } => {
      const v = raw.trim();
      if (!v) return { ok: true };
      if (v.toLowerCase() === CASH.toLowerCase()) return { ok: true, cash: true };
      const hit = bankAccounts.find(
        (a) =>
          (a.label ?? "").trim().toLowerCase() === v.toLowerCase() ||
          `${a.bank_name} ${a.account_number}`.toLowerCase() === v.toLowerCase(),
      );
      return hit ? { ok: true, account_id: hit.account_id } : { ok: false };
    },
    [bankAccounts],
  );

  const parseLeaderTransferDraft = useCallback(
    (d: string[]): Parsed => {
      const c = COL.leadertransfer;
      if (parseAssign(d[c.assign] ?? "") === null)
        return { ok: false, error: `Assign to me must be yes or no, not "${d[c.assign]?.trim()}"` };
      const fromCell = (d[c.from] ?? "").trim();
      const toCell = (d[c.to] ?? "").trim();
      const fromId = leaderByName.get(fromCell.toLowerCase());
      if (!fromId) return { ok: false, error: `Unknown leader "${fromCell}"` };
      const toId = leaderByName.get(toCell.toLowerCase());
      if (!toId) return { ok: false, error: `Unknown leader "${toCell}"` };
      const amt = parseAmount(d[c.amount] ?? "");
      if (amt === null || amt <= 0) return { ok: false, error: `Bad amount "${d[c.amount]}"` };
      const note = (d[c.note] ?? "").trim();
      const fromEndCell = (d[c.fromaccount] ?? "").trim();
      const toEndCell = (d[c.toaccount] ?? "").trim();
      const fromEnd = resolveTransferEnd(fromEndCell);
      if (!fromEnd.ok)
        return { ok: false, error: `Unknown account "${fromEndCell}" — pick one from the list, or Cash` };
      const toEnd = resolveTransferEnd(toEndCell);
      if (!toEnd.ok)
        return { ok: false, error: `Unknown account "${toEndCell}" — pick one from the list, or Cash` };
      // One leader moving money to themselves is fine — bank to cash, cash to
      // bank, one account to another — as long as the two ends differ. Same
      // leader, same end moves nothing.
      if (
        fromId === toId &&
        ((fromEnd.account_id != null && fromEnd.account_id === toEnd.account_id) ||
          (fromEnd.cash && toEnd.cash) ||
          (!fromEndCell && !toEndCell))
      ) {
        return {
          ok: false,
          error: `${fromCell} to themselves needs two different ends — account to account, or account to Cash`,
        };
      }
      return {
        ok: true,
        payload: {
          from_leader_entity_id: fromId,
          to_leader_entity_id: toId,
          amount: amt,
          ...(fromEnd.account_id ? { from_account_id: fromEnd.account_id } : {}),
          ...(fromEnd.cash ? { from_cash: true } : {}),
          ...(toEnd.account_id ? { to_account_id: toEnd.account_id } : {}),
          ...(toEnd.cash ? { to_cash: true } : {}),
          ...(note ? { note } : {}),
        },
      };
    },
    [leaderByName, resolveTransferEnd],
  );

  // Rebates aren't typed in — they're generated on the Rebates page.
  const parseRebateDraft = useCallback(
    (): Parsed => ({ ok: false, error: "Rebates are generated on the Rebates page, not typed here" }),
    [],
  );

  const parseByTab: Record<TabKey, (d: string[]) => Parsed> = {
    deposit: parseDepositDraft,
    withdrawal: parseWithdrawalDraft,
    freecredit: parseFreeCreditDraft,
    transfer: parseTransferDraft,
    leaderwithdrawal: parseLeaderWithdrawalDraft,
    rebate: parseRebateDraft,
    leadertransfer: parseLeaderTransferDraft,
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
    () =>
      new Set([
        COL.deposit.member,
        COL.deposit.product,
        COL.deposit.username,
        COL.deposit.amount,
        COL.deposit.bonuspct,
        COL.deposit.bank,
      ]),
    [],
  );
  /** The same for a withdrawal, which is only correctable before the pull. */
  const WITHDRAWAL_EDITABLE_COLS = useMemo(
    () =>
      new Set([
        COL.withdrawal.product,
        COL.withdrawal.username,
        COL.withdrawal.amount,
        COL.withdrawal.bank,
        COL.withdrawal.account,
      ]),
    [],
  );

  /**
   * Statuses a deposit can still be corrected in.
   *
   * "processing" belongs here: manual deposits are auto-approved on save, so
   * that is where a freshly typed row lands, and leaving it out made every new
   * row read-only the moment it was entered. No money has moved in any of
   * these — it books at completion.
   */
  const DEPOSIT_EDITABLE_STATUS = useMemo(
    () => new Set(["pending_match", "matched", "pending", "approved", "processing"]),
    [],
  );
  /** The saved sheets whose rows carry a claim — their Assign cell edits in place. */
  const ASSIGNABLE_TABS = useMemo(() => new Set<TabKey>(["deposit", "withdrawal", "transfer"]), []);
  const assignColOf = useCallback(
    (t: TabKey): number | undefined =>
      ASSIGNABLE_TABS.has(t) ? (COL[t] as Record<string, number | undefined>).assign : undefined,
    [ASSIGNABLE_TABS],
  );
  /**
   * Who holds a saved row, if anyone. Only the sheets that carry a claim.
   */
  const ownerOf = useCallback(
    (rowIndex: number): number | null | undefined => {
      const id = Number(rows[rowIndex]?.id);
      if (tab === "deposit") return depositById.get(id)?.assigned_to_user_id ?? null;
      if (tab === "withdrawal") return withdrawalById.get(id)?.assigned_to_user_id ?? null;
      if (tab === "transfer")
        return gameTransfers.find((t) => t.transfer_id === id)?.assigned_to_user_id ?? null;
      return undefined;                   // this sheet has no claims
    },
    [tab, rows, depositById, withdrawalById, gameTransfers],
  );

  const committedEditable = useCallback(
    (rowIndex: number, colIndex: number): boolean => {
      if (isViewer) return false;

      /**
       * A row is edited by whoever holds it.
       *
       * Two people working the same deposit is how a top-up gets done twice,
       * so a claim is the lock: take the row first, and until you do, it is
       * read-only. The claim cell itself is the way in and the way out — it
       * opens on an unheld row (to take it) and on your own (to release it),
       * and never on a colleague's, which the server refuses anyway.
       */
      const owner = ownerOf(rowIndex);
      if (owner !== undefined) {
        const mine = owner !== null && owner === me?.user_id;
        if (colIndex === assignColOf(tab)) return owner === null || mine;
        if (!mine) return false;
      } else if (colIndex === assignColOf(tab)) {
        return true;
      }
      if (tab === "deposit") {
        if (!DEPOSIT_EDITABLE_COLS.has(colIndex)) return false;
        const dep = depositById.get(Number(rows[rowIndex]?.id));
        if (!dep) return false;
        if (DEPOSIT_EDITABLE_STATUS.has(dep.status)) return true;
        // A completed row a person entered is still correctable: the server
        // unwinds the credit it booked and lays down the new one. A row the
        // agent completed is its own record of what happened at the provider,
        // so it stays frozen — and so does a failed one, which booked nothing.
        return dep.status === "completed" && !!dep.skip_bot;
      }
      if (tab === "withdrawal") {
        if (!WITHDRAWAL_EDITABLE_COLS.has(colIndex)) return false;
        const w = withdrawalById.get(Number(rows[rowIndex]?.id));
        if (!w) return false;
        if (w.status === "requested") return true;
        // A manual row is created already pulled, so it stays correctable —
        // the server re-books the float and the wallet. The agent's own pulls
        // stay as the agent reported them, and a paid row has left a bank.
        return w.status === "credits_pulled" && !!w.skip_bot;
      }
      return false;
    },
    [
      tab,
      isViewer,
      me,
      ownerOf,
      DEPOSIT_EDITABLE_COLS,
      DEPOSIT_EDITABLE_STATUS,
      WITHDRAWAL_EDITABLE_COLS,
      depositById,
      withdrawalById,
      rows,
      assignColOf,
    ],
  );

  const onCommittedEdit = useCallback(
    async (rowIndex: number, colIndex: number, value: string) => {
      if (colIndex === assignColOf(tab)) {
        // The cell shows "Yes" / a colleague's name / blank; what's typed is
        // yes or no. A name typed back in is a no-op, not an error.
        const want = parseAssign(value);
        if (want === null) {
          const trimmed = value.trim();
          if (trimmed && trimmed !== (rows[rowIndex]?.cells[colIndex] ?? "")) {
            toast.error(`Assign to me takes yes or no, not "${trimmed}"`);
          }
          return;
        }
        const id = Number(rows[rowIndex]?.id);
        if (!Number.isFinite(id)) return;
        const res = await setAssignment({
          kind: tab === "deposit" ? "deposit" : tab === "withdrawal" ? "withdrawal" : "game_transfer",
          id,
          assign: want,
        });
        if (!res.ok) toast.error(res.error ?? (want ? "Could not claim the row" : "Could not release the row"));
        return;
      }
      // ── withdrawals ─────────────────────────────────────────────────────
      if (tab === "withdrawal") {
        const w = withdrawalById.get(Number(rows[rowIndex]?.id));
        if (!w) return;
        const v = value.trim();
        const c = COL.withdrawal;
        let patch: Record<string, unknown> | null = null;

        if (colIndex === c.product) {
          const g = gameByName.get(v.toLowerCase());
          if (!g) {
            toast.error(`Unknown product "${v}" — game not changed`);
            return;
          }
          patch = { game_name: g };
        } else if (colIndex === c.username) {
          patch = { game_username: v || null };
        } else if (colIndex === c.amount) {
          const amt = parseAmount(v);
          if (amt === null || amt <= 0) {
            toast.error(`Bad amount "${v}"`);
            return;
          }
          patch = { requested_amount: amt };
        } else if (colIndex === c.bank) {
          patch = { bank_name: v || null };
        } else if (colIndex === c.account) {
          patch = { bank_account_number: v || null };
        }
        if (!patch) return;

        const res = await fetch(`/api/withdrawals/${w.withdrawal_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          toast.error(data?.error ?? "Could not edit the withdrawal");
          return;
        }
        await refresh();
        return;
      }

      // ── deposits ────────────────────────────────────────────────────────
      const dep = depositById.get(Number(rows[rowIndex]?.id));
      if (!dep) return;
      const v = value.trim();
      /**
       * Correcting a completed row unwinds the credit it booked. When the
       * player has already spent some of it the wallet lands below zero, and
       * the server says so — that is the desk's cue to sync the kiosk, so it
       * gets its own line rather than being folded into a quiet success.
       */
      const report = (res: MutationResult, fallback: string) => {
        if (!res.ok) toast.error(res.error ?? fallback);
        else if (res.warning) toast.warning(res.warning, { duration: 10_000 });
      };
      if (colIndex === COL.deposit.member) {
        const pl = playerByCode.get(v.toLowerCase());
        if (!pl) {
          toast.error(`Unknown member code "${v}" — player not changed`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { player_id: pl.player_id });
        report(res, "Failed to assign player");
      } else if (colIndex === COL.deposit.product) {
        if (!v) {
          const res = await updateDepositDraft(dep.deposit_id, { selected_game: null });
          report(res, "Failed to clear game");
          return;
        }
        const g = gameByName.get(v.toLowerCase());
        if (!g) {
          toast.error(`Unknown product "${v}" — game not changed`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { selected_game: g });
        report(res, "Failed to set game");
      } else if (colIndex === COL.deposit.bonuspct) {
        const pct = parseBonusPct(value);
        if (pct === null) {
          toast.error(`Bad bonus % "${value}"`);
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { bonus_percentage: pct });
        report(res, "Failed to set bonus");
      } else if (colIndex === COL.deposit.username) {
        const res = await updateDepositDraft(dep.deposit_id, {
          selected_game_username: v || null,
        });
        report(res, "Failed to set the kiosk login");
      } else if (colIndex === COL.deposit.amount) {
        const amt = parseAmount(v);
        if (amt === null || amt <= 0) {
          toast.error(`Bad amount "${v}"`);
          return;
        }
        // The server re-bases the bonus on the new figure, so a corrected
        // amount can't leave a bonus struck on the old one.
        const res = await updateDepositDraft(dep.deposit_id, { deposit_amount: amt });
        report(res, "Failed to set the amount");
      } else if (colIndex === COL.deposit.bank) {
        if (!v) {
          toast.error("Bank is required");
          return;
        }
        const res = await updateDepositDraft(dep.deposit_id, { bank_name: v });
        report(res, "Failed to set the bank");
      }
    },
    [
      tab,
      assignColOf,
      setAssignment,
      depositById,
      withdrawalById,
      rows,
      playerByCode,
      gameByName,
      updateDepositDraft,
      refresh,
    ],
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
  // Rebate sheet filters: the active rebate plans in scope, and the windows
  // present in the (plan-filtered) payouts, newest first.
  const rebatePlans = useMemo(
    () =>
      bonusPlans.filter(
        (b) =>
          b.type === "rebate" &&
          b.status === "active" &&
          (b.company_entity_id === null || companyInScope(b.company_entity_id)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bonusPlans, selectedCompanyId, selectedLeaderId],
  );
  const rebateWindows = useMemo(() => {
    const m = new Map<string, { value: string; label: string; end: string }>();
    for (const r of rebatePayouts) {
      if (rebatePlanFilter.size && !rebatePlanFilter.has(r.plan_id)) continue;
      if (!m.has(r.window_start)) {
        m.set(r.window_start, {
          value: r.window_start,
          label: `${sheetDate(r.window_start)} – ${sheetDate(r.window_end)}`,
          end: r.window_end,
        });
      }
    }
    return [...m.values()].sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
  }, [rebatePayouts, rebatePlanFilter]);
  const toggleRebatePlan = useCallback((planId: number) => {
    setRebatePlanFilter((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
    setRebateWindowFilter("all");
  }, []);
  /** Generate the latest closed window for the one plan lit in the filter. */
  const handleGenerateRebate = useCallback(async () => {
    const ids = [...rebatePlanFilter];
    if (ids.length !== 1 || generatingRebate) return;
    setGeneratingRebate(true);
    try {
      const res = await fetch("/api/rebates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: ids[0] }),
      });
      const d = (await res.json().catch(() => null)) as
        | { inserted?: number; replaced?: number; error?: string; payouts_for?: string | null }
        | null;
      if (!res.ok) {
        toast.error(d?.error ?? `Request failed (${res.status})`);
        return;
      }
      toast.success(
        d?.inserted === 0
          ? "No player lost money in the latest window — nothing to pay"
          : `${d?.inserted ?? 0} player${d?.inserted === 1 ? "" : "s"} on the list${
              d?.replaced ? " (previous unpaid list replaced)" : ""
            }`,
      );
      await loadRebatePayouts();
      if (d?.payouts_for) setRebateWindowFilter(d.payouts_for);
    } finally {
      setGeneratingRebate(false);
    }
  }, [rebatePlanFilter, generatingRebate, loadRebatePayouts]);

  const cashOutById = useMemo(() => {
    const m = new Map<number, BankCashOut>();
    for (const c of cashOuts) m.set(c.cash_out_id, c);
    return m;
  }, [cashOuts]);
  const selectedCashOuts = useMemo(
    () =>
      tab === "leaderwithdrawal"
        ? selectedNumericIds
            .map((id) => cashOutById.get(id))
            .filter((c): c is BankCashOut => !!c)
        : [],
    [tab, selectedNumericIds, cashOutById],
  );
  const rebateById = useMemo(() => {
    const m = new Map<number, RebatePayoutLedgerRow>();
    for (const r of rebatePayouts) m.set(r.payout_id, r);
    return m;
  }, [rebatePayouts]);
  const selectedRebates = useMemo(
    () =>
      tab === "rebate"
        ? selectedNumericIds
            .map((id) => rebateById.get(id))
            .filter((r): r is RebatePayoutLedgerRow => !!r)
        : [],
    [tab, selectedNumericIds, rebateById],
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
    // Only rows already claimed by the caller — the button is disabled
    // otherwise, and the keyboard path checks the same flag.
    const ids = selectedDeposits
      .filter(
        (d) => ["pending", "matched"].includes(d.status) && d.assigned_to_user_id === me?.user_id,
      )
      .map((d) => d.deposit_id);
    await runBulk("Approve", ids, approveDeposit);
  }, [selectedDeposits, runBulk, me, approveDeposit]);

  // Approve and Reject act only on rows the caller has claimed — a claim is
  // what says "I'm on this one", and two agents rejecting the same deposit is
  // exactly the collision the claim exists to prevent. The rows are still
  // selectable; the buttons show, disabled, with the hint to claim first.
  const mine = (userId: number | null | undefined) => !!me && userId === me.user_id;
  const approvable = selectedDeposits.filter((d) => ["pending", "matched"].includes(d.status));
  const rejectableDep = selectedDeposits.filter((d) =>
    ["pending_match", "matched", "pending"].includes(d.status),
  );
  const rejectableWd = selectedWithdrawals.filter((w) => w.status === "requested");
  const can = useMemo(
    () => ({
      assign:
        (tab === "deposit" || tab === "withdrawal" || tab === "transfer") &&
        selectedNumericIds.length > 0,
      approve: approvable.length > 0,
      approveMine: approvable.length > 0 && approvable.every((d) => mine(d.assigned_to_user_id)),
      complete: selectedDeposits.some((d) => ["approved", "processing"].includes(d.status)),
      retryDep: selectedDeposits.some((d) => d.status === "failed"),
      rejectDep: rejectableDep.length > 0,
      rejectDepMine:
        rejectableDep.length > 0 && rejectableDep.every((d) => mine(d.assigned_to_user_id)),
      pull: selectedWithdrawals.some((w) => w.status === "requested"),
      paid: selectedWithdrawals.some((w) => w.status === "credits_pulled"),
      rejectWd: rejectableWd.length > 0,
      rejectWdMine:
        rejectableWd.length > 0 && rejectableWd.every((w) => mine(w.assigned_to_user_id)),
      retryTf: selectedTransfers.some((t) => t.status === "failed"),
      delExp: tab === "expense" && selectedExpenses.length > 0,
      // Reversing a cash-out is a leader's call; paying/skipping a rebate is CS work.
      revCash:
        tab === "leaderwithdrawal" &&
        (me?.role === "super_admin" || me?.role === "company_leader") &&
        selectedCashOuts.some((c) => !c.reversed_at),
      payReb: selectedRebates.some((r) => r.live_status === "pending"),
      skipReb: selectedRebates.some((r) => r.live_status === "pending"),
      unskipReb: selectedRebates.some((r) => r.live_status === "skipped"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tab, me, selectedNumericIds, selectedDeposits, selectedWithdrawals, selectedTransfers,
      selectedExpenses, selectedCashOuts, selectedRebates,
    ],
  );

  // The player behind the current selection — set only when every selected row
  // points at the same one, so "View player" is unambiguous. Free-credit rows
  // aren't selectable, so this covers deposit/withdrawal/transfer.
  const selectedPlayerId = useMemo(() => {
    const ids = new Set<number>();
    for (const d of selectedDeposits) if (d.player_id) ids.add(d.player_id);
    for (const w of selectedWithdrawals) ids.add(w.player_id);
    for (const t of selectedTransfers) ids.add(t.player_id);
    for (const r of selectedRebates) ids.add(r.player_id);
    return ids.size === 1 ? [...ids][0] : null;
  }, [selectedDeposits, selectedWithdrawals, selectedTransfers, selectedRebates]);

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
          .filter(
            (d) =>
              ["pending_match", "matched", "pending"].includes(d.status) &&
              d.assigned_to_user_id === me?.user_id,
          )
          .map((d) => d.deposit_id),
      }),
    [selectedDeposits, me],
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
          .filter((w) => w.status === "requested" && w.assigned_to_user_id === me?.user_id)
          .map((w) => w.withdrawal_id),
      }),
    [selectedWithdrawals, me],
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
  const handleReverseCashOuts = useCallback(
    () =>
      setConfirming({
        kind: "reverse-cashout",
        ids: selectedCashOuts.filter((c) => !c.reversed_at).map((c) => c.cash_out_id),
      }),
    [selectedCashOuts],
  );
  const handlePayRebates = useCallback(
    (byHand: boolean) =>
      setConfirming({
        kind: byHand ? "pay-rebate-manual" : "pay-rebate",
        ids: selectedRebates.filter((r) => r.live_status === "pending").map((r) => r.payout_id),
      }),
    [selectedRebates],
  );
  /** Skip / unskip go straight through — nothing moves money. */
  const setRebateStatus = useCallback(
    async (status: "pending" | "skipped") => {
      const from = status === "skipped" ? "pending" : "skipped";
      const ids = selectedRebates.filter((r) => r.live_status === from).map((r) => r.payout_id);
      await runBulk(status === "skipped" ? "Skip" : "Unskip", ids, async (id) => {
        const res = await fetch(`/api/rebates/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (res.ok) return { ok: true };
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        return { ok: false, error: d?.error ?? `Request failed (${res.status})` };
      });
      await loadRebatePayouts();
    },
    [selectedRebates, runBulk, loadRebatePayouts],
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
        if (k === "p" && can.approveMine) run = handleApprove;
        // ⌘B, never ⌘C. The clipboard keys belong to the sheet — this screen
        // exists so people can copy rows straight into Excel, and ⌘C is the
        // most reflexive keystroke there is. It used to sit here, where it
        // beat the grid's copy (this listener captures and preventDefaults,
        // so the browser never issued the copy) and completed the deposits
        // instead, with no confirmation.
        //
        // ⌘B also makes the two flows read the same: ⌘P advances a row —
        // approve a deposit, pull a withdrawal — and ⌘B finishes it.
        else if (k === "b" && can.complete) run = handleComplete;
        // ⌘I, not ⌘T — the browser reserves ⌘T / Ctrl+T for "new tab" and the
        // page never receives it.
        else if (k === "i" && can.retryDep) run = handleRetryDeposits;
        // No key for Reject on purpose: ⌘R / Ctrl+R is the browser's reload,
        // and a destructive action must never sit on a reflex keystroke.
      } else if (tab === "withdrawal") {
        if (k === "p" && can.pull) run = handlePull;
        // ⌘B, not ⌘M — ⌘M minimises the window on macOS before the page sees it.
        else if (k === "b" && can.paid) run = handleMarkPaid;
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
    handlePull, handleMarkPaid, handleRetryTransfers, handleDeleteExpenses,
  ]);

  // Shift+Cmd/Ctrl+Left/Right cycles the worksheet tabs — global, so it works
  // whether the focus is in the grid, a filter, or nowhere. Skips while a text
  // field is focused so it never fights caret movement.
  useEffect(() => {
    const order: TabKey[] = [
      "deposit",
      "withdrawal",
      "rebate",
      "freecredit",
      "transfer",
      "leaderwithdrawal",
      ...(isAdmin ? (["leadertransfer", "expense"] as TabKey[]) : []),
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
    leaderwithdrawal: "/api/bank-accounts/cash-outs",
    rebate: "/api/rebates/payouts", // never posted to — the sheet is read-only
    leadertransfer: "/api/leader-transfers",
    expense: "/api/expenses",
  };

  const handleCommit = useCallback(async () => {
    if (saving || isViewer) return;
    /**
     * Land the cell still under the cursor first.
     *
     * The shortcut is caught on window before the editor sees it, so without
     * this the row is parsed as it was one keystroke ago — which is why typing
     * an amount and pressing ⌘S reported "Bad amount """. The flush writes it
     * into the grid's state and hands it back, because that state update won't
     * be visible to this call.
     */
    const pending = flushEdit.current?.() ?? null;
    const drafts = pending
      ? draftsRaw.map((d, i) =>
          i === pending.draftIndex
            ? d.map((v, c) => (c === pending.col ? pending.value : v))
            : d,
        )
      : draftsRaw;
    const jobs = drafts
      .map((d, i) => ({ d, i, parsed: parseDraft(d) }))
      .filter((j) => !isBlankDraft(tab, j.d) && j.parsed.ok) as Array<{
      d: string[];
      i: number;
      parsed: { ok: true; payload: Record<string, unknown> };
    }>;
    if (!jobs.length) {
      // The reason was only ever a tooltip on the ! marker, which is a hard
      // place to find an answer when the save just refused. Say it outright.
      const why = drafts
        .map((d, i) => ({ d, i, parsed: parseDraft(d) }))
        .filter((j) => !isBlankDraft(tab, j.d) && !j.parsed.ok)
        .map((j) => `Row ${j.i + 1}: ${(j.parsed as { error?: string }).error ?? "incomplete"}`);
      toast.error("No rows saved", {
        description: why.length ? why.slice(0, 3).join("\n") : "Nothing filled in yet.",
        duration: 15_000,
      });
      return;
    }
    setSaving(true);
    const path = COMMIT_PATH[tab];
    const succeeded = new Set<number>();
    const failures = new Map<string, string>(commitErrors);
    // Sequential on purpose: keeps server order = sheet order, and one clear
    // error per row instead of a burst of races.
    const warnings: string[] = [];
    for (const job of jobs) {
      const res = await post(path, job.parsed.payload);
      if (res.ok) {
        succeeded.add(job.i);
        failures.delete(draftKey(job.d));
        if (res.warning) warnings.push(res.warning);
      } else {
        failures.set(draftKey(job.d), res.error ?? "Save failed");
      }
    }
    const remaining = drafts.filter((_, i) => !succeeded.has(i));
    setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(remaining, tab) }));
    setCommitErrors(failures);
    setSaving(false);
    await Promise.all([refresh(), loadLedgers(), loadRangeRows(tab)]);
    const failed = jobs.length - succeeded.size;
    const noun = {
      deposit: "deposit",
      withdrawal: "withdrawal",
      freecredit: "free credit",
      transfer: "transfer",
      leaderwithdrawal: "cash withdrawal",
      rebate: "rebate",
      leadertransfer: "leader transfer",
      expense: "expense",
    }[tab];
    if (failed) {
      // One line per distinct reason — five rows refused for the same reason
      // is one thing to fix, not five.
      const reasons = [
        ...new Set(
          jobs
            .filter((j) => !succeeded.has(j.i))
            .map((j) => failures.get(draftKey(j.d)))
            .filter((r): r is string => !!r),
        ),
      ];
      toast.error(`${succeeded.size} saved, ${failed} rejected`, {
        description: reasons.slice(0, 3).join("\n") || "Rejected rows stay below, marked !.",
        duration: 15_000,
      });
    } else {
      toast.success(`${succeeded.size} ${noun}${succeeded.size === 1 ? "" : "s"} saved`);
    }
    // Saved-but-unfinished rows: one warning per distinct reason, so five
    // deposits short on the same kiosk say it once.
    for (const w of new Set(warnings)) {
      toast.warning(`${w} — saved, waiting at Processing.`, { duration: 10_000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, isViewer, draftsRaw, parseDraft, tab, commitErrors, draftKey, refresh, loadLedgers, loadRangeRows]);

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

  const statusOptionsByTab: Record<TabKey, [string, string][]> = {
    deposit: Object.entries(DEPOSIT_STATUS_LABEL),
    withdrawal: Object.entries(WITHDRAWAL_STATUS_LABEL),
    freecredit: [
      ["credited", "Credited"],
      ["queued", "Queued"],
      ...Object.entries(TRANSFER_STATUS_LABEL),
    ],
    transfer: Object.entries(TRANSFER_STATUS_LABEL),
    leaderwithdrawal: [
      ["debited", "Debited"],
      ["reversed", "Reversed"],
    ],
    rebate: Object.entries(REBATE_STATUS_LABEL),
    leadertransfer: [],
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
    if (confirming.kind === "reverse-cashout") {
      const list = confirming.ids
        .map((id) => cashOutById.get(id))
        .filter((c): c is BankCashOut => !!c);
      return {
        title: `Reverse ${list.length} cash withdrawal${list.length === 1 ? "" : "s"}?`,
        description: "The amounts go back on their bank accounts. The rows stay, marked reversed.",
        confirmLabel: "Reverse",
        summary: [
          { label: "Withdrawals", value: String(list.length) },
          {
            label: "Total amount",
            value: fmtAmount(list.reduce((a, c) => a + c.amount, 0)),
            emphasis: true,
          },
        ] as SummaryRow[],
        items: list.map((c) => {
          const a = accountById.get(c.account_id);
          return {
            key: c.cash_out_id,
            label: c.taken_by,
            meta: a ? `${a.bank_name} ${a.account_number}` : `#${c.account_id}`,
            value: fmtAmount(c.amount),
          };
        }),
        run: async () => {
          await runBulk("Reverse", list.map((c) => c.cash_out_id), reverseBankCashOut);
          await loadCashOuts();
        },
      };
    }
    if (confirming.kind === "pay-rebate" || confirming.kind === "pay-rebate-manual") {
      const byHand = confirming.kind === "pay-rebate-manual";
      const list = confirming.ids
        .map((id) => rebateById.get(id))
        .filter((r): r is RebatePayoutLedgerRow => !!r);
      return {
        title: `Pay ${list.length} rebate${list.length === 1 ? "" : "s"}?`,
        description: byHand
          ? "Booked as already credited in the back-office — the agent does nothing."
          : "Each rebate is queued as a free credit for the agent to put into the player's game.",
        confirmLabel: byHand ? "Book as credited" : "Queue for the agent",
        summary: [
          { label: "Rebates", value: String(list.length) },
          {
            label: "Total amount",
            value: fmtAmount(list.reduce((a, r) => a + r.amount, 0)),
            emphasis: true,
          },
        ] as SummaryRow[],
        items: list.map((r) => ({
          key: r.payout_id,
          label: r.username,
          meta: `${r.plan_name} · ${r.game_name ?? "no game"}`,
          value: fmtAmount(r.amount),
        })),
        run: async () => {
          await runBulk("Pay", list.map((r) => r.payout_id), async (id) => {
            const res = await fetch("/api/rebates/pay", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ payouts: [{ payout_id: id }], skip_bot: byHand }),
            });
            const d = (await res.json().catch(() => null)) as
              | { paid?: number; failed?: Array<{ error: string }>; error?: string }
              | null;
            if (!res.ok) return { ok: false, error: d?.error ?? `Request failed (${res.status})` };
            if (d?.failed?.length) return { ok: false, error: d.failed[0].error };
            return { ok: true };
          });
          await loadRebatePayouts();
        },
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
    cashOutById, rebateById, accountById,
    runBulk, rejectDeposit, rejectWithdrawal, deleteExpense, reverseBankCashOut,
    loadCashOuts, loadRebatePayouts,
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

  /**
   * The free-credit headroom for whatever the header has scoped to, ready to
   * show above the sheet. The cap is enforced per company, so several
   * companies in scope means several separate allowances — totalled for the
   * figure, listed in the tooltip, because a company can be out of room while
   * the total still looks healthy.
   */
  const fcHeadroom = useMemo(() => {
    if (fcCapPct <= 0) return null;
    const rows = fcAllowance.filter(
      (a) => a.left !== null && companyInScope(a.company_entity_id),
    );
    if (!rows.length) return null;
    const left = rows.reduce((a, r) => a + (r.left ?? 0), 0);
    const allowance = rows.reduce((a, r) => a + (r.allowance ?? 0), 0);
    const month = new Date(`${rows[0].month}T00:00:00`).toLocaleString("en-MY", {
      month: "short",
    });
    return {
      left,
      allowance,
      month,
      // Any single company out of room matters even when the total does not.
      someExhausted: rows.some((r) => (r.left ?? 0) <= 0),
      rows,
    };
  }, [fcAllowance, fcCapPct, companyInScope]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "deposit", label: "Deposit" },
    { key: "withdrawal", label: "Withdrawal" },
    { key: "rebate", label: "Rebate" },
    { key: "freecredit", label: "Free Credit" },
    { key: "transfer", label: "Game Transfer" },
    { key: "leaderwithdrawal", label: "Clear Bank" },
    // Both are open to the desk now: expenses for bank charges, settlements
    // because CS records them alongside the day's takings. Each is scoped
    // server-side to the caller's own tree, so "open" does not mean "all".
    { key: "leadertransfer" as const, label: "Leader Transfer" },
    { key: "expense" as const, label: "Expenses" },
  ];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Always-on-top company info, above everything — the workbook's
          frozen block, in the dashboard's card language. */}
      <div className="shrink-0 px-3 pb-1 pt-2">
        <CompanyInfoPanel range={range} />
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

      {/* Toolbar — two rows: search, dates and buttons; then the filter pills. */}
      <div className="shrink-0 space-y-1.5 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-page-search
            title="Press ⌘F / Ctrl+F (or /) to jump here"
            placeholder="Search rows…"
            className="h-8 w-52 pl-7 text-[13px]"
          />
        </div>
        {/* Date range: a quick preset, or type the edges (which makes it custom). */}
        <Select
          value={preset}
          onValueChange={(v) => v && v !== "custom" && applyPreset(v as RangePreset)}
          items={[...RANGE_PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: "custom", label: "Custom" }]}
        >
          <SelectTrigger className="h-8 w-32 cursor-pointer text-[13px]" title={rangeLabel(range)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_PRESETS.map((p) => (
              <SelectItem key={p.key} value={p.key} className="cursor-pointer">
                {p.label}
              </SelectItem>
            ))}
            <SelectItem value="custom" disabled>
              Custom
            </SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-[12px] text-muted-foreground">
          <Input
            type="date"
            value={range.from ?? ""}
            max={range.to ?? undefined}
            onChange={(e) => setRangeEdge("from", e.target.value)}
            className="h-8 w-[138px] text-[12px]"
            title="From"
          />
          <span>–</span>
          <Input
            type="date"
            value={range.to ?? ""}
            min={range.from ?? undefined}
            onChange={(e) => setRangeEdge("to", e.target.value)}
            className="h-8 w-[138px] text-[12px]"
            title="To"
          />
        </div>

        <span className="text-xs text-muted-foreground">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>

        {/* How much free credit is still giveable this month. The cap has
            always been enforced on save; shown here it stops CS typing rows
            that will bounce. */}
        {tab === "freecredit" && fcHeadroom && (
          <span
            title={
              `Free credit is capped at ${fcCapPct}% of the month's deposits.\n` +
              `Counts the calendar month, not the date range above.\n\n` +
              fcHeadroom.rows
                .map(
                  (r) =>
                    `${entityName(r.company_entity_id)}: ${formatRM(r.left ?? 0)} left ` +
                    `(${formatRM(r.allowance ?? 0)} allowed, ${formatRM(r.issued)} issued)`,
                )
                .join("\n")
            }
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px] font-medium tabular-nums",
              fcHeadroom.left <= 0
                ? "border-red-600/40 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                : fcHeadroom.someExhausted || fcHeadroom.left < fcHeadroom.allowance * 0.2
                  ? "border-amber-600/40 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  : "border-emerald-600/40 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
            )}
          >
            {formatRM(fcHeadroom.left)} left of {formatRM(fcHeadroom.allowance)}
            <span className="ml-1 font-normal opacity-70">
              · {fcCapPct}% of {fcHeadroom.month} deposits
              {fcHeadroom.rows.length > 1 ? ` · ${fcHeadroom.rows.length} companies` : ""}
            </span>
          </span>
        )}

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
              await Promise.all([refresh(), loadLedgers()]);
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
        {(statusOptions.length > 0 || tab === "rebate") && (
          <div className="flex flex-wrap items-center gap-2">
        {/* Status pills — click to light any number; none lit = all. */}
        {statusOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status">
            {statusOptions.map(([value, label]) => {
              const on = statusFilters.has(value);
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleStatus(value)}
                  className={cn(
                    "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                    on
                      ? "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500"
                      : "border-border bg-background text-muted-foreground hover:border-emerald-600/50 hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
            {statusFilters.size > 0 && (
              <button
                type="button"
                onClick={() => setStatusFilters(new Set())}
                className="cursor-pointer px-1 text-[11px] text-muted-foreground hover:text-foreground"
                title="Show every status"
              >
                clear
              </button>
            )}
          </div>
        )}

        {/* Rebate sheet: plan pills, window, and generate. */}
        {tab === "rebate" && (
          <>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Rebate plan">
              {rebatePlans.map((b) => {
                const on = rebatePlanFilter.has(b.plan_id);
                return (
                  <button
                    key={b.plan_id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleRebatePlan(b.plan_id)}
                    title={`${BONUS_PERIOD_LABELS[b.period ?? "daily"]} · ${b.percentage}%`}
                    className={cn(
                      "cursor-pointer rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                      on
                        ? "border-sky-600 bg-sky-600 text-white dark:border-sky-500 dark:bg-sky-500"
                        : "border-border bg-background text-muted-foreground hover:border-sky-600/50 hover:text-foreground",
                    )}
                  >
                    {b.name}
                  </button>
                );
              })}
            </div>
            <Select
              value={rebateWindowFilter}
              onValueChange={(v) => setRebateWindowFilter(v ?? "all")}
              items={[{ value: "all", label: "All windows" }, ...rebateWindows]}
            >
              <SelectTrigger className="h-8 w-[220px] cursor-pointer text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  All windows
                </SelectItem>
                {rebateWindows.map((w) => (
                  <SelectItem key={w.value} value={w.value} className="cursor-pointer">
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!isViewer && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 cursor-pointer gap-1.5"
                onClick={handleGenerateRebate}
                disabled={generatingRebate || rebatePlanFilter.size !== 1}
                title={
                  rebatePlanFilter.size === 1
                    ? "Build the list for the plan's latest closed window"
                    : "Light exactly one plan pill to generate its latest list"
                }
              >
                {generatingRebate ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Generate latest list
              </Button>
            )}
          </>
        )}
          </div>
        )}
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
        flushRef={flushEdit}
        readOnly={isViewer || tab === "rebate"}
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
                disabled={acting || !can.approveMine}
                onClick={handleApprove}
                title={can.approveMine ? undefined : "Assign to me first — actions run only on rows you've claimed"}
                className="cursor-pointer gap-1 bg-emerald-700 text-white hover:bg-emerald-800 disabled:cursor-not-allowed"
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
                <Kbd k={`${MOD_LABEL}B`} />
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
                disabled={acting || !can.rejectDepMine}
                title={can.rejectDepMine ? undefined : "Assign to me first — actions run only on rows you've claimed"}
                onClick={handleRejectDeposits}
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Ban className="h-3 w-3" />
                Reject
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
                disabled={acting || !can.rejectWdMine}
                title={can.rejectWdMine ? undefined : "Assign to me first — actions run only on rows you've claimed"}
                onClick={handleRejectWithdrawals}
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Ban className="h-3 w-3" />
                Reject
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
            {can.revCash && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={handleReverseCashOuts}
                title="Put the amount back on the bank account"
                className="cursor-pointer gap-1 border-red-300 text-red-700 hover:bg-red-50 dark:text-red-300"
              >
                <Undo2 className="h-3 w-3" />
                Reverse
              </Button>
            )}
            {can.payReb && (
              <>
                <Button
                  size="xs"
                  disabled={acting}
                  onClick={() => handlePayRebates(false)}
                  title="Queue a free credit for the agent"
                  className="cursor-pointer gap-1"
                >
                  <Play className="h-3 w-3" />
                  Pay
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={acting}
                  onClick={() => handlePayRebates(true)}
                  title="CS already credited the game by hand — book it"
                  className="cursor-pointer gap-1"
                >
                  <HandCoins className="h-3 w-3" />
                  Paid by hand
                </Button>
              </>
            )}
            {can.skipReb && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={() => void setRebateStatus("skipped")}
                title="Leave these out of the payout"
                className="cursor-pointer gap-1"
              >
                <Ban className="h-3 w-3" />
                Skip
              </Button>
            )}
            {can.unskipReb && (
              <Button
                size="xs"
                variant="outline"
                disabled={acting}
                onClick={() => void setRebateStatus("pending")}
                title="Put these back on the payout list"
                className="cursor-pointer gap-1"
              >
                <RotateCcw className="h-3 w-3" />
                Unskip
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

"use client";

/**
 * Players — an Excel-style workbook with two tabs, like the Transactions sheet.
 *
 *  • Players — the member roster. The docked entry rows add a member the way CS
 *    works a list: type the phone and the Lead List cell offers the lists that
 *    phone leads in; pick one and the member code writes itself from the list's
 *    prefix. The first member from a list sets that prefix; everyone after is
 *    locked to it. Walk-ins with no list use the Import / Walk-in buttons.
 *
 *  • Leads — every lead under the lists you own, and entry rows to add more.
 *    A lead becomes a member from the Players tab (or the row shows "Member"
 *    once they have converted).
 *
 * A selection of member rows floats an action bar (⌘↵ opens the player).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { usePlayerProfile } from "@/components/player-name-link";
import { formatRM, maskPhone } from "@/lib/format";
import type { Player } from "@/lib/types";
import {
  SheetGrid,
  type SheetColumn,
  type SheetRow,
  type SheetSuggestion,
  type DraftStatus,
} from "@/components/sheet/sheet-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImportPlayersModal } from "@/components/import-players-modal";
import { ImportLeadsModal } from "@/components/import-leads-modal";
import { ShareListModal } from "@/components/share-list-modal";
import { CreatePlayerModal } from "@/components/create-player-modal";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Gamepad2,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Share2,
  Upload,
  User,
  UserPlus,
  X,
} from "lucide-react";

type TabKey = "players" | "leads" | "winloss";

/** One member's standing against the house, from /api/players/win-loss. */
type WinLossRow = {
  player_id: number;
  money_in: number;
  bonus: number;
  free_credit: number;
  recommend: number;
  money_out: number;
  net: number;
  last_deposit_at: string | null;
};

/** One lead list a phone belongs to, from /api/leads/lookup (Players entry). */
type LeadHit = {
  list_id: number;
  name: string;
  dist_id: number | null;
  prefix: string | null;
  next_code: string | null;
};
/** A visible lead list, from /api/lead-lists (Leads-tab dropdown). */
type LeadListRow = {
  list_id: number;
  name: string;
  prefix: string;
  next_seq: number;
  owner_leader_name?: string;
  lead_count?: number;
};
/** A lead row, from /api/leads (Leads-tab committed rows). */
type LeadRow = {
  lead_id: number;
  list_id: number;
  list_name: string;
  lead_code: string;
  phone: string | null;
  name: string;
  is_member: boolean;
};

const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl+";

function Kbd({ k }: { k: string }) {
  return (
    <kbd className="ml-0.5 rounded border border-border bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
      {k}
    </kbd>
  );
}

const MIN_BLANK_ROWS = 8;
const blankRow = (n: number) => Array<string>(n).fill("");

/** Keep a healthy tail of empty rows so there's always somewhere to type. */
function padDrafts(rows: string[][], nCols: number): string[][] {
  const next = rows.map((r) => {
    const c = [...r];
    while (c.length < nCols) c.push("");
    return c.slice(0, nCols);
  });
  let trailing = 0;
  for (let i = next.length - 1; i >= 0 && next[i].every((v) => !v.trim()); i--) trailing++;
  const want = Math.max(MIN_BLANK_ROWS - next.length, 3 - trailing);
  for (let i = 0; i < want; i++) next.push(blankRow(nCols));
  return next;
}

const fmtSeq = (prefix: string, seq: number) => `${prefix}${String(seq).padStart(4, "0")}`;
/** The letters a member/lead code starts with — its list prefix. */
const prefixOfCode = (code: string) => code.match(/^[^0-9]+/)?.[0] ?? "";

/**
 * How long a member has been quiet: "today", "3d", "2mo", or a dash when they
 * have never deposited. Days, not a date, because the question the column
 * answers is "who has gone cold" and a date makes the reader do the sum.
 */
function sinceLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d";
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

// Players tab: 0 Name · 1 Code · 2 Status · 3 Dep · 4 Wd · 5 Last dep · 6 Games
//
// No phone column. A member's number identifies them to whoever holds the
// list, which is the one piece of member data worth stealing, so it is not on
// screen at all — not even masked. It is still stored, still searchable, and
// still enterable on the Walk-in form where CS has been given it directly.
const PLAYER_COLUMNS: SheetColumn[] = [
  { key: "name", label: "Name", width: 210 },
  { key: "code", label: "Member Code", width: 130 },
  { key: "status", label: "Status", width: 90 },
  { key: "deposits", label: "Deposits", width: 110, align: "right", numeric: true },
  { key: "withdrawals", label: "Withdrawals", width: 110, align: "right", numeric: true },
  { key: "lastdep", label: "Last Deposit", width: 110, align: "right" },
  { key: "games", label: "Game Accounts", width: 320 },
];

/**
 * What it takes to create a member — which is not what the list reports about
 * one. Prefix picks the code series, Product and Game Username link the first
 * kiosk login, and the Member Code is derived rather than typed.
 */
const PLAYER_ENTRY_COLUMNS: SheetColumn[] = [
  { key: "name", label: "Name", width: 210, entry: true, required: true, placeholder: "Full name" },
  { key: "prefix", label: "Prefix", width: 90, entry: true, required: true, placeholder: "GA" },
  { key: "code", label: "Member Code", width: 130 },
  { key: "product", label: "Product", width: 130, entry: true, placeholder: "game (optional)" },
  { key: "gameuser", label: "Game Username", width: 170, entry: true, placeholder: "login (optional)" },
];
/**
 * Win/Loss tab. The sign is the house's, as in every report: positive means
 * the house is up on that member. Read-only — nothing here is typed in.
 */
const WINLOSS_COLUMNS: SheetColumn[] = [
  { key: "name", label: "Name", width: 210 },
  { key: "code", label: "Member Code", width: 120 },
  { key: "deposits", label: "Deposits", width: 115, align: "right", numeric: true },
  { key: "bonus", label: "Bonus", width: 105, align: "right", numeric: true },
  { key: "free", label: "Free Credit", width: 110, align: "right", numeric: true },
  { key: "withdrawn", label: "Withdrawn", width: 115, align: "right", numeric: true },
  { key: "net", label: "Net (house)", width: 125, align: "right", numeric: true },
  { key: "lastdep", label: "Last Deposit", width: 110, align: "right" },
];

// Leads tab: 0 Phone · 1 Name · 2 Lead List · 3 Lead Code · 4 Status
const LEAD_COLUMNS: SheetColumn[] = [
  { key: "phone", label: "Phone", width: 160, entry: true, required: true },
  { key: "name", label: "Name", width: 220, entry: true, required: true },
  { key: "list", label: "Lead List", width: 220, entry: true, required: true },
  { key: "code", label: "Lead Code", width: 140 },
  { key: "status", label: "Status", width: 120 },
];

export default function PlayersPage() {
  const players = useStore((s) => s.players);
  const gameCredits = useStore((s) => s.gameCredits);
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const refresh = useStore((s) => s.refresh);
  const companiesFn = useStore((s) => s.companies);
  const companyInScope = useStore((s) => s.companyInScope);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const { openPlayer } = usePlayerProfile();

  const gamesFn = useStore((s) => s.games);
  const games = gamesFn();

  const isViewer = me?.role === "viewer";
  const isLeaderOrAdmin = me?.role === "super_admin" || me?.role === "company_leader";
  const companies = companiesFn();
  const activeCompany = companies.find((c) => c.company_id === selectedCompanyId);

  // The company a new member is created into: a specific one must be in scope.
  // Memoized (depending on the `companies` array, like the other derived memos)
  // so callbacks that use it can still be compiler-optimized.
  const entryCompanyId = useMemo(
    () => selectedCompanyId ?? (companies.length === 1 ? companies[0].company_id : null),
    [selectedCompanyId, companies],
  );
  const canEnterPlayers = !isViewer && entryCompanyId != null;

  const [tab, setTab] = useState<TabKey>("players");
  const [search, setSearch] = useState("");
  // Filter by member-code prefix (Players) / lead list (Leads). "all" = off.
  const [prefixFilter, setPrefixFilter] = useState("all");
  /**
   * How long since a member last deposited. The buckets are the questions CS
   * actually asks — who is active, who is going cold, who has never paid at
   * all — rather than a free date range nobody wants to type.
   */
  /**
   * Typed, not picked from a list of guesses.
   *
   * The presets that were here — 7, 30, 90 — were never the numbers anyone
   * wanted; the whole point of the column is that a house knows its own idea
   * of cold. A direction and a number say all of it: "over 45 days" and
   * "within 3" are both one edit apart.
   */
  const [lastDepDir, setLastDepDir] = useState<"any" | "within" | "over" | "never">("any");
  const [lastDepDays, setLastDepDays] = useState("30");

  /**
   * When each member last deposited. Fetched rather than read from the store:
   * /api/state's roster is cached against players.updated_at, which a deposit
   * does not touch until completion, so this would otherwise show a frozen
   * figure for as long as nothing else edited the member.
   */
  const [lastDepositAt, setLastDepositAt] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let live = true;
    fetch("/api/players/activity")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { activity?: { player_id: number; last_deposit_at: string }[] }) => {
        if (!live) return;
        setLastDepositAt(
          new Map((d.activity ?? []).map((a) => [a.player_id, a.last_deposit_at])),
        );
      })
      .catch(() => {
        // A missing activity map costs the column a dash, nothing more — not
        // worth a toast on a page whose main job is the roster.
      });
    return () => {
      live = false;
    };
  }, []);

  const matchesLastDep = useCallback(
    (iso: string | undefined) => {
      if (lastDepDir === "any") return true;
      if (lastDepDir === "never") return !iso;
      // A half-typed number filters nothing, rather than emptying the table
      // between keystrokes.
      const n = Number(lastDepDays);
      if (!Number.isFinite(n) || lastDepDays.trim() === "") return true;
      // Never deposited is not "a long time ago" — it is a different answer,
      // and lumping it into "over N" would hide it behind a number.
      if (!iso) return false;
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
      return lastDepDir === "within" ? days <= n : days > n;
    },
    [lastDepDir, lastDepDays],
  );

  /**
   * Every kiosk login a member holds, with what is sitting in it.
   *
   * Two accounts on one game is normal here, so the game name alone does not
   * identify the wallet — the balance is shown against the login it belongs to.
   */
  const gameAccountsLabel = useCallback(
    (p: Player) => {
      const accounts = p.game_accounts ?? [];
      if (!accounts.length) return "—";
      return accounts
        .map((a) => {
          const credit = gameCredits.find(
            (c) =>
              c.player_id === p.player_id &&
              c.game_name.toLowerCase() === a.game_name.toLowerCase() &&
              (c.game_username ?? "").toLowerCase() ===
                (a.game_username ?? "").toLowerCase(),
          );
          return `${a.game_name} ${formatRM(credit?.current_balance ?? 0)}`;
        })
        .join(" · ");
    },
    [gameCredits],
  );
  const [listFilter, setListFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [leadsImportOpen, setLeadsImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<(string | number)[]>([]);
  const [commitErrors, setCommitErrors] = useState<Map<string, string>>(() => new Map());
  const [draftsByTab, setDraftsByTab] = useState<Record<TabKey, string[][]>>(() => ({
    players: padDrafts([], PLAYER_ENTRY_COLUMNS.length),
    leads: padDrafts([], LEAD_COLUMNS.length),
    // Win/Loss is a read-only view: no entry row, so no drafts to hold.
    winloss: [],
  }));

  /** The dock's shape — what drafts are padded to and parsed by. */
  const entryColumns = tab === "players" ? PLAYER_ENTRY_COLUMNS : undefined;
  const draftWidth = (entryColumns ?? PLAYER_COLUMNS).length;

  const columns =
    tab === "players"
      ? PLAYER_COLUMNS
      : tab === "winloss"
        ? WINLOSS_COLUMNS
        : LEAD_COLUMNS;
  const drafts = draftsByTab[tab];
  const draftKey = useCallback((d: string[]) => d.join(""), []);

  // ---- Leads-tab data (visible lists + their leads) ----
  const [leadListsData, setLeadListsData] = useState<LeadListRow[]>([]);
  const [leadsData, setLeadsData] = useState<LeadRow[]>([]);
  const loadLeadData = useCallback(async () => {
    if (!isLeaderOrAdmin) return;
    const [a, b] = await Promise.all([
      fetch("/api/lead-lists").then((r) => (r.ok ? r.json() : { lead_lists: [] })),
      fetch("/api/leads").then((r) => (r.ok ? r.json() : { leads: [] })),
    ]);
    setLeadListsData(a.lead_lists ?? []);
    setLeadsData(b.leads ?? []);
  }, [isLeaderOrAdmin]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLeadData();
  }, [loadLeadData]);

  const listByName = useMemo(() => {
    const m = new Map<string, LeadListRow>();
    for (const l of leadListsData) m.set(l.name.trim().toLowerCase(), l);
    return m;
  }, [leadListsData]);


  // ---- Players-tab: phone → lead lists lookup, cached per phone ----
  const [leadCache, setLeadCache] = useState<Map<string, LeadHit[]>>(() => new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const loadLeads = useCallback(
    (phone: string) => {
      const key = phone.trim();
      if (!key || entryCompanyId == null) return;
      if (leadCache.has(key) || inFlight.current.has(key)) return;
      inFlight.current.add(key);
      void fetch(
        `/api/leads/lookup?phone=${encodeURIComponent(key)}&company_entity_id=${entryCompanyId}`,
      )
        .then((r) => (r.ok ? r.json() : { lists: [] }))
        .then((data: { lists?: LeadHit[] }) =>
          setLeadCache((prev) => new Map(prev).set(key, data.lists ?? [])),
        )
        .catch(() => setLeadCache((prev) => new Map(prev).set(key, [])))
        .finally(() => inFlight.current.delete(key));
    },
    [entryCompanyId, leadCache],
  );

  // ---- per-tab enrich (fill derived cells as CS types) ----
  // Left for the Leads sheet, which still fills a name from a picked phone.
  /**
   * Every member code already in this casino, grouped by its letter prefix,
   * so a new one can continue the right series.
   *
   * The letters are matched exactly: "G" and "GA" are different series, and
   * treating GA2283 as a G-code would hand the next member G2284 — a number
   * three thousand short of where that series actually is.
   */
  const codeSeries = useMemo(() => {
    const series = new Map<string, { next: number; width: number }>();
    for (const p of players) {
      if (entryCompanyId !== null && p.company_entity_id !== entryCompanyId) continue;
      const m = /^([A-Za-z]+)(\d+)$/.exec(p.username.trim());
      if (!m) continue;
      const [, letters, digits] = m;
      const key = letters.toUpperCase();
      const at = series.get(key) ?? { next: 0, width: digits.length };
      at.next = Math.max(at.next, Number(digits) + 1);
      at.width = Math.max(at.width, digits.length);
      series.set(key, at);
    }
    return series;
  }, [players, entryCompanyId]);

  const prefixSuggestions = useMemo<SheetSuggestion[]>(
    () =>
      [...codeSeries.entries()]
        .sort((a, b) => b[1].next - a[1].next)
        .map(([prefix, at]) => ({
          value: prefix,
          hint: `next ${prefix}${String(at.next).padStart(at.width, "0")}`,
        })),
    [codeSeries],
  );

  /**
   * Fill each entry row's Member Code from its prefix.
   *
   * Counted per prefix across the rows being typed, so adding five members at
   * once gives five consecutive codes rather than five copies of the same one.
   * A prefix nobody has used yet starts at 1, padded to four digits — the
   * width every series in the data uses.
   */
  const enrichPlayers = useCallback(
    (_prev: string[][], next: string[][]): string[][] => {
      const used = new Map<string, number>();
      return next.map((row) => {
        const out = [...row];
        const prefix = (out[1] ?? "").trim().toUpperCase();
        if (!prefix) {
          out[2] = "";
          return out;
        }
        const series = codeSeries.get(prefix);
        const base = series?.next ?? 1;
        const offset = used.get(prefix) ?? 0;
        used.set(prefix, offset + 1);
        const width = series?.width ?? 4;
        out[2] = `${prefix}${String(base + offset).padStart(width, "0")}`;
        return out;
      });
    },
    [codeSeries],
  );

  /** Leads tab: the next code its list will issue, shown before saving. */
  const enrichLeads = useCallback(
    (next: string[][]): string[][] =>
      next.map((row) => {
        const out = [...row];
        const list = listByName.get(out[2]?.trim().toLowerCase() ?? "");
        out[3] = list ? fmtSeq(list.prefix, list.next_seq) : "";
        return out;
      }),
    [listByName],
  );

  const onDraftsChange = useCallback(
    (next: string[][]) =>
      setDraftsByTab((prev) => {
        const processed =
          tab === "players" ? enrichPlayers(prev.players, next) : enrichLeads(next);
        return { ...prev, [tab]: padDrafts(processed, draftWidth) };
      }),
    [tab, draftWidth, enrichPlayers, enrichLeads],
  );

  // ---- committed rows ----
  const matches = useCallback(
    (cells: string[]) => {
      const q = search.trim().toLowerCase();
      return !q || cells.some((c) => c.toLowerCase().includes(q));
    },
    [search],
  );

  const memberRows = useMemo<SheetRow[]>(() => {
    return players
      .filter((p) => companyInScope(p.company_entity_id))
      .filter((p) => prefixFilter === "all" || prefixOfCode(p.username) === prefixFilter)
      .filter((p) => matchesLastDep(lastDepositAt.get(p.player_id)))
      .sort((a, b) => a.registration_date.localeCompare(b.registration_date))
      .map<SheetRow>((p) => ({
        id: p.player_id,
        tone: p.status === "suspended" ? "muted" : "default",
        cells: [
          p.full_name,
          p.username,
          p.status === "suspended" ? "Suspended" : "Active",
          formatRM(p.total_deposits),
          formatRM(p.total_withdrawals),
          sinceLabel(lastDepositAt.get(p.player_id)),
          gameAccountsLabel(p),
        ],
      }))
      .filter((r) => matches(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, selectedCompanyId, selectedLeaderId, companyInScope, matches, prefixFilter, lastDepositAt, gameAccountsLabel, matchesLastDep]);

  const leadRows = useMemo<SheetRow[]>(
    () =>
      leadsData
        .filter((l) => listFilter === "all" || l.list_name === listFilter)
        .map<SheetRow>((l) => ({
          id: l.lead_id,
          tone: l.is_member ? "success" : "default",
          cells: [
            maskPhone(l.phone),
            l.name,
            l.list_name,
            l.lead_code,
            l.is_member ? "Member" : "Lead",
          ],
        }))
        .filter((r) => matches(r.cells)),
    [leadsData, matches, listFilter],
  );

  /**
   * Per-member win/loss, fetched when the tab is first opened.
   *
   * Not part of the roster for the same reason last-deposit is not: it changes
   * with every deposit and withdrawal, and /api/state's player payload is
   * cached against players.updated_at.
   */
  const [winLoss, setWinLoss] = useState<WinLossRow[]>([]);
  // Blank is all time. Not defaulted to this month: a company whose data was
  // imported for an earlier period would open the tab on an empty table.
  const [wlFrom, setWlFrom] = useState("");
  const [wlTo, setWlTo] = useState("");

  const wlUrl = useMemo(() => {
    const sp = new URLSearchParams();
    if (wlFrom) sp.set("from", wlFrom);
    if (wlTo) sp.set("to", wlTo);
    const qs = sp.toString();
    return `/api/players/win-loss${qs ? `?${qs}` : ""}`;
  }, [wlFrom, wlTo]);

  // "The range I have" vs "the range I want" — a derived gap, so changing a
  // date refetches without an effect having to set a loading flag first.
  const [wlLoaded, setWlLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "winloss" || wlLoaded === wlUrl) return;
    let live = true;
    fetch(wlUrl)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { win_loss?: WinLossRow[] }) => {
        if (!live) return;
        setWinLoss(d.win_loss ?? []);
        setWlLoaded(wlUrl);
      })
      .catch(() => {
        if (!live) return;
        setWlLoaded(wlUrl); // marked answered, or it retries forever
        toast.error("Could not load win/loss");
      });
    return () => {
      live = false;
    };
  }, [tab, wlUrl, wlLoaded]);

  const winLossRows = useMemo<SheetRow[]>(() => {
    const byId = new Map(players.map((p) => [p.player_id, p]));
    return winLoss
      .map((w) => ({ w, p: byId.get(w.player_id) }))
      .filter((x): x is { w: WinLossRow; p: Player } => !!x.p)
      .filter((x) => companyInScope(x.p.company_entity_id))
      // The row's own last deposit, which is the one inside the chosen range —
      // not the roster's all-time figure the Players tab uses.
      .filter((x) => matchesLastDep(x.w.last_deposit_at ?? undefined))
      // Biggest house win first, so the members worth knowing about are at the
      // top and the ones bleeding the house are at the bottom.
      .sort((a, b) => b.w.net - a.w.net)
      .map<SheetRow>(({ w, p }) => ({
        id: p.player_id,
        tone: w.net < 0 ? "muted" : "default",
        cells: [
          p.full_name,
          p.username,
          formatRM(w.money_in),
          formatRM(w.bonus + w.recommend),
          formatRM(w.free_credit),
          formatRM(w.money_out),
          formatRM(w.net),
          sinceLabel(w.last_deposit_at ?? undefined),
        ],
      }))
      .filter((r) => matches(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winLoss, players, companyInScope, matches, matchesLastDep, selectedCompanyId, selectedLeaderId]);

  const rows =
    tab === "players" ? memberRows : tab === "winloss" ? winLossRows : leadRows;

  // ---- entry-row typeahead ----
  const draftSuggestions = useCallback(
    (draftIndex: number, colIndex: number): SheetSuggestion[] | undefined => {
      // The Prefix cell offers the series this casino already runs, each
      // showing the code it would issue next.
      if (tab === "players" && colIndex === 1) {
        return prefixSuggestions.length ? prefixSuggestions : undefined;
      }
      if (tab === "players" && colIndex === 3) {
        return games.length ? games.map((g) => ({ value: g })) : undefined;
      }

      // Leads only: the Phone cell there is the lead's identity, so it still
      // autocompletes. The Players sheet has no phone cell to fill.
      if (tab === "leads" && colIndex === 0) {
        if (!leadsData.length) return undefined; // no leads loaded — type freely
        const typed = (drafts[draftIndex]?.[0] ?? "").trim().toLowerCase();
        const matched = leadsData
          .filter((l) => (l.phone ?? "").trim())
          .filter(
            (l) =>
              !typed ||
              (l.phone ?? "").toLowerCase().includes(typed) ||
              l.name.toLowerCase().includes(typed),
          )
          .slice(0, 12);
        if (!matched.length) return undefined;
        return matched.map<SheetSuggestion>((l) => ({
          value: l.phone ?? "",
          title: l.phone ?? "",
          badge: l.list_name,
          detail: l.is_member ? `${l.name} · already a member` : l.name,
          detailTone: l.is_member ? "warning" : "default",
          figure: l.lead_code,
        }));
      }

      if (colIndex !== 2) return undefined; // the Lead List cell in both tabs

      if (tab === "leads") {
        if (leadListsData.length === 0) {
          return [{ value: "", title: "No lead lists yet — create one first", disabled: true }];
        }
        return leadListsData.map<SheetSuggestion>((l) => ({
          value: l.name,
          title: l.name,
          badge: l.prefix,
          detail: l.owner_leader_name ? `${l.owner_leader_name} · ${l.lead_count ?? 0} leads` : undefined,
          figure: fmtSeq(l.prefix, l.next_seq),
        }));
      }

      // players tab — the phone's own lists
      const phone = drafts[draftIndex]?.[0]?.trim() ?? "";
      if (!phone) {
        return [
          {
            value: "",
            title: "Enter the phone number first",
            detail: "Its lead lists show up here once a phone is typed",
            detailTone: "warning",
            disabled: true,
          },
        ];
      }
      const hits = leadCache.get(phone);
      if (hits === undefined)
        return [{ value: "", title: "Looking up lead lists…", disabled: true }];
      if (hits.length === 0) {
        return [
          {
            value: "",
            title: "This phone isn't in any lead list",
            detail: "Use Create Player for a walk-in with no list",
            detailTone: "warning",
            disabled: true,
          },
        ];
      }
      return hits.map<SheetSuggestion>((h) => ({
        value: h.name,
        title: h.name,
        badge: h.dist_id != null ? (h.prefix ?? "") : "new here",
        detail:
          h.dist_id != null ? `Prefix ${h.prefix} — locked` : "First here — you set the prefix",
        figure: h.dist_id != null ? (h.next_code ?? undefined) : undefined,
      }));
    },
    [tab, drafts, leadCache, leadListsData, leadsData, prefixSuggestions, games],
  );

  const handleEditStart = useCallback(
    (rowIndex: number, colIndex: number) => {
      if (tab !== "players" || colIndex < 1 || rowIndex < rows.length) return;
      const phone = drafts[rowIndex - rows.length]?.[0]?.trim();
      if (phone) loadLeads(phone);
    },
    [tab, rows.length, drafts, loadLeads],
  );

  // ---- validation ----
  const draftStatus = useCallback(
    (d: string[]): DraftStatus => {
      if (d.every((v) => !v.trim())) return { state: "empty" };
      const rejected = commitErrors.get(draftKey(d));
      if (rejected) return { state: "error", message: rejected };
      /**
       * The two tabs have different columns, and this only ever described the
       * Leads one — so on Players it read Name as the phone, Member Code as
       * the name, and Status as the lead list, and demanded a value in a cell
       * the sheet fills in itself. No new member could ever be saved.
       *
       * Players: 0 Name · 1 Member Code · 2 Status · 3 Deposits · 4 Withdrawals
       * · 5 Last Deposit · 6 Game Accounts — everything from Status on is
       * derived, so only the first two are asked for.
       */
      if (tab === "players") {
        const [name, prefix, code] = d;
        if (!name.trim()) return { state: "error", message: "Name is required" };
        if (!prefix.trim())
          return { state: "error", message: "Pick a prefix — the member code follows from it" };
        if (!code.trim())
          return { state: "error", message: `No code could be built from "${prefix.trim()}"` };
        const [, , , product, login] = d;
        if (product?.trim() && !login?.trim())
          return { state: "error", message: `Give the ${product.trim()} login, or clear the product` };
        if (login?.trim() && !product?.trim())
          return { state: "error", message: "Pick the product that login belongs to" };
        return { state: "ready" };
      }

      const [phone, name, list, prefix] = d;
      if (!phone.trim()) return { state: "error", message: "Phone is required" };
      if (!name.trim()) return { state: "error", message: "Name is required" };
      if (!list.trim()) return { state: "error", message: "Pick a lead list" };

      if (tab === "leads") {
        if (!listByName.has(list.trim().toLowerCase()))
          return { state: "error", message: `"${list.trim()}" isn't one of your lead lists` };
        return { state: "ready" };
      }

      const hits = leadCache.get(phone.trim());
      if (hits === undefined)
        return { state: "error", message: "Looking up the phone's lead lists…" };
      const hit = hits.find((h) => h.name.toLowerCase() === list.trim().toLowerCase());
      if (!hit)
        return { state: "error", message: `"${list.trim()}" isn't a lead list for this phone` };
      if (hit.dist_id == null && !prefix.trim())
        return { state: "error", message: "Set a prefix for this list's members here" };
      return { state: "ready" };
    },
    [tab, commitErrors, draftKey, leadCache, listByName],
  );

  const readyCount = useMemo(
    () => drafts.filter((d) => draftStatus(d).state === "ready").length,
    [drafts, draftStatus],
  );

  // ---- commit ----
  const handleCommit = useCallback(async () => {
    // Only the Players tab has entry rows to commit — leads come in by import.
    if (saving || tab !== "players") return;
    if (!canEnterPlayers || entryCompanyId == null) return;
    const jobs = drafts
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => draftStatus(d).state === "ready");
    if (!jobs.length) {
      toast.info("No ready rows to save — fix the rows marked ! first.");
      return;
    }
    setSaving(true);
    const succeeded = new Set<number>();
    const failures = new Map<string, string>(commitErrors);

    for (const { d, i } of jobs) {
      // The two sheets no longer share a column order: Players is
      // Name · Code, Leads is still Phone · Name · List.

      let ok = false;
      let error = "Save failed";
      try {
        if (tab === "players") {
          /**
           * Typed straight in, with the member code the operator already uses.
           *
           * This used to go through /api/players/from-lead, which needed a lead
           * list to take the code from. Companies that do not buy lists — the
           * imported ones type their own codes — had no way to add a member
           * here at all. Lists are still how leads convert; that path lives on
           * the Lead Lists page, where the list is the subject.
           */
          const res = await fetch("/api/players", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              company_entity_id: entryCompanyId,
              username: (d[2] ?? "").trim(),
              full_name: (d[0] ?? "").trim(),
              ...((d[3] ?? "").trim() && (d[4] ?? "").trim()
                ? {
                    game_accounts: [
                      { game_name: (d[3] ?? "").trim(), game_username: (d[4] ?? "").trim() },
                    ],
                  }
                : {}),
            }),
          });
          ok = res.ok;
          if (!ok) error = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
        } else {
          const listRow = listByName.get((d[2] ?? "").trim().toLowerCase());
          if (!listRow) {
            failures.set(draftKey(d), "Lead list not found");
            continue;
          }
          const res = await fetch(`/api/lead-lists/${listRow.list_id}/leads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contact_number: (d[0] ?? "").trim(),
              full_name: (d[1] ?? "").trim(),
            }),
          });
          ok = res.ok;
          if (!ok) error = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
        }
      } catch {
        error = "Network error";
      }
      if (ok) {
        succeeded.add(i);
        failures.delete(draftKey(d));
      } else {
        failures.set(draftKey(d), error);
      }
    }

    const remaining = drafts.filter((_, i) => !succeeded.has(i));
    setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(remaining, draftWidth) }));
    setCommitErrors(failures);
    // Counters moved, so cached lookups/previews are stale.
    setLeadCache(new Map());
    setSaving(false);
    await Promise.all([refresh(), loadLeadData()]);

    const failed = jobs.length - succeeded.size;
    const noun = tab === "players" ? "member" : "lead";
    if (failed) {
      toast.error(
        `${succeeded.size} saved, ${failed} rejected — rejected rows stay below with the reason on the ! marker.`,
      );
    } else {
      toast.success(`${succeeded.size} ${noun}${succeeded.size === 1 ? "" : "s"} added`);
    }
  }, [
    saving, tab, canEnterPlayers, entryCompanyId, drafts, draftStatus,
    commitErrors, draftKey, listByName, draftWidth, refresh, loadLeadData,
  ]);

  // ---- selection → player modal ----
  const selectedPlayerId = useMemo(
    () =>
      // Win/Loss rows are keyed by player too, so ⌘↵ opens the profile from
      // there as well — the tab exists to find a member worth looking at, and
      // stopping at the number would leave the reader nowhere to go.
      (tab === "players" || tab === "winloss") && selectedIds.length === 1
        ? Number(selectedIds[0])
        : null,
    [tab, selectedIds],
  );
  const handleViewPlayer = useCallback(() => {
    if (selectedPlayerId) openPlayer(selectedPlayerId);
  }, [selectedPlayerId, openPlayer]);
  /**
   * ⌘G — straight from the selected member to their game accounts, with the
   * "link a game" form already open. Linking a kiosk login is the edit CS
   * makes most, and it was four clicks deep behind the profile modal.
   */
  const handleGameAccounts = useCallback(() => {
    if (selectedPlayerId) {
      openPlayer(selectedPlayerId, { section: "games", addForm: true });
    }
  }, [selectedPlayerId, openPlayer]);

  // ⌘↵ opens the player; Esc clears — capture phase so the grid never sees them.
  useEffect(() => {
    if (!selectedIds.length) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIds([]);
        return;
      }
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || e.altKey || e.shiftKey) return;
      if (k === "enter" && selectedPlayerId) {
        e.preventDefault();
        e.stopPropagation();
        handleViewPlayer();
      }
      if (k === "g" && selectedPlayerId) {
        e.preventDefault();
        e.stopPropagation();
        handleGameAccounts();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedIds.length, selectedPlayerId, handleViewPlayer, handleGameAccounts]);

  // Shift+⌘/Ctrl+←/→ switches between the Players and Leads tabs, wrapping —
  // the same worksheet-tab gesture as the Transactions sheet.
  useEffect(() => {
    const keys: TabKey[] = isLeaderOrAdmin
      ? ["players", "winloss", "leads"]
      : ["players", "winloss"];
    if (keys.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || !e.shiftKey || e.altKey) return;
      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      setTab((cur) => keys[(keys.indexOf(cur) + dir + keys.length) % keys.length]);
      setSelectedIds([]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isLeaderOrAdmin]);

  // ⌘S saves the current tab's ready rows from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const wrongMod = IS_MAC ? e.ctrlKey : e.metaKey;
      if (!mod || wrongMod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      void handleCommit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [handleCommit]);

  // Players has entry rows; Leads is read-only — leads arrive by import.
  const playersReadOnly = !canEnterPlayers;
  const canImportLeads = isLeaderOrAdmin;
  const inScopeTotal = players.filter((p) => companyInScope(p.company_entity_id)).length;

  // Filter dropdown options — member-code prefixes in scope, and lead-list names.
  const prefixOptions = useMemo(() => {
    const s = new Set<string>();
    for (const p of players) {
      if (!companyInScope(p.company_entity_id)) continue;
      const pfx = prefixOfCode(p.username);
      if (pfx) s.add(pfx);
    }
    return [...s].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, selectedCompanyId, selectedLeaderId, companyInScope]);
  const listOptions = useMemo(
    () => [...new Set(leadsData.map((l) => l.list_name))].sort(),
    [leadsData],
  );

  const tabs: { key: TabKey; label: string }[] = [
    { key: "players", label: "Players" },
    { key: "winloss", label: "Win / Loss" },
    ...(isLeaderOrAdmin ? [{ key: "leads" as const, label: "Leads" }] : []),
  ];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Worksheet tabs — Excel style, same as Transactions. */}
      <div className="flex shrink-0 items-end gap-0.5 border-b border-border bg-muted/40 px-2 pt-1.5">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setSelectedIds([]); // ids don't cross tabs
            }}
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
          {tab === "players"
            ? "Entry: Name · Member Code — add a walk-in for anything more"
            : tab === "winloss"
              ? "Positive is the house up on that member, negative is the member up. Select a row and press ⌘↵ to open their profile."
              : "Leads come in by import — use the Import button, then convert them on the Players tab"}
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div>
          <p className="text-[11px] text-muted-foreground">
            {tab === "players" ? (
              activeCompany ? (
                <>
                  {inScopeTotal} members in{" "}
                  <span className="font-medium text-foreground">
                    {activeCompany.company_name}
                  </span>
                </>
              ) : (
                <>{inScopeTotal} members across {companies.length} companies</>
              )
            ) : (
              <>{leadsData.length} leads across {leadListsData.length} lists</>
            )}
          </p>
        </div>

        <div className="relative ml-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-page-search
            title="Press ⌘F / Ctrl+F (or /) to jump here"
            placeholder={
              tab === "players"
                ? "Search name or code…"
                : tab === "winloss"
                  ? "Search name or code…"
                  : "Search leads…"
            }
            className="h-8 w-56 pl-7 text-[13px]"
          />
        </div>
        {tab === "players" && prefixOptions.length > 0 && (
          <Select value={prefixFilter} onValueChange={(v) => setPrefixFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-36 cursor-pointer text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prefixes</SelectItem>
              {prefixOptions.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {tab === "winloss" && (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              value={wlFrom}
              onChange={(e) => setWlFrom(e.target.value)}
              className="h-8 w-[140px] text-[13px]"
              title="From — blank for all time"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="date"
              value={wlTo}
              onChange={(e) => setWlTo(e.target.value)}
              className="h-8 w-[140px] text-[13px]"
              title="To — blank for all time"
            />
            {(wlFrom || wlTo) && (
              <button
                type="button"
                onClick={() => {
                  setWlFrom("");
                  setWlTo("");
                }}
                className="cursor-pointer rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                All time
              </button>
            )}
          </div>
        )}
        {(tab === "players" || tab === "winloss") && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Last deposit</span>
            <Select
              value={lastDepDir}
              onValueChange={(v) =>
                setLastDepDir((v as typeof lastDepDir) ?? "any")
              }
            >
              <SelectTrigger className="h-8 w-[104px] cursor-pointer text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">any</SelectItem>
                <SelectItem value="within">within</SelectItem>
                <SelectItem value="over">over</SelectItem>
                <SelectItem value="never">never</SelectItem>
              </SelectContent>
            </Select>
            {(lastDepDir === "within" || lastDepDir === "over") && (
              <>
                <Input
                  type="number"
                  min={0}
                  value={lastDepDays}
                  onChange={(e) => setLastDepDays(e.target.value)}
                  className="h-8 w-16 text-[13px]"
                />
                <span className="text-[11px] text-muted-foreground">
                  days ago
                </span>
              </>
            )}
          </div>
        )}
        {tab === "leads" && listOptions.length > 0 && (
          <Select value={listFilter} onValueChange={(v) => setListFilter(v ?? "all")}>
            <SelectTrigger className="h-8 w-44 cursor-pointer text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All lead lists</SelectItem>
              {listOptions.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-xs text-muted-foreground">
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {tab === "players" && !isViewer && (
            <>
              <Button
                onClick={() => setImportOpen(true)}
                variant="outline"
                size="sm"
                className="h-8 cursor-pointer gap-1.5"
              >
                <Upload className="h-3.5 w-3.5" />
                Import
              </Button>
              <Button
                onClick={() => setCreateOpen(true)}
                variant="outline"
                size="sm"
                className="h-8 cursor-pointer gap-1.5"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Walk-in
              </Button>
            </>
          )}
          {tab === "leads" && canImportLeads && (
            <>
              <Button
                onClick={() => setShareOpen(true)}
                variant="outline"
                size="sm"
                className="h-8 cursor-pointer gap-1.5"
              >
                <Share2 className="h-3.5 w-3.5" />
                Share list
              </Button>
              <Button
                onClick={() => setLeadsImportOpen(true)}
                size="sm"
                className="h-8 cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
              >
                <Upload className="h-3.5 w-3.5" />
                Import leads
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 cursor-pointer gap-1.5"
            onClick={async () => {
              setRefreshing(true);
              await Promise.all([refresh(), loadLeadData()]);
              setRefreshing(false);
            }}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
          {tab === "players" && !playersReadOnly && (
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

      {/* When no single company is in scope, member entry has no target. */}
      {tab === "players" && !isViewer && entryCompanyId == null && (
        <div className="shrink-0 border-b border-amber-500/40 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          Pick a company in the top bar to add members here — the roster below spans all your companies.
        </div>
      )}

      <SheetGrid
        key={tab}
        columns={columns}
        rows={rows}
        drafts={drafts}
        onDraftsChange={onDraftsChange}
        draftStatus={draftStatus}
        onCommit={handleCommit}
        readOnly={tab !== "players" || playersReadOnly}
        onSelectedRowsChange={setSelectedIds}
        draftSuggestions={draftSuggestions}
        // A new member needs a name and a series; status, deposits,
        // withdrawals, last deposit and game accounts are all things they
        // won't have until they exist.
        entryColumns={entryColumns}
        onEditStart={handleEditStart}
        focusKey={`${tab}:${hydrated}`}
      />

      {/* Floating action bar — member rows only. ⌘↵ opens the player, ⌘G their game accounts. */}
      {tab === "players" && selectedIds.length > 0 && (
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
            {selectedPlayerId ? (
              <Button
                size="xs"
                variant="outline"
                onClick={handleViewPlayer}
                title="Open the player's details"
                className="cursor-pointer gap-1"
              >
                <User className="h-3 w-3" />
                Player
                <Kbd k={`${MOD_LABEL}↵`} />
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Select a single member to open their details
              </span>
            )}
            {selectedPlayerId && (
              <Button
                size="xs"
                variant="outline"
                onClick={handleGameAccounts}
                title="Link or update a game account"
                className="cursor-pointer gap-1"
              >
                <Gamepad2 className="h-3 w-3" />
                Game acct
                <Kbd k={`${MOD_LABEL}G`} />
              </Button>
            )}
          </div>
        </div>
      )}

      <ImportPlayersModal open={importOpen} onOpenChange={setImportOpen} />
      <ImportLeadsModal
        open={leadsImportOpen}
        onOpenChange={setLeadsImportOpen}
        lists={leadListsData.map((l) => ({
          list_id: l.list_id,
          name: l.name,
          prefix: l.prefix,
        }))}
        onImported={loadLeadData}
      />
      <ShareListModal
        open={shareOpen}
        onOpenChange={setShareOpen}
        lists={leadListsData.map((l) => ({
          list_id: l.list_id,
          name: l.name,
          prefix: l.prefix,
        }))}
        companies={companies.map((c) => ({ id: c.company_id, name: c.company_name }))}
        onShared={loadLeadData}
      />
      <CreatePlayerModal open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

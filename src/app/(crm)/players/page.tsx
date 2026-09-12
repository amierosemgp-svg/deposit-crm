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
import { formatRM } from "@/lib/format";
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

type TabKey = "players" | "leads";

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

// Players tab: 0 Phone · 1 Name · 2 Lead List · 3 Prefix · 4 Code · 5 Status · 6 Dep · 7 Wd
const PLAYER_COLUMNS: SheetColumn[] = [
  { key: "phone", label: "Phone", width: 150, entry: true, required: true, placeholder: "0191234567" },
  { key: "name", label: "Name", width: 190, entry: true, required: true, placeholder: "Full name" },
  { key: "list", label: "Lead List", width: 190, entry: true, required: true, placeholder: "pick lead list" },
  { key: "prefix", label: "Prefix", width: 90, entry: true, placeholder: "auto" },
  { key: "code", label: "Member Code", width: 130 },
  { key: "status", label: "Status", width: 100 },
  { key: "deposits", label: "Deposits", width: 120, align: "right", numeric: true },
  { key: "withdrawals", label: "Withdrawals", width: 120, align: "right", numeric: true },
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
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const refresh = useStore((s) => s.refresh);
  const companiesFn = useStore((s) => s.companies);
  const companyInScope = useStore((s) => s.companyInScope);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const { openPlayer } = usePlayerProfile();

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
    players: padDrafts([], PLAYER_COLUMNS.length),
    leads: padDrafts([], LEAD_COLUMNS.length),
  }));

  const columns = tab === "players" ? PLAYER_COLUMNS : LEAD_COLUMNS;
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

  // A lead's name by phone — for filling the Name cell when CS picks a phone.
  const leadNameByPhone = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of leadsData) {
      const p = (l.phone ?? "").trim().toLowerCase();
      if (p && !m.has(p)) m.set(p, l.name);
    }
    return m;
  }, [leadsData]);

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
  const hitFor = useCallback(
    (phone: string, listName: string): LeadHit | undefined =>
      leadCache
        .get(phone.trim())
        ?.find((h) => h.name.toLowerCase() === listName.trim().toLowerCase()),
    [leadCache],
  );

  // ---- per-tab enrich (fill derived cells as CS types) ----
  const enrichPlayers = useCallback(
    (prev: string[][], next: string[][]): string[][] =>
      next.map((row, i) => {
        const out = [...row];
        const phone = out[0]?.trim() ?? "";
        if (phone !== (prev[i]?.[0]?.trim() ?? "")) {
          out[2] = "";
          out[3] = "";
          out[4] = "";
          // Picked (or typed) a known lead phone — carry its name over.
          const leadName = leadNameByPhone.get(phone.toLowerCase());
          if (leadName && !out[1]?.trim()) out[1] = leadName;
          return out;
        }
        const listName = out[2]?.trim() ?? "";
        if (!listName) {
          out[4] = "";
          return out;
        }
        const hit = hitFor(phone, listName);
        if (hit && hit.dist_id != null) {
          out[3] = hit.prefix ?? ""; // fixed — a member already came from this list here
          out[4] = hit.next_code ?? "";
        } else {
          const pfx = out[3]?.trim() ?? "";
          out[4] = pfx ? fmtSeq(pfx, 1) : "";
        }
        return out;
      }),
    [hitFor, leadNameByPhone],
  );

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
        return { ...prev, [tab]: padDrafts(processed, columns.length) };
      }),
    [tab, columns.length, enrichPlayers, enrichLeads],
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
      .sort((a, b) => a.registration_date.localeCompare(b.registration_date))
      .map<SheetRow>((p) => ({
        id: p.player_id,
        tone: p.status === "suspended" ? "muted" : "default",
        cells: [
          p.contact_number ?? "",
          p.full_name,
          "—",
          prefixOfCode(p.username),
          p.username,
          p.status === "suspended" ? "Suspended" : "Active",
          formatRM(p.total_deposits),
          formatRM(p.total_withdrawals),
        ],
      }))
      .filter((r) => matches(r.cells));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, selectedCompanyId, selectedLeaderId, companyInScope, matches, prefixFilter]);

  const leadRows = useMemo<SheetRow[]>(
    () =>
      leadsData
        .filter((l) => listFilter === "all" || l.list_name === listFilter)
        .map<SheetRow>((l) => ({
          id: l.lead_id,
          tone: l.is_member ? "success" : "default",
          cells: [
            l.phone ?? "",
            l.name,
            l.list_name,
            l.lead_code,
            l.is_member ? "Member" : "Lead",
          ],
        }))
        .filter((r) => matches(r.cells)),
    [leadsData, matches, listFilter],
  );

  const rows = tab === "players" ? memberRows : leadRows;

  // ---- entry-row typeahead ----
  const draftSuggestions = useCallback(
    (draftIndex: number, colIndex: number): SheetSuggestion[] | undefined => {
      // Players tab: autocomplete the Phone cell from the leads, so CS picks a
      // lead by phone instead of retyping it.
      if (tab === "players" && colIndex === 0) {
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
    [tab, drafts, leadCache, leadListsData, leadsData],
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
      const [phone, name, list, prefix] = d;
      let ok = false;
      let error = "Save failed";
      try {
        if (tab === "players") {
          const hit = hitFor(phone, list);
          if (!hit) {
            failures.set(draftKey(d), "Lead list no longer matches this phone");
            continue;
          }
          const res = await fetch("/api/players/from-lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              company_entity_id: entryCompanyId,
              contact_number: phone.trim(),
              full_name: name.trim(),
              lead_list_id: hit.list_id,
              ...(hit.dist_id == null ? { prefix: prefix.trim() } : {}),
            }),
          });
          ok = res.ok;
          if (!ok) error = (await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`;
        } else {
          const listRow = listByName.get(list.trim().toLowerCase());
          if (!listRow) {
            failures.set(draftKey(d), "Lead list not found");
            continue;
          }
          const res = await fetch(`/api/lead-lists/${listRow.list_id}/leads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_number: phone.trim(), full_name: name.trim() }),
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
    setDraftsByTab((prev) => ({ ...prev, [tab]: padDrafts(remaining, columns.length) }));
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
    commitErrors, hitFor, draftKey, listByName, columns.length, refresh, loadLeadData,
  ]);

  // ---- selection → player modal ----
  const selectedPlayerId = useMemo(
    () => (tab === "players" && selectedIds.length === 1 ? Number(selectedIds[0]) : null),
    [tab, selectedIds],
  );
  const handleViewPlayer = useCallback(() => {
    if (selectedPlayerId) openPlayer(selectedPlayerId);
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
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedIds.length, selectedPlayerId, handleViewPlayer]);

  // Shift+⌘/Ctrl+←/→ switches between the Players and Leads tabs, wrapping —
  // the same worksheet-tab gesture as the Transactions sheet.
  useEffect(() => {
    const keys: TabKey[] = isLeaderOrAdmin ? ["players", "leads"] : ["players"];
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
            ? "Entry: Phone · Name · Lead List — prefix & member code fill themselves"
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
            placeholder={tab === "players" ? "Search name, code, phone…" : "Search leads…"}
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
        readOnly={tab === "leads" || playersReadOnly}
        onSelectedRowsChange={setSelectedIds}
        draftSuggestions={draftSuggestions}
        onEditStart={handleEditStart}
        focusKey={`${tab}:${hydrated}`}
      />

      {/* Floating action bar — member rows only. ⌘↵ opens the player. */}
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

"use client";

/**
 * Leader Transfers — settlements moving funds from one leader to another.
 *
 * Deliberately its own surface, separate from Expenses: a leader-to-leader
 * movement is not a cost leaving the business, so it gets its own ledger, its
 * own audit type (leader_transfer), and the net-flow summary below. Super-admin
 * only — leaders sit at the top of the tree.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Loader2, Plus, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStore } from "@/lib/store";
import { formatRM, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type LeaderTransfer = {
  transfer_id: number;
  from_leader_entity_id: number;
  to_leader_entity_id: number;
  amount: number;
  note: string | null;
  created_by_user_id: number;
  created_at: string;
};

export default function LeaderTransfersPage() {
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const userName = useStore((s) => s.userName);

  const leaders = useMemo(
    () => entities.filter((e) => e.entity_type === "leader" && e.status === "active"),
    [entities],
  );

  const [rows, setRows] = useState<LeaderTransfer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/leader-transfers");
      if (!res.ok) return;
      const data = (await res.json()) as { leader_transfers?: LeaderTransfer[] };
      setRows(data.leader_transfers ?? []);
    } catch {
      // transient
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    // Fetch-on-mount; setState after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Per-leader net flow — the report: sent, received, and net for each leader.
  const summary = useMemo(() => {
    const m = new Map<number, { sent: number; received: number }>();
    for (const l of leaders) m.set(l.entity_id, { sent: 0, received: 0 });
    for (const r of rows) {
      const f = m.get(r.from_leader_entity_id) ?? { sent: 0, received: 0 };
      f.sent += r.amount;
      m.set(r.from_leader_entity_id, f);
      const t = m.get(r.to_leader_entity_id) ?? { sent: 0, received: 0 };
      t.received += r.amount;
      m.set(r.to_leader_entity_id, t);
    }
    return [...m.entries()].map(([id, v]) => ({
      id,
      name: entityName(id),
      sent: v.sent,
      received: v.received,
      net: v.received - v.sent,
    }));
  }, [rows, leaders, entityName]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        entityName(r.from_leader_entity_id).toLowerCase().includes(q) ||
        entityName(r.to_leader_entity_id).toLowerCase().includes(q) ||
        (r.note ?? "").toLowerCase().includes(q),
    );
  }, [rows, search, entityName]);

  const total = useMemo(() => rows.reduce((a, r) => a + r.amount, 0), [rows]);

  if (me && me.role !== "super_admin") {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground">
        Leader transfers are visible to administrators only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leader Transfers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Settlements between leaders — kept separate from expenses.
          </p>
        </div>
        <Button
          onClick={() => setOpen(true)}
          disabled={leaders.length < 2}
          className="cursor-pointer gap-1.5"
        >
          <Plus className="h-4 w-4" />
          New transfer
        </Button>
      </div>

      {/* Report: per-leader net flow. */}
      <div>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Net flow per leader
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {summary.map((s) => (
            <Card key={s.id} size="sm" className="gap-1.5 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{s.name}</span>
                <span
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    s.net > 0 && "text-emerald-600 dark:text-emerald-400",
                    s.net < 0 && "text-red-600 dark:text-red-400",
                  )}
                >
                  {s.net > 0 ? "+" : ""}
                  {formatRM(s.net)}
                </span>
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>Received {formatRM(s.received)}</span>
                <span>Sent {formatRM(s.sent)}</span>
              </div>
            </Card>
          ))}
          {summary.length === 0 && (
            <p className="text-sm text-muted-foreground">No leaders yet.</p>
          )}
        </div>
      </div>

      {/* Ledger. */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <span className="text-sm font-semibold">
            History{" "}
            <span className="font-normal text-muted-foreground">
              · {rows.length} transfer{rows.length === 1 ? "" : "s"} · {formatRM(total)} total
            </span>
          </span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search leader or note…"
              className="h-8 w-56 pl-7 text-[13px]"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Note</th>
                <th className="px-4 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.transfer_id} className="border-b border-border/60 last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {formatDateTime(r.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {entityName(r.from_leader_entity_id)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      {entityName(r.to_leader_entity_id)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">
                    {formatRM(r.amount)}
                  </td>
                  <td className="max-w-[280px] truncate px-4 py-2 text-muted-foreground">
                    {r.note ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {userName(r.created_by_user_id)}
                  </td>
                </tr>
              ))}
              {loaded && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {rows.length === 0
                      ? "No leader transfers yet."
                      : "No transfers match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {open && (
        <NewTransferDialog
          leaders={leaders.map((l) => ({ id: l.entity_id, name: l.name }))}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NewTransferDialog({
  leaders,
  onClose,
  onDone,
}: {
  leaders: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const amt = Number(amount.replace(/[,\s]/g, ""));
  const valid = from && to && from !== to && Number.isFinite(amt) && amt > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/leader-transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_leader_entity_id: Number(from),
          to_leader_entity_id: Number(to),
          amount: amt,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(d?.error ?? "Failed to record transfer");
        return;
      }
      toast.success("Leader transfer recorded");
      onDone();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>New leader transfer</DialogTitle>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From leader</Label>
              <Select value={from || null} onValueChange={(v) => setFrom(v ?? "")}>
                <SelectTrigger className="h-9 w-full cursor-pointer">
                  <SelectValue placeholder="Sender" />
                </SelectTrigger>
                <SelectContent>
                  {leaders.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)} disabled={String(l.id) === to}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>To leader</Label>
              <Select value={to || null} onValueChange={(v) => setTo(v ?? "")}>
                <SelectTrigger className="h-9 w-full cursor-pointer">
                  <SelectValue placeholder="Recipient" />
                </SelectTrigger>
                <SelectContent>
                  {leaders.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)} disabled={String(l.id) === from}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Amount (RM)</Label>
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What the settlement is for"
              className="h-9"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} className="cursor-pointer">
              Cancel
            </Button>
            <Button onClick={submit} disabled={!valid || busy} className="cursor-pointer gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Record transfer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

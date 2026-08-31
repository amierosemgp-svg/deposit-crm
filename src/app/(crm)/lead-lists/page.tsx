"use client";

/**
 * Lead Lists — the lists a leader buys, and how each company converts them.
 *
 * A list (list_A) is a batch of leads with its own code prefix. A leader hands
 * it to companies; each converted lead becomes a member with the company's own
 * auto-incrementing code. The conversion rate here is converted ÷ leads.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Layers, Loader2, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";

type Dist = {
  dist_id: number;
  to_name: string;
  prefix: string;
  converted: number;
  conversion_rate: number;
};
type LeadList = {
  list_id: number;
  name: string;
  prefix: string;
  owner_leader_name: string;
  lead_count: number;
  distributions: Dist[];
};

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

export default function LeadListsPage() {
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const leaders = useMemo(
    () => entities.filter((e) => e.entity_type === "leader" && e.status === "active"),
    [entities],
  );

  const [lists, setLists] = useState<LeadList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/lead-lists");
      if (!res.ok) return;
      const data = (await res.json()) as { lead_lists?: LeadList[] };
      setLists(data.lead_lists ?? []);
    } catch {
      /* retry next mount */
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (me && me.role !== "super_admin" && me.role !== "company_leader") {
    return (
      <div className="py-24 text-center text-sm text-muted-foreground">
        Lead lists are visible to leaders and administrators.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Lead Lists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Lists a leader buys, distributed to companies &mdash; with live conversion.
          </p>
        </div>
        <Button
          onClick={() => setOpen(true)}
          disabled={leaders.length === 0}
          className="cursor-pointer gap-1.5"
        >
          <Plus className="h-4 w-4" />
          New list
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {lists.map((l) => (
          <Card key={l.list_id} className="p-0">
            <Link
              href={`/lead-lists/${l.list_id}`}
              className="block cursor-pointer p-4 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate font-semibold">{l.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {l.prefix}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {l.owner_leader_name} &middot; {l.lead_count} lead
                    {l.lead_count === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              {l.distributions.length > 0 && (
                <div className="mt-3 space-y-1.5 border-t border-border pt-3">
                  {l.distributions.map((d) => (
                    <div key={d.dist_id} className="flex items-center gap-3 text-[13px]">
                      <span className="min-w-0 flex-1 truncate">
                        {d.to_name}
                        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                          {d.prefix}
                        </span>
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {d.converted}/{l.lead_count}
                      </span>
                      <span
                        className={cn(
                          "w-10 text-right font-semibold tabular-nums",
                          d.conversion_rate >= 0.5
                            ? "text-emerald-600 dark:text-emerald-400"
                            : d.conversion_rate > 0
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground",
                        )}
                      >
                        {pct(d.conversion_rate)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Link>
          </Card>
        ))}
        {loaded && lists.length === 0 && (
          <p className="text-sm text-muted-foreground">No lead lists yet.</p>
        )}
      </div>

      {open && (
        <NewListDialog
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

function NewListDialog({
  leaders,
  onClose,
  onDone,
}: {
  leaders: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [owner, setOwner] = useState(leaders[0] ? String(leaders[0].id) : "");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = owner && name.trim() && prefix.trim();

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/lead-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_leader_entity_id: Number(owner),
          name: name.trim(),
          prefix: prefix.trim(),
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(d?.error ?? "Failed to create list");
        return;
      }
      toast.success("Lead list created");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>New lead list</DialogTitle>
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label>Owner leader</Label>
            <Select value={owner || null} onValueChange={(v) => setOwner(v ?? "")}>
              <SelectTrigger className="h-9 w-full cursor-pointer">
                <SelectValue placeholder="Leader" />
              </SelectTrigger>
              <SelectContent>
                {leaders.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label>List name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="June batch" className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label>Code prefix</Label>
              <Input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                placeholder="A"
                className="h-9 font-mono"
              />
            </div>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Leads get codes like <span className="font-mono">{(prefix || "A")}0001</span>, auto-numbered.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} className="cursor-pointer">
              Cancel
            </Button>
            <Button onClick={submit} disabled={!valid || busy} className="cursor-pointer gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

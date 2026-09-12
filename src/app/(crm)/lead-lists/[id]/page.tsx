"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Plus, UserPlus } from "lucide-react";
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

type Conversion = { member_code: string; company: string; dist_id: number };
type Lead = {
  lead_id: number;
  person_id: number;
  lead_code: string;
  full_name: string;
  contact_number: string | null;
  conversions: Conversion[];
};
type Dist = {
  dist_id: number;
  to_entity_id: number;
  to_name: string;
  prefix: string;
  converted: number;
  conversion_rate: number;
};
type Detail = {
  lead_list: { list_id: number; name: string; prefix: string; owner_leader_name: string };
  leads: Lead[];
  distributions: Dist[];
};

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

export default function LeadListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const companies = useStore((s) => s.companies)();
  const [data, setData] = useState<Detail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [addLeadOpen, setAddLeadOpen] = useState(false);
  const [distOpen, setDistOpen] = useState(false);
  const [converting, setConverting] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/lead-lists/${id}`);
      if (!res.ok) return;
      setData((await res.json()) as Detail);
    } finally {
      setLoaded(true);
    }
  }, [id]);
  useEffect(() => {
     
    void load();
  }, [load]);

  // Distributions that point at a company (leaders can't be converted into).
  const companyDists = useMemo(
    () =>
      (data?.distributions ?? []).filter((d) =>
        companies.some((c) => c.company_id === d.to_entity_id),
      ),
    [data, companies],
  );

  async function convert(personId: number, distId: number) {
    setConverting(personId);
    try {
      const res = await fetch(`/api/lead-lists/${id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dist_id: distId, person_id: personId }),
      });
      const body = (await res.json().catch(() => null)) as { member?: { username: string }; error?: string } | null;
      if (!res.ok) {
        toast.error(body?.error ?? "Failed to convert");
        return;
      }
      toast.success(`Converted → ${body?.member?.username ?? "member"}`);
      void load();
    } finally {
      setConverting(null);
    }
  }

  if (!loaded) {
    return <div className="py-24 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!data) {
    return <div className="py-24 text-center text-sm text-muted-foreground">List not found.</div>;
  }

  const total = data.leads.length;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/lead-lists"
          className="inline-flex cursor-pointer items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Lead lists
        </Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              {data.lead_list.name}
              <span className="rounded bg-muted px-2 py-0.5 font-mono text-sm text-muted-foreground">
                {data.lead_list.prefix}
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.lead_list.owner_leader_name} &middot; {total} lead{total === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDistOpen(true)} className="cursor-pointer gap-1.5">
              <Plus className="h-4 w-4" />
              Distribute
            </Button>
            <Button onClick={() => setAddLeadOpen(true)} className="cursor-pointer gap-1.5">
              <UserPlus className="h-4 w-4" />
              Add lead
            </Button>
          </div>
        </div>
      </div>

      {/* Distributions + conversion. */}
      {data.distributions.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.distributions.map((d) => (
            <Card key={d.dist_id} size="sm" className="gap-1 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="truncate text-sm font-medium">{d.to_name}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {d.prefix}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] text-muted-foreground tabular-nums">
                  {d.converted}/{total} converted
                </span>
                <span
                  className={cn(
                    "text-lg font-semibold tabular-nums",
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
            </Card>
          ))}
        </div>
      )}

      {/* Leads. */}
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">
          Leads
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Lead code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Phone</th>
                <th className="px-4 py-2 font-medium">Converted to</th>
                <th className="px-4 py-2 text-right font-medium">Convert</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map((lead) => {
                const openDists = companyDists.filter(
                  (d) => !lead.conversions.some((c) => c.dist_id === d.dist_id),
                );
                return (
                  <tr key={lead.lead_id} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-[13px]">{lead.lead_code}</td>
                    <td className="px-4 py-2">{lead.full_name}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                      {lead.contact_number ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      {lead.conversions.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1.5">
                          {lead.conversions.map((c) => (
                            <span
                              key={c.dist_id}
                              className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300"
                            >
                              <span className="font-mono">{c.member_code}</span>
                              <span className="opacity-70">{c.company}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {openDists.length === 0 ? (
                        <span className="text-[12px] text-muted-foreground">
                          {companyDists.length === 0 ? "distribute first" : "all done"}
                        </span>
                      ) : openDists.length === 1 ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={converting === lead.person_id}
                          onClick={() => convert(lead.person_id, openDists[0].dist_id)}
                          className="cursor-pointer"
                        >
                          {converting === lead.person_id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            `→ ${openDists[0].to_name}`
                          )}
                        </Button>
                      ) : (
                        <Select
                          value={null}
                          onValueChange={(v) => v && convert(lead.person_id, Number(v))}
                        >
                          <SelectTrigger className="ml-auto h-7 w-[150px] cursor-pointer text-[12px]">
                            <SelectValue placeholder="Convert to…" />
                          </SelectTrigger>
                          <SelectContent>
                            {openDists.map((d) => (
                              <SelectItem key={d.dist_id} value={String(d.dist_id)}>
                                {d.to_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                  </tr>
                );
              })}
              {data.leads.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No leads yet — add the first one.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {addLeadOpen && (
        <AddLeadDialog listId={id} onClose={() => setAddLeadOpen(false)} onDone={() => { setAddLeadOpen(false); void load(); }} />
      )}
      {distOpen && (
        <DistributeDialog
          listId={id}
          companies={companies.map((c) => ({ id: c.company_id, name: c.company_name }))}
          existing={data.distributions.map((d) => d.to_entity_id)}
          onClose={() => setDistOpen(false)}
          onDone={() => { setDistOpen(false); void load(); }}
        />
      )}
    </div>
  );
}

function AddLeadDialog({ listId, onClose, onDone }: { listId: string; onClose: () => void; onDone: () => void }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = phone.trim().length >= 3 && name.trim();
  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lead-lists/${listId}/leads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_number: phone.trim(), full_name: name.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { duplicate?: boolean; error?: string } | null;
      if (!res.ok) { toast.error(body?.error ?? "Failed"); return; }
      toast.success(body?.duplicate ? "Already in this list" : "Lead added");
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Add lead</DialogTitle>
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label>Phone number</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0123456789" className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="h-9" />
          </div>
          <p className="text-[12px] text-muted-foreground">
            One phone = one person. If this number is already known, it links to the same person.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} className="cursor-pointer">Cancel</Button>
            <Button onClick={submit} disabled={!valid || busy} className="cursor-pointer gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DistributeDialog({
  listId,
  companies,
  existing,
  onClose,
  onDone,
}: {
  listId: string;
  companies: { id: number; name: string }[];
  existing: number[];
  onClose: () => void;
  onDone: () => void;
}) {
  const options = companies.filter((c) => !existing.includes(c.id));
  const [to, setTo] = useState(options[0] ? String(options[0].id) : "");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = to && prefix.trim();
  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lead-lists/${listId}/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_entity_id: Number(to), prefix: prefix.trim() }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.error(d?.error ?? "Failed"); return;
      }
      toast.success("List distributed");
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Distribute to a company</DialogTitle>
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select value={to || null} onValueChange={(v) => setTo(v ?? "")}>
              <SelectTrigger className="h-9 w-full cursor-pointer">
                <SelectValue placeholder="Company" />
              </SelectTrigger>
              <SelectContent>
                {options.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Their code prefix</Label>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              placeholder="AZ"
              className="h-9 font-mono"
            />
            <p className="text-[12px] text-muted-foreground">
              Converted members get codes like <span className="font-mono">{(prefix || "AZ")}0001</span>.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} className="cursor-pointer">Cancel</Button>
            <Button onClick={submit} disabled={!valid || busy} className="cursor-pointer gap-1.5">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Distribute
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

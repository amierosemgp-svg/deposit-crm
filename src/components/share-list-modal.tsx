"use client";

import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Share2 } from "lucide-react";

type LeadListOption = { list_id: number; name: string; prefix: string };
type CompanyOption = { id: number; name: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: LeadListOption[];
  companies: CompanyOption[];
  onShared?: () => void;
};

/**
 * Share (distribute) a lead list to a company: the company gets its own
 * member-code prefix and counter, so when it converts a lead from the list the
 * code auto-numbers under that prefix. Re-sharing updates the prefix.
 */
export function ShareListModal({ open, onOpenChange, lists, companies, onShared }: Props) {
  const [listId, setListId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);

  const targetList = lists.find((l) => String(l.list_id) === listId);
  const targetCompany = companies.find((c) => String(c.id) === companyId);
  const code = useMemo(
    () => (prefix.trim() ? `${prefix.trim()}0001` : "—"),
    [prefix],
  );

  function reset() {
    setListId("");
    setCompanyId("");
    setPrefix("");
  }

  async function handleShare() {
    if (!targetList || !targetCompany || !prefix.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lead-lists/${targetList.list_id}/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_entity_id: targetCompany.id, prefix: prefix.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? `Share failed (HTTP ${res.status})`);
      } else {
        toast.success(
          `${targetList.name} shared with ${targetCompany.name} — new members code ${prefix.trim()}0001…`,
        );
        onShared?.();
        reset();
        onOpenChange(false);
      }
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Share lead list</DialogTitle>

        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-700 dark:text-emerald-400">
            <Share2 className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Share a lead list</h2>
            <p className="text-[11px] text-muted-foreground">
              Give a company the list to work — it gets its own member-code prefix
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-muted-foreground">
              Lead list
            </label>
            <Select value={listId} onValueChange={(v) => setListId(v ?? "")}>
              <SelectTrigger className="h-8 w-full text-[13px]">
                <SelectValue placeholder="Which list to share" />
              </SelectTrigger>
              <SelectContent>
                {lists.map((l) => (
                  <SelectItem key={l.list_id} value={String(l.list_id)}>
                    {l.name} ({l.prefix})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-muted-foreground">
              Share with company
            </label>
            <Select value={companyId} onValueChange={(v) => setCompanyId(v ?? "")}>
              <SelectTrigger className="h-8 w-full text-[13px]">
                <SelectValue placeholder="Which company gets it" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-muted-foreground">
              Member-code prefix for this company
            </label>
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="e.g. AZ"
              className="h-8 text-[13px] uppercase"
              maxLength={16}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Converted members will be coded{" "}
              <span className="font-medium text-foreground">{code}</span>, and up.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="cursor-pointer gap-1.5 bg-emerald-700 text-white hover:bg-emerald-800"
            disabled={!targetList || !targetCompany || !prefix.trim() || busy}
            onClick={handleShare}
          >
            <Share2 className="h-3.5 w-3.5" />
            {busy ? "Sharing…" : "Share list"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

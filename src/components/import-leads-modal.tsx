"use client";

import { useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Upload, Users } from "lucide-react";

type LeadListOption = { list_id: number; name: string; prefix: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: LeadListOption[];
  onImported?: () => void;
};

type ParsedRow = {
  line: number;
  phone: string;
  name: string;
  telegram?: string;
  error?: string;
};

/**
 * Split a pasted/CSV block into lead rows. One lead per line:
 * phone, name[, telegram]. Commas or tabs separate columns; a header line
 * naming "phone" is dropped.
 */
function parseLeads(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: ParsedRow[] = [];
  lines.forEach((raw, i) => {
    if (!raw) return;
    const cols = raw.split(/[\t,]/).map((c) => c.trim());
    if (i === 0 && /phone|contact|number/i.test(cols[0]) && /name/i.test(cols[1] ?? "")) {
      return; // header row
    }
    const [phone, name, telegram] = cols;
    if (!phone || !name) {
      out.push({ line: i + 1, phone: phone ?? "", name: name ?? "", error: "Needs phone and name" });
      return;
    }
    if (phone.replace(/\D/g, "").length < 3) {
      out.push({ line: i + 1, phone, name, error: "Phone looks invalid" });
      return;
    }
    out.push({ line: i + 1, phone, name, telegram: telegram || undefined });
  });
  return out;
}

export function ImportLeadsModal({ open, onOpenChange, lists, onImported }: Props) {
  const [listId, setListId] = useState("");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseLeads(text), [text]);
  const valid = parsed.filter((r) => !r.error);
  const errors = parsed.filter((r) => r.error);
  const targetList = lists.find((l) => String(l.list_id) === listId);

  function reset() {
    setText("");
    setFileName(null);
    setListId("");
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setFileName(file.name);
    };
    reader.readAsText(file);
  }

  async function handleImport() {
    if (!targetList || !valid.length || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lead-lists/${targetList.list_id}/leads/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: valid.map((r) => ({
            contact_number: r.phone,
            full_name: r.name,
            ...(r.telegram ? { telegram_username: r.telegram } : {}),
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(data?.error ?? `Import failed (HTTP ${res.status})`);
      } else {
        const { added, skipped } = data as { added: number; skipped: number };
        toast.success(
          `${added} lead${added === 1 ? "" : "s"} added to ${targetList.name}` +
            (skipped ? ` · ${skipped} skipped (already leads)` : ""),
        );
        onImported?.();
        reset();
        onOpenChange(false);
      }
    } catch {
      toast.error("Network error during import");
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
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Import leads</DialogTitle>

        <div className="flex items-center gap-2 border-b px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-700 dark:text-emerald-400">
            <Users className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Import leads</h2>
            <p className="text-[11px] text-muted-foreground">
              Paste from your sheet — one lead per line: phone, name, Telegram (optional)
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="mb-1 block text-[12px] font-medium text-muted-foreground">
              Add to lead list
            </label>
            <Select value={listId} onValueChange={(v) => setListId(v ?? "")}>
              <SelectTrigger className="h-8 w-full text-[13px]">
                <SelectValue placeholder="Choose the list these leads belong to" />
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

          <div className="flex items-center justify-between">
            <label className="text-[12px] font-medium text-muted-foreground">
              Leads
            </label>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-emerald-700 hover:underline dark:text-emerald-400"
            >
              <Upload className="h-3 w-3" />
              {fileName ?? "Upload CSV"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"0191234567, Ali bin Ahmad\n0197654321, Siti, @sitihandle"}
            className="h-40 w-full resize-none rounded-md border border-input bg-background p-2.5 font-mono text-[12px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />

          {parsed.length > 0 && (
            <div className="flex items-center gap-3 text-[12px]">
              <span className="font-medium text-emerald-700 dark:text-emerald-400">
                {valid.length} ready
              </span>
              {errors.length > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                  {errors.length} skipped —{" "}
                  {errors
                    .slice(0, 2)
                    .map((e) => `line ${e.line}: ${e.error}`)
                    .join("; ")}
                  {errors.length > 2 ? "…" : ""}
                </span>
              )}
            </div>
          )}
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
            disabled={!targetList || valid.length === 0 || busy}
            onClick={handleImport}
          >
            <Upload className="h-3.5 w-3.5" />
            {busy
              ? "Importing…"
              : `Import ${valid.length || ""} lead${valid.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

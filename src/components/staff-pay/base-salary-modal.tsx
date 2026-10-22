"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Wallet } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import { send, type StaffRow } from "./use-staff-pay";

/**
 * Each CS's monthly base salary — the one figure their pay starts from (it
 * replaced the tier ladder). Applies to every month not yet paid.
 */
export function BaseSalaryModal({
  open,
  onOpenChange,
  staff,
  canManage,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  staff: StaffRow[];
  canManage: boolean;
  onDone: () => void;
}) {
  const entityName = useStore((s) => s.entityName);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  // Start from the saved figures each time it opens.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts(Object.fromEntries(staff.map((s) => [s.user_id, s.base_set ? String(s.base) : ""])));
  }, [open, staff]);

  const list = staff
    .filter((s) => s.status === "active")
    .sort((a, b) => entityName(a.company_entity_id).localeCompare(entityName(b.company_entity_id)) || a.full_name.localeCompare(b.full_name));

  const save = async (s: StaffRow) => {
    const raw = (drafts[s.user_id] ?? "").trim();
    const amount = Number(raw);
    if (!raw || !Number.isFinite(amount) || amount < 0) return void toast.error("Base salary — a figure of 0 or more");
    setBusy(s.user_id);
    const res = await send("/api/staff-pay/base", "PUT", { user_id: s.user_id, amount });
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success(`${s.full_name}: base RM ${amount.toFixed(2)}`);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          Base salaries
        </DialogTitle>
        <DialogDescription>
          What a month pays before days off. 4 days off a month are free; each one after costs RM 100 if the
          leader was told, RM 200 if not. Each unused free day pays RM 100, and a month with no day off pays RM 500.
        </DialogDescription>
        <div className="max-h-[55vh] overflow-y-auto rounded-md border">
          {list.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No CS in your casinos.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">CS</th>
                  <th className="px-3 py-1.5 text-left font-medium">Casino</th>
                  <th className="px-3 py-1.5 text-right font-medium">Base (RM)</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const draft = drafts[s.user_id] ?? "";
                  const dirty = draft.trim() !== (s.base_set ? String(s.base) : "");
                  return (
                    <tr key={s.user_id} className="border-b last:border-0">
                      <td className="px-3 py-1.5">{s.full_name}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{entityName(s.company_entity_id)}</td>
                      <td className="px-2 py-1">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={draft}
                          placeholder="not set"
                          disabled={!canManage}
                          onChange={(e) => setDrafts((d) => ({ ...d, [s.user_id]: e.target.value }))}
                          onKeyDown={(e) => e.key === "Enter" && dirty && void save(s)}
                          className="h-8 text-right tabular-nums"
                        />
                      </td>
                      <td className="px-2 py-1">
                        {canManage && (
                          <Button
                            size="sm"
                            variant={dirty ? "default" : "outline"}
                            className="h-8 cursor-pointer px-2"
                            disabled={!dirty || busy === s.user_id}
                            onClick={() => void save(s)}
                          >
                            {busy === s.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

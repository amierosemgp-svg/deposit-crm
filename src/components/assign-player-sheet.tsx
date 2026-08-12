"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, UserCheck, UserPlus, Users } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreatePlayerModal } from "@/components/create-player-modal";
import { useStore } from "@/lib/store";
import { extractSenderName } from "@/lib/bank-remark";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Player } from "@/lib/types";

type Props = {
  depositIds: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned?: (depositIds: number[]) => void;
};

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function playerHaystack(p: Player): string {
  return [
    p.full_name,
    p.username,
    p.telegram_username,
    p.contact_number,
    p.wechat_id,
    ...(p.bank_accounts ?? []).flatMap((b) => [
      b.account_holder,
      b.account_number,
      b.bank_name,
    ]),
    ...(p.game_accounts ?? []).map((g) => g.game_username),
  ]
    .map(norm)
    .join(" ");
}

export function AssignPlayerSheet({
  depositIds,
  open,
  onOpenChange,
  onAssigned,
}: Props) {
  const players = useStore((s) => s.players);
  const deposits = useStore((s) => s.deposits);
  const updateDraft = useStore((s) => s.updateDepositDraft);

  const [query, setQuery] = useState("");
  const [assigningId, setAssigningId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setQuery("");
        setAssigningId(null);
      }, 200);
      return () => clearTimeout(t);
    }
  }, [open]);

  const targets = useMemo(
    () => deposits.filter((d) => depositIds.includes(d.deposit_id)),
    [deposits, depositIds],
  );
  const single = targets.length === 1 ? targets[0] : null;

  // Bank-holder names on the target deposits — used to float likely matches up.
  const targetHolders = useMemo(
    () =>
      new Set(
        targets
          .map((d) => norm(d.bank_account_holder))
          .filter((h) => h.length > 0),
      ),
    [targets],
  );

  const suggestedIds = useMemo(
    () =>
      new Set(
        targetHolders.size === 0
          ? []
          : players
              .filter(
                (p) =>
                  (p.bank_accounts ?? []).some((b) =>
                    targetHolders.has(norm(b.account_holder)),
                  ) || targetHolders.has(norm(p.full_name)),
              )
              .map((p) => p.player_id),
      ),
    [players, targetHolders],
  );

  // Seed the create-player form from the deposit: the bank holder is almost
  // always the player, and the deposit's bank account enables auto-matching.
  const createPrefill = useMemo(() => {
    const src = targets[0];
    if (!src) return undefined;
    const holder = (src.bank_account_holder ?? "").trim();
    return {
      full_name: holder || query.trim(),
      company_entity_id: src.company_entity_id ?? undefined,
      bank_accounts: src.bank_account_number
        ? [
            {
              bank_name: src.bank_name,
              account_number: src.bank_account_number,
              account_holder: holder,
            },
          ]
        : undefined,
    };
  }, [targets, query]);

  const results = useMemo(() => {
    const q = norm(query);
    const matched =
      q === ""
        ? players
        : players.filter((p) => playerHaystack(p).includes(q));
    return [...matched].sort((a, b) => {
      const sa = suggestedIds.has(a.player_id) ? 1 : 0;
      const sb = suggestedIds.has(b.player_id) ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return a.full_name.localeCompare(b.full_name);
    });
  }, [players, query, suggestedIds]);

  async function handleAssign(player: Player) {
    if (assigningId !== null || targets.length === 0) return;
    setAssigningId(player.player_id);
    const outcomes = await Promise.all(
      targets.map((d) => updateDraft(d.deposit_id, { player_id: player.player_id })),
    );
    setAssigningId(null);
    const failed = outcomes.filter((r) => !r.ok).length;
    const succeeded = targets.length - failed;
    if (succeeded > 0) {
      toast.success(
        targets.length === 1
          ? `Assigned to ${player.full_name}`
          : `Assigned ${succeeded} deposit${succeeded === 1 ? "" : "s"} to ${player.full_name}`,
      );
      onAssigned?.(targets.map((d) => d.deposit_id));
    }
    if (failed > 0) {
      toast.error(
        `${failed} deposit${failed === 1 ? "" : "s"} could not be assigned`,
      );
    }
    if (failed === 0) onOpenChange(false);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Assign player
          </SheetTitle>
          <SheetDescription>
            {single ? (
              <>
                {formatRM(single.deposit_amount)} · {single.bank_name}
                {extractSenderName(single.bank_description) && (
                  <span className="mt-0.5 block truncate font-medium text-foreground">
                    Sender: {extractSenderName(single.bank_description)}
                  </span>
                )}
                {single.bank_description && (
                  <span className="mt-0.5 block truncate italic">
                    {single.bank_description}
                  </span>
                )}
              </>
            ) : (
              <>Applies to {targets.length} selected deposits</>
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex gap-2 border-b p-4">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, member code, phone, bank account…"
              className="pl-8"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => setCreateOpen(true)}
            className="shrink-0 cursor-pointer"
          >
            <UserPlus className="h-3.5 w-3.5" />
            New player
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {results.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <Users className="h-7 w-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {players.length === 0
                  ? "No players yet."
                  : `No players match “${query}”.`}
              </p>
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="mt-1 cursor-pointer"
              >
                <UserPlus className="h-3.5 w-3.5" />
                {query.trim()
                  ? `Create player “${query.trim()}”`
                  : "Create new player"}
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {results.map((p) => {
                const suggested = suggestedIds.has(p.player_id);
                const busy = assigningId === p.player_id;
                return (
                  <li key={p.player_id}>
                    <button
                      type="button"
                      onClick={() => void handleAssign(p)}
                      disabled={assigningId !== null || p.status === "suspended"}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50",
                        suggested && "bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-50",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                          suggested
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        {p.full_name
                          .split(" ")
                          .slice(0, 2)
                          .map((w) => w[0])
                          .join("")
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {p.full_name}
                          </span>
                          {suggested && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                              <UserCheck className="h-3 w-3" />
                              Bank match
                            </span>
                          )}
                          {p.status === "suspended" && (
                            <span className="inline-flex shrink-0 items-center rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                              Suspended
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          @{p.username}{p.telegram_username ? ` · ${p.telegram_username}` : ""}
                          {p.bank_accounts?.[0] &&
                            ` · ${p.bank_accounts[0].bank_name} ${p.bank_accounts[0].account_number}`}
                        </span>
                      </span>
                      {busy && (
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
          {results.length} player{results.length === 1 ? "" : "s"}
          {targetHolders.size > 0 && " · bank-holder matches shown first"}
        </div>
      </SheetContent>
      </Sheet>

      <CreatePlayerModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        prefill={createPrefill}
        onCreated={(p) => void handleAssign(p)}
      />
    </>
  );
}

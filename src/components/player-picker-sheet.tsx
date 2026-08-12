"use client";

import { useMemo, useState } from "react";
import { Search, UserPlus, Users } from "lucide-react";
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
import type { Player } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (player: Player) => void;
  /** Restrict the list; defaults to all players in scope. */
  players?: Player[];
  title?: string;
  description?: string;
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

export function PlayerPickerSheet({
  open,
  onOpenChange,
  onSelect,
  players,
  title = "Select player",
  description,
}: Props) {
  const allPlayers = useStore((s) => s.players);
  const source = players ?? allPlayers;

  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // Clear the search when the sheet closes (state-during-render reset).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setQuery("");
  }

  const results = useMemo(() => {
    const q = norm(query);
    const matched =
      q === "" ? source : source.filter((p) => playerHaystack(p).includes(q));
    return [...matched].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [source, query]);

  function pick(p: Player) {
    if (p.status === "suspended") return;
    onSelect(p);
    onOpenChange(false);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
          <SheetHeader className="border-b pb-4">
            <SheetTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              {title}
            </SheetTitle>
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>

          <div className="flex gap-2 border-b p-4">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, username, phone, bank account…"
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
                  {source.length === 0
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
                {results.map((p) => (
                  <li key={p.player_id}>
                    <button
                      type="button"
                      onClick={() => pick(p)}
                      disabled={p.status === "suspended"}
                      className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
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
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground">
            {results.length} player{results.length === 1 ? "" : "s"}
          </div>
        </SheetContent>
      </Sheet>

      <CreatePlayerModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(p) => pick(p)}
      />
    </>
  );
}

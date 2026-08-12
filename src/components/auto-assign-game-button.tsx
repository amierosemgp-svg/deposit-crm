"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { LOW_GAME_ACCOUNT_STOCK } from "@/lib/types";
import { SearchableSelect } from "@/components/searchable-select";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

/**
 * Hand a player one of the accounts the agent registered ahead of time.
 *
 * Games the player already has are left out — a second account for the same
 * game would split their balance across two ids. Games with nothing left in the
 * pool are left out too, since picking one could only fail; the stock warning
 * below is what tells someone to have the agent register more.
 */
export function AutoAssignGameButton({ playerId }: { playerId: number }) {
  const [busy, setBusy] = useState(false);
  const playerById = useStore((s) => s.playerById);
  const stock = useStore((s) => s.gameAccountStock);
  const autoAssign = useStore((s) => s.autoAssignGameAccount);

  const player = playerById(playerId);
  const linked = new Set((player?.game_accounts ?? []).map((g) => g.game_name));

  const assignable = stock
    .filter((s) => s.available > 0 && !linked.has(s.game_name))
    .map((s) => s.game_name)
    .sort((a, b) => a.localeCompare(b));

  const low = stock.filter(
    (s) => s.available > 0 && s.available <= LOW_GAME_ACCOUNT_STOCK,
  );
  const dry = stock.filter((s) => s.available === 0);

  async function assign(gameName: string) {
    if (busy) return;
    setBusy(true);
    const res = await autoAssign(playerId, gameName);
    setBusy(false);
    if (res.ok) toast.success(`${gameName} account assigned from the pool`);
    else toast.error(res.error ?? "Could not assign an account");
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {assignable.length > 0 ? (
          <SearchableSelect
            value={null}
            onValueChange={(g) => void assign(g)}
            options={assignable}
            placeholder={busy ? "Assigning…" : "Auto-assign game"}
            searchPlaceholder="Search game…"
            disabled={busy}
            className="h-8 w-[190px] text-[12px]"
          />
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled
            className="h-8 cursor-not-allowed text-[12px]"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {stock.length === 0
              ? "Pool is empty"
              : "No pooled game left to assign"}
          </Button>
        )}
      </div>

      {(low.length > 0 || dry.length > 0) && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {dry.length > 0 && (
            <>Out of stock: {dry.map((s) => s.game_name).join(", ")}. </>
          )}
          {low.length > 0 && (
            <>
              Running low:{" "}
              {low.map((s) => `${s.game_name} (${s.available})`).join(", ")}.{" "}
            </>
          )}
          The agent needs to register more accounts.
        </p>
      )}
    </div>
  );
}

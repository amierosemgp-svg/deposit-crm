"use client";

import { useEffect, useMemo } from "react";
import { useStore } from "@/lib/store";

/**
 * Make sure the members a screen names are loaded.
 *
 * The roster is no longer shipped with the app state — at twelve thousand
 * members it was 8 MB on almost every poll — so a page holding rows that carry
 * a `player_id` has the id but not the member. Hand those ids here and the
 * store fetches the ones it has not seen; `playerById` then answers for them.
 *
 * Safe to call with a list that changes every render: the ids are sorted into
 * a stable key, and ids already held cost nothing.
 */
export function useHydratePlayers(ids: (number | null | undefined)[]): void {
  const hydratePlayers = useStore((s) => s.hydratePlayers);
  const key = useMemo(
    () =>
      [...new Set(ids.filter((id): id is number => typeof id === "number" && id > 0))]
        .sort((a, b) => a - b)
        .join(","),
    [ids],
  );
  useEffect(() => {
    if (!key) return;
    void hydratePlayers(key.split(",").map(Number));
  }, [key, hydratePlayers]);
}

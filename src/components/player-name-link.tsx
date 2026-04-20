"use client";

import { useState, createContext, useContext, useCallback } from "react";
import { PlayerProfileSheet } from "./player-profile-sheet";

type Ctx = { openPlayer: (id: number) => void };
const PlayerProfileCtx = createContext<Ctx | null>(null);

export function PlayerProfileProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const openPlayer = useCallback((id: number) => {
    setPlayerId(id);
    setOpen(true);
  }, []);
  return (
    <PlayerProfileCtx.Provider value={{ openPlayer }}>
      {children}
      <PlayerProfileSheet
        playerId={playerId}
        open={open}
        onOpenChange={setOpen}
      />
    </PlayerProfileCtx.Provider>
  );
}

export function usePlayerProfile() {
  const ctx = useContext(PlayerProfileCtx);
  if (!ctx) throw new Error("usePlayerProfile must be inside PlayerProfileProvider");
  return ctx;
}

export function PlayerNameLink({
  playerId,
  children,
  className,
}: {
  playerId: number;
  children: React.ReactNode;
  className?: string;
}) {
  const { openPlayer } = usePlayerProfile();
  return (
    <button
      onClick={() => openPlayer(playerId)}
      className={
        className ??
        "text-left font-medium text-primary hover:underline decoration-primary/40 underline-offset-2"
      }
    >
      {children}
    </button>
  );
}

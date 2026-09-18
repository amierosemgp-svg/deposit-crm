"use client";

import { useState, createContext, useContext, useCallback } from "react";
import { PlayerProfileModal, type PlayerSection } from "./player-profile-modal";

/**
 * Where to land in the profile. Omitted = Profile, the way a name click has
 * always behaved; `section` jumps straight to a tab and `addForm` opens that
 * tab's add-form, so a shortcut can go from a selected row to a ready form.
 */
export type OpenPlayerOptions = {
  section?: PlayerSection;
  addForm?: boolean;
};

type Ctx = { openPlayer: (id: number, options?: OpenPlayerOptions) => void };
const PlayerProfileCtx = createContext<Ctx | null>(null);

export function PlayerProfileProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<OpenPlayerOptions>({});
  const openPlayer = useCallback((id: number, options?: OpenPlayerOptions) => {
    setPlayerId(id);
    setTarget(options ?? {});
    setOpen(true);
  }, []);
  return (
    <PlayerProfileCtx.Provider value={{ openPlayer }}>
      {children}
      <PlayerProfileModal
        playerId={playerId}
        open={open}
        onOpenChange={setOpen}
        initialSection={target.section}
        openAddForm={target.addForm}
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
        "cursor-pointer text-left font-medium text-primary hover:underline decoration-primary/40 underline-offset-2"
      }
    >
      {children}
    </button>
  );
}

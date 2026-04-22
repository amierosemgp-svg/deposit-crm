"use client";

import { create } from "zustand";
import type {
  Deposit,
  GameCredit,
  GameName,
  GameTransfer,
  Player,
  Withdrawal,
} from "./types";
import {
  DEPOSITS,
  GAME_CREDITS,
  GAME_TRANSFERS,
  LIVE_FEED_POOL,
  PLAYERS,
  WITHDRAWALS,
} from "./mock-data";

type Notification = {
  id: string;
  kind: "deposit" | "withdrawal" | "topup" | "pullback";
  message: string;
  createdAt: number;
};

export type ImportedPlayerInput = Omit<
  Player,
  "player_id" | "registration_date" | "status" | "total_deposits" | "total_withdrawals"
>;

type Store = {
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  gameCredits: GameCredit[];
  gameTransfers: GameTransfer[];
  importedPlayers: Player[];
  notifications: Notification[];

  // Derived helpers
  getCreditBalance: (playerId: number, game: GameName) => number;

  // Player import
  importPlayers: (rows: ImportedPlayerInput[]) => Player[];

  // Deposit actions
  updateDepositDraft: (
    depositId: number,
    patch: Partial<Pick<Deposit, "bonus_percentage" | "selected_game">>,
  ) => void;
  approveDeposit: (depositId: number, handledByUserId: number) => void;
  injectLiveDeposit: () => Deposit | null;

  // Withdrawal actions
  pullCreditsForWithdrawal: (
    withdrawalId: number,
    handledByUserId: number,
  ) => void;
  markWithdrawalPaid: (withdrawalId: number) => void;

  // Game transfer
  createGameTransfer: (input: {
    playerId: number;
    fromGame: GameName;
    toGame: GameName;
    amount: number;
    handledByUserId: number;
  }) => void;

  // Notifications
  pushNotification: (n: Omit<Notification, "id" | "createdAt">) => void;
  clearNotifications: () => void;
};

export const useStore = create<Store>((set, get) => ({
  deposits: DEPOSITS,
  withdrawals: WITHDRAWALS,
  gameCredits: GAME_CREDITS,
  gameTransfers: GAME_TRANSFERS,
  importedPlayers: [],
  notifications: [],

  getCreditBalance: (playerId, game) => {
    const row = get().gameCredits.find(
      (c) => c.player_id === playerId && c.game_name === game,
    );
    return row?.current_balance ?? 0;
  },

  importPlayers: (rows) => {
    const existingMaxId = Math.max(
      ...PLAYERS.map((p) => p.player_id),
      ...get().importedPlayers.map((p) => p.player_id),
      1000,
    );
    const nowIso = new Date().toISOString();
    const created: Player[] = rows.map((r, i) => ({
      player_id: existingMaxId + 1 + i,
      ...r,
      registration_date: nowIso,
      status: "active",
      total_deposits: 0,
      total_withdrawals: 0,
    }));
    set((s) => ({ importedPlayers: [...created, ...s.importedPlayers] }));
    get().pushNotification({
      kind: "deposit",
      message: `Imported ${created.length} new player${created.length === 1 ? "" : "s"}`,
    });
    return created;
  },

  updateDepositDraft: (depositId, patch) => {
    set((s) => ({
      deposits: s.deposits.map((d) => {
        if (d.deposit_id !== depositId) return d;
        const bonusPct =
          patch.bonus_percentage !== undefined
            ? patch.bonus_percentage
            : d.bonus_percentage;
        const bonusAmt = +(d.deposit_amount * (bonusPct / 100)).toFixed(2);
        return {
          ...d,
          ...patch,
          bonus_percentage: bonusPct,
          bonus_amount: bonusAmt,
          total_amount: +(d.deposit_amount + bonusAmt).toFixed(2),
          updated_at: new Date().toISOString(),
        };
      }),
    }));
  },

  approveDeposit: (depositId, handledByUserId) => {
    const d = get().deposits.find((x) => x.deposit_id === depositId);
    if (!d || !d.selected_game) return;
    const reference = `TOPUP-${Math.floor(Math.random() * 900000 + 100000)}`;
    set((s) => ({
      deposits: s.deposits.map((x) =>
        x.deposit_id === depositId
          ? {
              ...x,
              status: "completed",
              handled_by_user_id: handledByUserId,
              game_topup_reference: reference,
              is_new: false,
              updated_at: new Date().toISOString(),
            }
          : x,
      ),
      gameCredits: (() => {
        const existing = s.gameCredits.find(
          (c) =>
            c.player_id === d.player_id && c.game_name === d.selected_game,
        );
        if (existing) {
          return s.gameCredits.map((c) =>
            c.player_id === d.player_id && c.game_name === d.selected_game
              ? {
                  ...c,
                  current_balance: +(
                    c.current_balance + d.total_amount
                  ).toFixed(2),
                  last_updated_at: new Date().toISOString(),
                }
              : c,
          );
        }
        return [
          ...s.gameCredits,
          {
            player_id: d.player_id,
            game_name: d.selected_game!,
            current_balance: d.total_amount,
            last_updated_at: new Date().toISOString(),
          },
        ];
      })(),
    }));
    get().pushNotification({
      kind: "topup",
      message: `RM ${d.total_amount.toFixed(2)} credited to ${d.selected_game} for ${d.player_username}`,
    });
  },

  injectLiveDeposit: () => {
    const pool = LIVE_FEED_POOL;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const id = 6000 + Math.floor(Math.random() * 9000);
    const deposit: Deposit = {
      deposit_id: id,
      transaction_ref: `TXN${Date.now().toString().slice(-12)}`,
      deposit_date: new Date().toISOString(),
      player_id: pick.player_id,
      player_username: pick.player_username,
      deposit_amount: pick.deposit_amount,
      bank_name: pick.bank_name,
      bank_account_number: pick.bank_account_number,
      bank_account_holder: pick.bank_account_holder,
      bonus_percentage: 0,
      bonus_amount: 0,
      total_amount: pick.deposit_amount,
      selected_game: null,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_new: true,
    };
    set((s) => ({ deposits: [deposit, ...s.deposits] }));
    get().pushNotification({
      kind: "deposit",
      message: `New deposit detected: ${pick.player_username} — RM ${pick.deposit_amount.toFixed(2)} via ${pick.bank_name}`,
    });
    return deposit;
  },

  pullCreditsForWithdrawal: (withdrawalId, handledByUserId) => {
    const w = get().withdrawals.find((x) => x.withdrawal_id === withdrawalId);
    if (!w) return;
    const bal = get().getCreditBalance(w.player_id, w.game_name);
    const pulled = Math.min(bal, w.requested_amount);
    set((s) => ({
      withdrawals: s.withdrawals.map((x) =>
        x.withdrawal_id === withdrawalId
          ? {
              ...x,
              status: "credits_pulled",
              credit_pulled_amount: pulled,
              handled_by_user_id: handledByUserId,
              updated_at: new Date().toISOString(),
            }
          : x,
      ),
      gameCredits: s.gameCredits.map((c) =>
        c.player_id === w.player_id && c.game_name === w.game_name
          ? {
              ...c,
              current_balance: +(c.current_balance - pulled).toFixed(2),
              last_updated_at: new Date().toISOString(),
            }
          : c,
      ),
    }));
    get().pushNotification({
      kind: "pullback",
      message: `Pulled RM ${pulled.toFixed(2)} from ${w.game_name} back to CRM`,
    });
  },

  markWithdrawalPaid: (withdrawalId) => {
    set((s) => ({
      withdrawals: s.withdrawals.map((x) =>
        x.withdrawal_id === withdrawalId
          ? { ...x, status: "paid", updated_at: new Date().toISOString() }
          : x,
      ),
    }));
    const w = get().withdrawals.find((x) => x.withdrawal_id === withdrawalId);
    if (w) {
      get().pushNotification({
        kind: "withdrawal",
        message: `Withdrawal RM ${w.credit_pulled_amount.toFixed(2)} paid out`,
      });
    }
  },

  createGameTransfer: ({ playerId, fromGame, toGame, amount, handledByUserId }) => {
    const fromBal = get().getCreditBalance(playerId, fromGame);
    if (amount > fromBal) return;
    const transfer: GameTransfer = {
      transfer_id: 10000 + Math.floor(Math.random() * 9000),
      player_id: playerId,
      from_game: fromGame,
      to_game: toGame,
      transfer_amount: amount,
      from_game_balance_before: fromBal,
      status: "completed",
      handled_by_user_id: handledByUserId,
      created_at: new Date().toISOString(),
    };
    set((s) => {
      const hasTo = s.gameCredits.some(
        (c) => c.player_id === playerId && c.game_name === toGame,
      );
      const updatedCredits = s.gameCredits.map((c) => {
        if (c.player_id === playerId && c.game_name === fromGame) {
          return {
            ...c,
            current_balance: +(c.current_balance - amount).toFixed(2),
            last_updated_at: new Date().toISOString(),
          };
        }
        if (c.player_id === playerId && c.game_name === toGame) {
          return {
            ...c,
            current_balance: +(c.current_balance + amount).toFixed(2),
            last_updated_at: new Date().toISOString(),
          };
        }
        return c;
      });
      if (!hasTo) {
        updatedCredits.push({
          player_id: playerId,
          game_name: toGame,
          current_balance: amount,
          last_updated_at: new Date().toISOString(),
        });
      }
      return {
        gameTransfers: [transfer, ...s.gameTransfers],
        gameCredits: updatedCredits,
      };
    });
  },

  pushNotification: (n) => {
    const notif: Notification = {
      ...n,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
    };
    set((s) => ({ notifications: [notif, ...s.notifications].slice(0, 20) }));
  },

  clearNotifications: () => set({ notifications: [] }),
}));

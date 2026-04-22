"use client";

import { create } from "zustand";
import type {
  BankTransfer,
  CompanyBankAccount,
  Deposit,
  GameCredit,
  GameName,
  GameTransfer,
  Player,
  ProviderBoAccount,
  ProviderBoAdjustment,
  Withdrawal,
} from "./types";
import {
  BANK_TRANSFERS,
  COMPANY_BANK_ACCOUNTS,
  DEPOSITS,
  GAME_CREDITS,
  GAME_TRANSFERS,
  LIVE_FEED_POOL,
  PLAYERS,
  PROVIDER_BO_ACCOUNTS,
  PROVIDER_BO_ADJUSTMENTS,
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

export type CompanyBankAccountInput = Omit<
  CompanyBankAccount,
  "account_id" | "created_at"
>;

export type ProviderBoAccountInput = Omit<
  ProviderBoAccount,
  "bo_account_id" | "created_at"
>;

type Store = {
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  gameCredits: GameCredit[];
  gameTransfers: GameTransfer[];
  importedPlayers: Player[];
  companyBankAccounts: CompanyBankAccount[];
  bankTransfers: BankTransfer[];
  providerBoAccounts: ProviderBoAccount[];
  providerBoAdjustments: ProviderBoAdjustment[];
  notifications: Notification[];

  // Global UI context — null = "All companies"
  selectedCompanyId: number | null;
  setSelectedCompanyId: (companyId: number | null) => void;

  // Derived helpers
  getCreditBalance: (playerId: number, game: GameName) => number;

  // Player import
  importPlayers: (rows: ImportedPlayerInput[]) => Player[];

  // Company bank account CRUD
  addCompanyBankAccount: (input: CompanyBankAccountInput) => CompanyBankAccount;
  updateCompanyBankAccount: (
    accountId: number,
    patch: Partial<CompanyBankAccountInput>,
  ) => void;
  deleteCompanyBankAccount: (accountId: number) => void;
  transferBetweenCompanyAccounts: (input: {
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    reference?: string;
    notes?: string;
    handledByUserId: number;
  }) => BankTransfer | null;

  // Provider BO account CRUD + credit adjustment
  addProviderBoAccount: (input: ProviderBoAccountInput) => ProviderBoAccount;
  updateProviderBoAccount: (
    boAccountId: number,
    patch: Partial<ProviderBoAccountInput>,
  ) => void;
  deleteProviderBoAccount: (boAccountId: number) => void;
  adjustProviderBoCredit: (input: {
    boAccountId: number;
    amount: number; // signed: positive = top-up, negative = deduct
    reason: string;
    handledByUserId: number;
  }) => ProviderBoAdjustment | null;

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
  companyBankAccounts: COMPANY_BANK_ACCOUNTS,
  bankTransfers: BANK_TRANSFERS,
  providerBoAccounts: PROVIDER_BO_ACCOUNTS,
  providerBoAdjustments: PROVIDER_BO_ADJUSTMENTS,
  selectedCompanyId: null,
  setSelectedCompanyId: (companyId) => set({ selectedCompanyId: companyId }),
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

  addCompanyBankAccount: (input) => {
    const maxId = Math.max(
      8000,
      ...get().companyBankAccounts.map((a) => a.account_id),
    );
    const account: CompanyBankAccount = {
      ...input,
      account_id: maxId + 1,
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      companyBankAccounts: [account, ...s.companyBankAccounts],
    }));
    return account;
  },

  updateCompanyBankAccount: (accountId, patch) => {
    set((s) => ({
      companyBankAccounts: s.companyBankAccounts.map((a) =>
        a.account_id === accountId ? { ...a, ...patch } : a,
      ),
    }));
  },

  deleteCompanyBankAccount: (accountId) => {
    set((s) => ({
      companyBankAccounts: s.companyBankAccounts.filter(
        (a) => a.account_id !== accountId,
      ),
    }));
  },

  transferBetweenCompanyAccounts: ({
    fromAccountId,
    toAccountId,
    amount,
    reference,
    notes,
    handledByUserId,
  }) => {
    if (fromAccountId === toAccountId || amount <= 0) return null;
    const accounts = get().companyBankAccounts;
    const from = accounts.find((a) => a.account_id === fromAccountId);
    const to = accounts.find((a) => a.account_id === toAccountId);
    if (!from || !to) return null;
    if (amount > from.current_balance) return null;

    const transfer: BankTransfer = {
      transfer_id: Math.max(11000, ...get().bankTransfers.map((t) => t.transfer_id)) + 1,
      from_account_id: fromAccountId,
      to_account_id: toAccountId,
      amount,
      reference: reference?.trim() || undefined,
      notes: notes?.trim() || undefined,
      handled_by_user_id: handledByUserId,
      status: "completed",
      created_at: new Date().toISOString(),
    };

    set((s) => ({
      companyBankAccounts: s.companyBankAccounts.map((a) => {
        if (a.account_id === fromAccountId) {
          return {
            ...a,
            current_balance: +(a.current_balance - amount).toFixed(2),
          };
        }
        if (a.account_id === toAccountId) {
          return {
            ...a,
            current_balance: +(a.current_balance + amount).toFixed(2),
          };
        }
        return a;
      }),
      bankTransfers: [transfer, ...s.bankTransfers],
    }));

    get().pushNotification({
      kind: "topup",
      message: `Transferred RM ${amount.toFixed(2)} from ${from.bank_name} ${from.account_number.slice(-4)} → ${to.bank_name} ${to.account_number.slice(-4)}`,
    });
    return transfer;
  },

  addProviderBoAccount: (input) => {
    const maxId = Math.max(
      9000,
      ...get().providerBoAccounts.map((a) => a.bo_account_id),
    );
    const account: ProviderBoAccount = {
      ...input,
      bo_account_id: maxId + 1,
      created_at: new Date().toISOString(),
    };
    set((s) => ({
      providerBoAccounts: [account, ...s.providerBoAccounts],
    }));
    return account;
  },

  updateProviderBoAccount: (boAccountId, patch) => {
    set((s) => ({
      providerBoAccounts: s.providerBoAccounts.map((a) =>
        a.bo_account_id === boAccountId ? { ...a, ...patch } : a,
      ),
    }));
  },

  deleteProviderBoAccount: (boAccountId) => {
    set((s) => ({
      providerBoAccounts: s.providerBoAccounts.filter(
        (a) => a.bo_account_id !== boAccountId,
      ),
      providerBoAdjustments: s.providerBoAdjustments.filter(
        (j) => j.bo_account_id !== boAccountId,
      ),
    }));
  },

  adjustProviderBoCredit: ({ boAccountId, amount, reason, handledByUserId }) => {
    if (amount === 0 || !reason.trim()) return null;
    const account = get().providerBoAccounts.find(
      (a) => a.bo_account_id === boAccountId,
    );
    if (!account) return null;
    const newBalance = +(account.current_credit + amount).toFixed(2);
    if (newBalance < 0) return null;

    const adjustment: ProviderBoAdjustment = {
      adjustment_id:
        Math.max(12000, ...get().providerBoAdjustments.map((j) => j.adjustment_id)) +
        1,
      bo_account_id: boAccountId,
      amount,
      reason: reason.trim(),
      handled_by_user_id: handledByUserId,
      created_at: new Date().toISOString(),
    };

    set((s) => ({
      providerBoAccounts: s.providerBoAccounts.map((a) =>
        a.bo_account_id === boAccountId
          ? { ...a, current_credit: newBalance }
          : a,
      ),
      providerBoAdjustments: [adjustment, ...s.providerBoAdjustments],
    }));

    get().pushNotification({
      kind: "topup",
      message: `${amount > 0 ? "Topped up" : "Deducted"} ${Math.abs(amount).toLocaleString("en-MY")} credits on ${account.game_name} (${account.bo_username})`,
    });
    return adjustment;
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

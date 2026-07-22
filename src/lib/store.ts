"use client";

import { create } from "zustand";
import type {
  ApiKeyRow,
  BankAccount,
  BankTransfer,
  CompanyView,
  BotHealth,
  Deposit,
  Entity,
  Expense,
  ExpenseCategory,
  GameCredit,
  GameTransfer,
  Me,
  Player,
  ProviderBoAccount,
  ProviderBoAdjustment,
  ServerSettings,
  User,
  Withdrawal,
} from "./types";

export type Notification = {
  id: string;
  kind: "deposit" | "withdrawal" | "topup" | "pullback" | "transfer" | "system";
  message: string;
  createdAt: number;
};

export type MutationResult = { ok: boolean; error?: string };

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        error: (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`,
      };
    }
    return { ok: true, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null, error: "Network error" };
  }
}

type StateResponse = {
  me: Me;
  entities: Entity[];
  users: User[];
  players: Player[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  gameCredits: GameCredit[];
  gameTransfers: GameTransfer[];
  bankAccounts: BankAccount[];
  bankTransfers: BankTransfer[];
  boAccounts: ProviderBoAccount[];
  boAdjustments: ProviderBoAdjustment[];
  expenses: Expense[];
  botHealth: BotHealth[];
  settings: ServerSettings;
};

type Store = {
  hydrated: boolean;
  me: Me | null;
  entities: Entity[];
  users: User[];
  players: Player[];
  deposits: Deposit[];
  withdrawals: Withdrawal[];
  gameCredits: GameCredit[];
  gameTransfers: GameTransfer[];
  bankAccounts: BankAccount[];
  bankTransfers: BankTransfer[];
  boAccounts: ProviderBoAccount[];
  boAdjustments: ProviderBoAdjustment[];
  expenses: Expense[];
  botHealth: BotHealth[];
  settings: ServerSettings;
  notifications: Notification[];

  /** Company selector in the top nav — null = all visible companies. */
  selectedCompanyId: number | null;
  setSelectedCompanyId: (companyId: number | null) => void;
  /** "View as leader" selector (main-company only) — null = all leaders. */
  selectedLeaderId: number | null;
  setSelectedLeaderId: (leaderId: number | null) => void;
  /**
   * Is a company within the current top-nav scope? A specific company wins;
   * otherwise a selected leader constrains to its companies; otherwise all.
   * `null` company (e.g. unmatched deposits) is never in a narrowed scope.
   */
  companyInScope: (companyId: number | null | undefined) => boolean;

  // --- hydration ---
  refresh: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;

  // --- derived helpers ---
  companies: () => CompanyView[];
  getCreditBalance: (playerId: number, game: string) => number;
  userName: (userId?: number | null) => string;
  playerById: (playerId?: number | null) => Player | undefined;
  entityName: (entityId?: number | null) => string;
  games: () => string[];
  banks: () => string[];
  bonusOptions: () => number[];
  /** Games with an active BO/kiosk login for a company; null → full catalog. */
  kioskGames: (companyId: number | null) => string[];

  // --- mutations (API-backed; refresh() after success) ---
  updateDepositDraft: (
    depositId: number,
    patch: Partial<Pick<Deposit, "bonus_percentage" | "selected_game" | "player_id">>,
  ) => Promise<MutationResult>;
  approveDeposit: (depositId: number) => Promise<MutationResult>;
  reprocessDeposit: (depositId: number) => Promise<MutationResult>;
  createDepositIntent: (input: {
    player_id: number;
    amount: number;
    bank_name: string;
    status?: "pending_match" | "pending";
    selected_game?: string;
    bonus_percentage?: number;
    receipt_url?: string;
  }) => Promise<MutationResult>;
  createWithdrawal: (input: {
    player_id: number;
    requested_amount: number;
    game_name: string;
    bank_name?: string;
    bank_account_number?: string;
  }) => Promise<MutationResult>;
  pullCreditsForWithdrawal: (withdrawalId: number) => Promise<MutationResult>;
  markWithdrawalPaid: (
    withdrawalId: number,
    opts?: { paid_from_account_id?: number; proof_url?: string },
  ) => Promise<MutationResult>;
  createGameTransfer: (input: {
    playerId: number;
    fromGame: string;
    toGame: string;
    amount: number;
  }) => Promise<MutationResult>;
  createPlayer: (input: {
    username: string;
    full_name: string;
    telegram_username: string;
    company_entity_id: number;
    contact_number?: string;
    wechat_id?: string;
    notes?: string;
    bank_accounts?: { bank_name: string; account_number: string; account_holder: string }[];
    game_accounts?: { game_name: string; game_username: string }[];
  }) => Promise<MutationResult>;
  importPlayers: (
    rows: Parameters<Store["createPlayer"]>[0][],
  ) => Promise<MutationResult>;
  updatePlayer: (
    playerId: number,
    patch: Partial<
      Pick<
        Player,
        | "full_name"
        | "contact_number"
        | "telegram_username"
        | "wechat_id"
        | "status"
        | "notes"
        | "bank_accounts"
        | "game_accounts"
      >
    >,
  ) => Promise<MutationResult>;
  addBankAccount: (input: {
    entity_id: number;
    role: "deposit" | "withdrawal";
    bank_name: string;
    account_number: string;
    account_holder: string;
    label?: string;
    login_id?: string;
    login_password?: string;
    login_pin?: string;
    current_balance?: number;
    status?: "active" | "inactive";
  }) => Promise<MutationResult>;
  updateBankAccount: (
    accountId: number,
    patch: Record<string, unknown>,
  ) => Promise<MutationResult>;
  deleteBankAccount: (accountId: number) => Promise<MutationResult>;
  createBankTransfer: (input: {
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    reference?: string;
    notes?: string;
  }) => Promise<MutationResult>;
  confirmBankTransfer: (transferId: number) => Promise<MutationResult>;
  rejectBankTransfer: (transferId: number) => Promise<MutationResult>;
  addBoAccount: (input: {
    company_entity_id: number;
    game_name: string;
    bo_username: string;
    bo_password: string;
    bo_pin?: string;
    bo_label?: string;
    current_credit?: number;
    status?: "active" | "inactive";
    notes?: string;
  }) => Promise<MutationResult>;
  updateBoAccount: (
    boAccountId: number,
    patch: Record<string, unknown>,
  ) => Promise<MutationResult>;
  deleteBoAccount: (boAccountId: number) => Promise<MutationResult>;
  adjustBoCredit: (input: {
    boAccountId: number;
    amount: number;
    reason: string;
  }) => Promise<MutationResult>;
  createExpense: (input: {
    expense_date: string;
    category: ExpenseCategory;
    description: string;
    amount: number;
    company_entity_id?: number | null;
    notes?: string;
  }) => Promise<MutationResult>;
  deleteExpense: (expenseId: number) => Promise<MutationResult>;
  addEntity: (input: {
    parent_entity_id: number;
    entity_type: "leader" | "company" | "cs";
    name: string;
  }) => Promise<MutationResult>;
  addUser: (input: {
    username: string;
    email: string;
    full_name: string;
    password: string;
    role: "company_leader" | "cs_agent" | "viewer";
    entity_id: number;
  }) => Promise<MutationResult>;

  // --- admin / settings ---
  apiKeys: ApiKeyRow[];
  fetchApiKeys: () => Promise<void>;
  createApiKey: (input: {
    label: string;
    allowed_ips?: string[];
  }) => Promise<{ ok: boolean; key?: string; error?: string }>;
  updateApiKey: (
    keyId: number,
    patch: { label?: string; status?: "active" | "inactive"; allowed_ips?: string[] | null },
  ) => Promise<MutationResult>;
  deleteApiKey: (keyId: number) => Promise<MutationResult>;
  addCsAgent: (input: {
    company_entity_id: number;
    full_name: string;
    username: string;
    email: string;
    password: string;
  }) => Promise<MutationResult>;
  addLeader: (input: {
    full_name: string;
    company_name?: string;
    username: string;
    email: string;
    password: string;
  }) => Promise<MutationResult>;
  updateUser: (
    userId: number,
    patch: { full_name?: string; status?: "active" | "inactive" },
  ) => Promise<MutationResult>;
  deleteUser: (userId: number) => Promise<MutationResult>;
  changePassword: (input: {
    current_password: string;
    new_password: string;
  }) => Promise<MutationResult>;
  updateSetting: (patch: {
    transfer_auto_confirm_hours?: number;
    games?: string[];
    banks?: string[];
    bonus_options?: number[];
  }) => Promise<MutationResult>;

  uploadFile: (file: File) => Promise<{ ok: boolean; url?: string; error?: string }>;
  logout: () => Promise<void>;

  pushNotification: (n: Omit<Notification, "id" | "createdAt">) => void;
  clearNotifications: () => void;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let knownDepositIds: Set<number> | null = null;

export const useStore = create<Store>((set, get) => {
  async function mutate(
    path: string,
    init: RequestInit,
    okMessage?: { kind: Notification["kind"]; message: string },
  ): Promise<MutationResult> {
    const res = await api(path, init);
    if (!res.ok) return { ok: false, error: res.error };
    if (okMessage) get().pushNotification(okMessage);
    await get().refresh();
    return { ok: true };
  }

  return {
    hydrated: false,
    me: null,
    entities: [],
    users: [],
    players: [],
    deposits: [],
    withdrawals: [],
    gameCredits: [],
    gameTransfers: [],
    bankAccounts: [],
    bankTransfers: [],
    boAccounts: [],
    boAdjustments: [],
    expenses: [],
    botHealth: [],
    settings: {},
    notifications: [],
    selectedCompanyId: null,
    setSelectedCompanyId: (companyId) => set({ selectedCompanyId: companyId }),
    selectedLeaderId: null,
    setSelectedLeaderId: (leaderId) => {
      // Drop a company selection that no longer belongs to the chosen leader.
      const { selectedCompanyId } = get();
      let nextCompany = selectedCompanyId;
      if (leaderId != null && selectedCompanyId != null) {
        const comp = get()
          .companies()
          .find((c) => c.company_id === selectedCompanyId);
        if (comp?.leader_entity_id !== leaderId) nextCompany = null;
      }
      set({ selectedLeaderId: leaderId, selectedCompanyId: nextCompany });
    },
    companyInScope: (companyId) => {
      const { selectedCompanyId, selectedLeaderId } = get();
      if (selectedCompanyId != null) return companyId === selectedCompanyId;
      if (selectedLeaderId != null) {
        if (companyId == null) return false;
        const comp = get()
          .companies()
          .find((c) => c.company_id === companyId);
        return comp?.leader_entity_id === selectedLeaderId;
      }
      return true;
    },

    refresh: async () => {
      const res = await api<StateResponse>("/api/state");
      if (!res.ok) {
        if (res.status === 401 && typeof window !== "undefined") {
          window.location.href = "/login";
        }
        return;
      }
      const data = res.data!;
      // Flag deposits that appeared since the previous poll (green flash + bell)
      const incoming = new Set(data.deposits.map((d) => d.deposit_id));
      let flagged = data.deposits;
      if (knownDepositIds) {
        const fresh = data.deposits.filter((d) => !knownDepositIds!.has(d.deposit_id));
        if (fresh.length) {
          flagged = data.deposits.map((d) =>
            knownDepositIds!.has(d.deposit_id) ? d : { ...d, is_new: true },
          );
          for (const d of fresh) {
            get().pushNotification({
              kind: "deposit",
              message: `New deposit detected: ${d.player_username ?? d.bank_description ?? "unmatched"} — RM ${d.deposit_amount.toFixed(2)} via ${d.bank_name}`,
            });
          }
        }
      }
      knownDepositIds = incoming;
      set({ ...data, deposits: flagged, hydrated: true });
    },

    startPolling: () => {
      if (pollTimer) return;
      void get().refresh();
      pollTimer = setInterval(() => void get().refresh(), 10_000);
    },
    stopPolling: () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    },

    companies: () => {
      const { entities } = get();
      const byId = new Map(entities.map((e) => [e.entity_id, e]));
      return entities
        .filter((e) => e.entity_type === "company")
        .map((e) => ({
          company_id: e.entity_id,
          company_name: e.name,
          leader_entity_id: e.parent_entity_id,
          leader_name: e.parent_entity_id
            ? (byId.get(e.parent_entity_id)?.name ?? "")
            : "",
          status: e.status,
        }));
    },

    getCreditBalance: (playerId, game) =>
      get().gameCredits.find(
        (c) => c.player_id === playerId && c.game_name === game,
      )?.current_balance ?? 0,

    userName: (userId) =>
      get().users.find((u) => u.user_id === userId)?.full_name ?? "—",

    playerById: (playerId) =>
      get().players.find((p) => p.player_id === playerId),

    entityName: (entityId) =>
      get().entities.find((e) => e.entity_id === entityId)?.name ?? "—",

    games: () => get().settings.games ?? ["Mega888", "Pussy888", "918Kiss", "XE88"],
    banks: () =>
      get().settings.banks ?? ["Maybank", "CIMB", "Hong Leong", "Public Bank"],
    bonusOptions: () => get().settings.bonus_options ?? [0, 5, 10, 20, 30, 50, 100],

    // Games a company can actually be topped up with: those with an active
    // provider back-office (kiosk) login the bot can sign in to. Pass null
    // (company not yet known) to fall back to the full games catalog.
    kioskGames: (companyId) => {
      if (companyId == null) return get().games();
      const seen = new Set<string>();
      for (const bo of get().boAccounts) {
        if (bo.company_entity_id === companyId && bo.status === "active") {
          seen.add(bo.game_name);
        }
      }
      return get()
        .games()
        .filter((g) => seen.has(g));
    },

    updateDepositDraft: async (depositId, patch) => {
      // Fully optimistic: reflect the change in the row immediately and do NOT
      // block on a full /api/state refresh (which sweeps + re-queries everything
      // and round-trips the DB — the source of the seconds-long lag when picking
      // a game/bonus or assigning a player). The 10s poll reconciles; on failure
      // we refresh to revert.
      const players = get().players;
      set({
        deposits: get().deposits.map((d) => {
          if (d.deposit_id !== depositId) return d;
          const next = { ...d, ...patch };
          if (patch.bonus_percentage !== undefined) {
            const bonusAmt = +(
              (d.deposit_amount * patch.bonus_percentage) /
              100
            ).toFixed(2);
            next.bonus_amount = bonusAmt;
            next.total_amount = +(d.deposit_amount + bonusAmt).toFixed(2);
          }
          if (patch.player_id !== undefined) {
            const p = players.find((x) => x.player_id === patch.player_id);
            if (p) {
              next.player_username = p.username;
              next.company_entity_id = p.company_entity_id;
            }
          }
          return next;
        }),
      });
      const res = await api(`/api/deposits/${depositId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        await get().refresh(); // revert the optimistic row to server truth
        return { ok: false, error: res.error };
      }
      return { ok: true };
    },

    approveDeposit: async (depositId) => {
      const d = get().deposits.find((x) => x.deposit_id === depositId);
      const result = await mutate(`/api/deposits/${depositId}/approve`, {
        method: "POST",
      });
      if (result.ok && d) {
        get().pushNotification({
          kind: "topup",
          message: `Approved — RM ${d.total_amount.toFixed(2)} top-up dispatched to the bot for ${d.player_username} (${d.selected_game})`,
        });
      }
      return result;
    },

    reprocessDeposit: async (depositId) => {
      // Optimistic: flip the row to "pending" immediately so CS sees it become
      // editable/approvable on click — not on the next 10s poll. mutate()
      // refreshes on success to reconcile with the server; on failure we refresh
      // to revert the row back to "failed".
      set({
        deposits: get().deposits.map((d) =>
          d.deposit_id === depositId
            ? { ...d, status: "pending", game_topup_reference: null }
            : d,
        ),
      });
      const result = await mutate(`/api/deposits/${depositId}/reprocess`, {
        method: "POST",
      });
      if (!result.ok) await get().refresh();
      return result;
    },

    createDepositIntent: (input) =>
      mutate("/api/deposits", { method: "POST", body: JSON.stringify(input) }),

    createWithdrawal: (input) =>
      mutate("/api/withdrawals", { method: "POST", body: JSON.stringify(input) }),

    pullCreditsForWithdrawal: async (withdrawalId) => {
      const w = get().withdrawals.find((x) => x.withdrawal_id === withdrawalId);
      const result = await mutate(`/api/withdrawals/${withdrawalId}/pull`, {
        method: "POST",
      });
      if (result.ok && w) {
        get().pushNotification({
          kind: "pullback",
          message: `Pulled credits from ${w.game_name} back to CRM`,
        });
      }
      return result;
    },

    markWithdrawalPaid: (withdrawalId, opts) =>
      mutate(
        `/api/withdrawals/${withdrawalId}/paid`,
        { method: "POST", body: JSON.stringify(opts ?? {}) },
        { kind: "withdrawal", message: "Withdrawal marked as paid" },
      ),

    createGameTransfer: ({ playerId, fromGame, toGame, amount }) =>
      mutate("/api/game-transfers", {
        method: "POST",
        body: JSON.stringify({
          player_id: playerId,
          from_game: fromGame,
          to_game: toGame,
          amount,
        }),
      }),

    createPlayer: (input) =>
      mutate("/api/players", { method: "POST", body: JSON.stringify(input) }),

    importPlayers: (rows) =>
      mutate(
        "/api/players",
        { method: "POST", body: JSON.stringify(rows) },
        {
          kind: "system",
          message: `Imported ${rows.length} player${rows.length === 1 ? "" : "s"}`,
        },
      ),

    updatePlayer: (playerId, patch) =>
      mutate(`/api/players/${playerId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    addBankAccount: (input) =>
      mutate("/api/bank-accounts", { method: "POST", body: JSON.stringify(input) }),

    updateBankAccount: (accountId, patch) =>
      mutate(`/api/bank-accounts/${accountId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    deleteBankAccount: (accountId) =>
      mutate(`/api/bank-accounts/${accountId}`, { method: "DELETE" }),

    createBankTransfer: ({ fromAccountId, toAccountId, amount, reference, notes }) =>
      mutate(
        "/api/transfers",
        {
          method: "POST",
          body: JSON.stringify({
            from_account_id: fromAccountId,
            to_account_id: toAccountId,
            amount,
            reference,
            notes,
          }),
        },
        {
          kind: "transfer",
          message: `Transfer of RM ${amount.toFixed(2)} initiated — awaiting recipient confirmation`,
        },
      ),

    confirmBankTransfer: (transferId) =>
      mutate(
        `/api/transfers/${transferId}/confirm`,
        { method: "POST" },
        { kind: "transfer", message: "Transfer confirmed — funds credited" },
      ),

    rejectBankTransfer: (transferId) =>
      mutate(
        `/api/transfers/${transferId}/reject`,
        { method: "POST" },
        { kind: "transfer", message: "Transfer rejected — sender refunded" },
      ),

    addBoAccount: (input) =>
      mutate("/api/bo-accounts", { method: "POST", body: JSON.stringify(input) }),

    updateBoAccount: (boAccountId, patch) =>
      mutate(`/api/bo-accounts/${boAccountId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    deleteBoAccount: (boAccountId) =>
      mutate(`/api/bo-accounts/${boAccountId}`, { method: "DELETE" }),

    adjustBoCredit: ({ boAccountId, amount, reason }) =>
      mutate(`/api/bo-accounts/${boAccountId}`, {
        method: "PATCH",
        body: JSON.stringify({ adjust_amount: amount, adjust_reason: reason }),
      }),

    createExpense: (input) =>
      mutate("/api/expenses", { method: "POST", body: JSON.stringify(input) }),
    deleteExpense: (expenseId) =>
      mutate(`/api/expenses/${expenseId}`, { method: "DELETE" }),

    addEntity: (input) =>
      mutate("/api/entities", { method: "POST", body: JSON.stringify(input) }),

    addUser: (input) =>
      mutate("/api/users", { method: "POST", body: JSON.stringify(input) }),

    // --- admin / settings ---
    apiKeys: [],

    fetchApiKeys: async () => {
      const res = await api<{ apiKeys: ApiKeyRow[] }>("/api/api-keys");
      if (res.ok && res.data) set({ apiKeys: res.data.apiKeys });
    },

    createApiKey: async (input) => {
      const res = await api<{ key: string }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await get().fetchApiKeys();
      get().pushNotification({ kind: "system", message: `API key "${input.label}" created` });
      return { ok: true, key: res.data?.key };
    },

    updateApiKey: async (keyId, patch) => {
      const res = await api(`/api/api-keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await get().fetchApiKeys();
      return { ok: true };
    },

    deleteApiKey: async (keyId) => {
      const res = await api(`/api/api-keys/${keyId}`, { method: "DELETE" });
      if (!res.ok) return { ok: false, error: res.error };
      await get().fetchApiKeys();
      return { ok: true };
    },

    addCsAgent: (input) =>
      mutate(
        "/api/team/cs-agent",
        { method: "POST", body: JSON.stringify(input) },
        { kind: "system", message: `CS agent ${input.full_name} added` },
      ),

    addLeader: (input) =>
      mutate(
        "/api/team/leader",
        { method: "POST", body: JSON.stringify(input) },
        { kind: "system", message: `Leader ${input.full_name} added` },
      ),

    updateUser: (userId, patch) =>
      mutate(`/api/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    deleteUser: (userId) =>
      mutate(`/api/users/${userId}`, { method: "DELETE" }),

    changePassword: async (input) => {
      const res = await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) return { ok: false, error: res.error };
      get().pushNotification({ kind: "system", message: "Password changed" });
      return { ok: true };
    },

    updateSetting: async (patch) => {
      const res = await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!res.ok) return { ok: false, error: res.error };
      await get().refresh();
      get().pushNotification({ kind: "system", message: "Settings updated" });
      return { ok: true };
    },

    uploadFile: async (file) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/uploads", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: data?.error ?? "Upload failed" };
      return { ok: true, url: data.url };
    },

    logout: async () => {
      get().stopPolling();
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login";
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
  };
});

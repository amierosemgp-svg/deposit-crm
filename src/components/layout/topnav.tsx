"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Bell, LogOut, Search, Wallet } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { initialsOf, formatRelative, formatRM } from "@/lib/format";
import { useStore } from "@/lib/store";
import { usePlayerProfile } from "@/components/player-name-link";
import type { UserRole } from "@/lib/types";

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  company_leader: "Leader",
  cs_agent: "CS Agent",
  viewer: "Viewer",
};

export function TopNav() {
  const router = useRouter();
  const { openPlayer } = usePlayerProfile();

  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const players = useStore((s) => s.players);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const bankTransfers = useStore((s) => s.bankTransfers);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const setSelectedCompanyId = useStore((s) => s.setSelectedCompanyId);
  const notifications = useStore((s) => s.notifications);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const logout = useStore((s) => s.logout);

  const companies = useMemo(
    () => useStore.getState().companies(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entities],
  );
  const mainEntity = entities.find((e) => e.entity_type === "main_company");

  // Incoming bank transfers waiting for our confirmation (bankAccounts are
  // already scoped server-side to what this user can see).
  const pendingIncoming = useMemo(() => {
    const myAccountIds = new Set(bankAccounts.map((a) => a.account_id));
    return bankTransfers.filter(
      (t) =>
        t.status === "pending_confirmation" && myAccountIds.has(t.to_account_id),
    );
  }, [bankAccounts, bankTransfers]);

  // --- global player search ---
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter(
        (p) =>
          p.full_name.toLowerCase().includes(q) ||
          p.username.toLowerCase().includes(q) ||
          (p.telegram_username ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [players, query]);
  const searchOpen = searchFocused && query.trim().length > 0;

  const companyValue =
    selectedCompanyId === null ? "all" : String(selectedCompanyId);
  const companyLabel =
    selectedCompanyId === null
      ? "All Companies"
      : companies.find((c) => c.company_id === selectedCompanyId)
          ?.company_name ?? "All Companies";

  const badgeCount = pendingIncoming.length;

  return (
    <header className="h-14 shrink-0 border-b border-border bg-card/60 backdrop-blur-sm">
      <div className="flex h-full items-center gap-3 px-4">
        <div className="flex items-center gap-2 pr-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Wallet className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Player Deposit CRM</span>
            <span className="text-[10px] text-muted-foreground">
              {mainEntity?.name ?? "—"}
            </span>
          </div>
        </div>

        {companies.length > 1 && (
          <div className="w-52">
            <Select
              value={companyValue}
              onValueChange={(v) =>
                setSelectedCompanyId(!v || v === "all" ? null : Number(v))
              }
            >
              <SelectTrigger className="h-9 w-full cursor-pointer">
                <SelectValue placeholder="All Companies">
                  {companyLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Companies</SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.company_id} value={String(c.company_id)}>
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search players by name or username…"
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
          {searchOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
              {searchResults.length === 0 ? (
                <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                  No players match “{query.trim()}”
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto py-1">
                  {searchResults.map((p) => (
                    <button
                      key={p.player_id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        openPlayer(p.player_id);
                        setQuery("");
                        setSearchFocused(false);
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-muted/60"
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-[10px]">
                          {initialsOf(p.full_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">
                          {p.full_name}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          @{p.username}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <button
                  {...props}
                  className="relative inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  {badgeCount > 0 ? (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-white ring-2 ring-card">
                      {badgeCount}
                    </span>
                  ) : (
                    notifications.length > 0 && (
                      <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
                    )
                  )}
                </button>
              )}
            />
            <DropdownMenuContent align="end" className="w-80">
              <div className="flex items-center justify-between px-1.5 py-1 text-xs font-medium text-muted-foreground">
                <span>Notifications</span>
                {notifications.length > 0 && (
                  <button
                    onClick={clearNotifications}
                    className="cursor-pointer text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {pendingIncoming.length > 0 && (
                <>
                  <div className="px-1.5 py-1 text-[11px] font-medium text-amber-600">
                    Transfers awaiting confirmation
                  </div>
                  {pendingIncoming.map((t) => (
                    <DropdownMenuItem
                      key={t.transfer_id}
                      onClick={() => router.push("/bank-accounts")}
                      className="cursor-pointer"
                    >
                      <ArrowLeftRight className="h-4 w-4 text-amber-600" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-xs leading-snug">
                          Incoming transfer of {formatRM(t.amount)} — confirm to
                          credit funds
                        </span>
                        <span className="mt-0.5 text-[10px] text-muted-foreground">
                          {formatRelative(t.created_at)}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              {notifications.length === 0 && pendingIncoming.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No new notifications
                </div>
              ) : (
                notifications.length > 0 && (
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.slice(0, 8).map((n) => (
                      <div
                        key={n.id}
                        className="flex items-start gap-2 px-3 py-2 hover:bg-muted/50"
                      >
                        <div className="h-1.5 w-1.5 mt-1.5 rounded-full bg-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs leading-snug">{n.message}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {formatRelative(new Date(n.createdAt).toISOString())}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {me === null ? (
            <div className="flex items-center gap-2 px-1.5 py-1">
              <Skeleton className="h-7 w-7 rounded-full" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-12" />
              </div>
            </div>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={(props) => (
                  <button
                    {...props}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
                  >
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="text-[11px]">
                        {initialsOf(me.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col items-start leading-tight">
                      <span className="text-xs font-medium">{me.full_name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {ROLE_LABELS[me.role]}
                      </span>
                    </div>
                  </button>
                )}
              />
              <DropdownMenuContent align="end" className="w-52">
                <div className="px-1.5 py-1.5">
                  <div className="text-sm font-medium">{me.full_name}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {me.email ?? `@${me.username}`}
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void logout()}
                  className="cursor-pointer"
                >
                  <LogOut className="h-4 w-4" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}

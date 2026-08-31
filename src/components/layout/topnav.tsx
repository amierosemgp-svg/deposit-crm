"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Bell, LogOut, Menu } from "lucide-react";
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
import { KillSwitchHeaderButton } from "@/components/kill-switch";
import { Skeleton } from "@/components/ui/skeleton";
import { initialsOf, formatRelative, formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { PlayerSearch } from "./player-search";
import { ThemeToggle } from "./theme-toggle";
import type { UserRole } from "@/lib/types";

/**
 * The leader/company scope pickers read as a breadcrumb, not as controls —
 * bare text plus the chevron, no border or fill. Width hugs the label so a
 * short name doesn't leave a gap before the search box.
 */
const SCOPE_TRIGGER =
  "h-9 w-fit max-w-44 shrink-0 cursor-pointer border-transparent bg-transparent px-0 hover:bg-transparent dark:bg-transparent dark:hover:bg-transparent";

/**
 * Hang the popup off the trigger's left edge instead of centring the selected
 * item over it, and pull it back by the item's own pl-1.5 so the option text
 * lands on the same pixel as the label above it. `w-auto` because the trigger
 * is only as wide as its label — anchor-width would clip longer names.
 */
const SCOPE_CONTENT_PROPS = {
  align: "start",
  alignOffset: -6,
  alignItemWithTrigger: false,
  className: "w-auto",
} as const;

/** Hairline between the borderless header controls. */
function ScopeDivider() {
  return <span aria-hidden className="h-5 w-px shrink-0 bg-border" />;
}

const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super Admin",
  company_leader: "Leader",
  cs_agent: "CS Agent",
  viewer: "Viewer",
};

export function TopNav() {
  const router = useRouter();

  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const bankAccounts = useStore((s) => s.bankAccounts);
  const bankTransfers = useStore((s) => s.bankTransfers);
  const selectedCompanyId = useStore((s) => s.selectedCompanyId);
  const setSelectedCompanyId = useStore((s) => s.setSelectedCompanyId);
  const selectedLeaderId = useStore((s) => s.selectedLeaderId);
  const setSelectedLeaderId = useStore((s) => s.setSelectedLeaderId);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const notifications = useStore((s) => s.notifications);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const logout = useStore((s) => s.logout);

  const companies = useMemo(
    () => useStore.getState().companies(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entities],
  );
  const mainEntity = entities.find((e) => e.entity_type === "main_company");

  // "View as leader" — only the main-company super admin sees this. It scopes
  // the whole CRM to a leader's companies and narrows the company dropdown.
  const leaders = useMemo(
    () => entities.filter((e) => e.entity_type === "leader"),
    [entities],
  );
  const showLeaderSelect = me?.role === "super_admin" && leaders.length > 0;
  const visibleCompanies = useMemo(
    () =>
      selectedLeaderId === null
        ? companies
        : companies.filter((c) => c.leader_entity_id === selectedLeaderId),
    [companies, selectedLeaderId],
  );

  // Incoming bank transfers waiting for our confirmation (bankAccounts are
  // already scoped server-side to what this user can see).
  const pendingIncoming = useMemo(() => {
    const myAccountIds = new Set(bankAccounts.map((a) => a.account_id));
    return bankTransfers.filter(
      (t) =>
        t.status === "pending_confirmation" && myAccountIds.has(t.to_account_id),
    );
  }, [bankAccounts, bankTransfers]);

  const companyValue =
    selectedCompanyId === null ? "all" : String(selectedCompanyId);
  const companyLabel =
    selectedCompanyId === null
      ? selectedLeaderId === null
        ? "All Companies"
        : "All (this leader)"
      : companies.find((c) => c.company_id === selectedCompanyId)
          ?.company_name ?? "All Companies";

  const badgeCount = pendingIncoming.length;

  return (
    <header className="h-14 shrink-0 border-b border-border bg-card/60 backdrop-blur-sm">
      <div className="flex h-full items-center">
        {/* Brand cell — same column as the sidebar (and shrinks with it), so
            everything after it lines up with the content area. */}
        <div
          className={cn(
            "flex h-full shrink-0 items-center gap-2 transition-[width] duration-200 lg:border-r lg:border-sidebar-border",
            sidebarCollapsed
              ? "px-2 lg:w-16 lg:justify-center lg:px-0"
              : "pl-4 pr-2 lg:w-60",
          )}
        >
          {/* Hidden only on lg+, where the collapse actually applies — below
              that there is no sidebar and no toggle to bring the brand back. */}
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col leading-tight",
              sidebarCollapsed && "lg:hidden",
            )}
          >
            <span className="truncate text-sm font-semibold">
              Players Console
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              {mainEntity?.name ?? "—"}
            </span>
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:inline-flex"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>

        {/* px-6 matches <main>'s inner padding, so the search box lines up
            with the page heading below it. */}
        <div className="flex h-full min-w-0 flex-1 items-center gap-3 px-6">
          {showLeaderSelect && (
            <>
              <Select
                value={
                  selectedLeaderId === null ? "all" : String(selectedLeaderId)
                }
                onValueChange={(v) =>
                  setSelectedLeaderId(!v || v === "all" ? null : Number(v))
                }
                items={[
                  { value: "all", label: "All Leaders" },
                  ...leaders.map((l) => ({
                    value: String(l.entity_id),
                    label: l.name,
                  })),
                ]}
              >
                <SelectTrigger className={cn(SCOPE_TRIGGER, "font-semibold")}>
                  <SelectValue placeholder="All Leaders" />
                </SelectTrigger>
                <SelectContent {...SCOPE_CONTENT_PROPS}>
                  <SelectItem value="all">All Leaders</SelectItem>
                  {leaders.map((l) => (
                    <SelectItem key={l.entity_id} value={String(l.entity_id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ScopeDivider />
            </>
          )}

          {(companies.length > 1 || selectedLeaderId !== null) && (
            <>
              <Select
                value={companyValue}
                onValueChange={(v) =>
                  setSelectedCompanyId(!v || v === "all" ? null : Number(v))
                }
              >
                <SelectTrigger className={SCOPE_TRIGGER}>
                  <SelectValue placeholder="All Companies">
                    {companyLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent {...SCOPE_CONTENT_PROPS}>
                  <SelectItem value="all">
                    {selectedLeaderId === null ? "All Companies" : "All (this leader)"}
                  </SelectItem>
                  {visibleCompanies.map((c) => (
                    <SelectItem key={c.company_id} value={String(c.company_id)}>
                      {c.company_name}
                      {/* Whose company it is. Earns its place most in the
                          all-leaders view, where the list spans several leaders
                          and the names alone don't say who owns what. The
                          trigger is unaffected — it renders `companyLabel`, so
                          the collapsed chip stays just the company name. */}
                      {c.leader_name && (
                        <span className="-ml-1 self-center text-[11px] text-muted-foreground/70">
                          ({c.leader_name})
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ScopeDivider />
            </>
          )}

          <PlayerSearch />

          <div className="ml-auto flex items-center gap-2">
            <KillSwitchHeaderButton />
            <ThemeToggle />
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
                    <div className="px-1.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                      Transfers awaiting confirmation
                    </div>
                    {pendingIncoming.map((t) => (
                      <DropdownMenuItem
                        key={t.transfer_id}
                        onClick={() => router.push("/bank-accounts")}
                        className="cursor-pointer"
                      >
                        <ArrowLeftRight className="h-4 w-4 text-amber-600 dark:text-amber-400" />
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
      </div>
    </header>
  );
}

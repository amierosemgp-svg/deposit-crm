"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Wallet,
  Users,
  Banknote,
  ArrowLeftRight,
  History,
  Settings,
  Landmark,
  KeyRound,
  Gift,
  Receipt,
  ScrollText,
  Bot,
  Network,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { REPORT_DEFS } from "@/lib/report-defs";
import type { UserRole } from "@/lib/types";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: "pending_deposits" | "pending_withdrawals";
  /** Who may see it. Omitted = everyone. */
  roles?: UserRole[];
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

/**
 * The nav, grouped by what someone is here to do: the daily queue first, then
 * the accounts and records behind it, then the reports read off them, with the
 * admin surface last.
 *
 * Reports are listed one per line rather than behind a collapsible parent —
 * there are six of them and they are what leaders open the CRM for. The
 * /reports overview page is still reachable from any report's own back-link.
 */
const NAV: NavGroup[] = [
  {
    label: "Operation",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      {
        href: "/deposits",
        label: "Deposits",
        icon: Wallet,
        badge: "pending_deposits",
      },
      {
        href: "/withdrawals",
        label: "Withdrawals",
        icon: Banknote,
        badge: "pending_withdrawals",
      },
      {
        href: "/game-transfer",
        label: "Game Credit Transfer",
        icon: ArrowLeftRight,
      },
      {
        href: "/expenses",
        label: "Expenses",
        icon: Receipt,
        roles: ["super_admin"],
      },
    ],
  },
  {
    label: "Company Accounts",
    items: [
      { href: "/players", label: "Players", icon: Users },
      {
        href: "/bonuses",
        label: "Bonuses",
        icon: Gift,
        roles: ["super_admin", "company_leader"],
      },
      { href: "/bank-accounts", label: "Bank Accounts", icon: Landmark },
      { href: "/provider-accounts", label: "Kiosks Accounts", icon: KeyRound },
      { href: "/hierarchy", label: "Hierarchy", icon: Network },
      { href: "/history", label: "Transaction History", icon: History },
    ],
  },
  {
    // Built from the report catalogue, so a new report shows up here on its own.
    label: "Reports",
    items: REPORT_DEFS.map((r) => ({
      href: `/reports/${r.id}`,
      label: r.shortTitle,
      icon: r.icon,
    })),
  },
  {
    label: "System",
    items: [
      { href: "/bot-health", label: "Agent Health", icon: Bot },
      {
        href: "/system-log",
        label: "System Log",
        icon: ScrollText,
        roles: ["super_admin", "company_leader"],
      },
      {
        href: "/settings",
        label: "Settings",
        icon: Settings,
        roles: ["super_admin"],
      },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const me = useStore((s) => s.me);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const pendingDeposits = useStore((s) =>
    s.deposits.filter((d) => d.status === "pending").length,
  );
  const pendingWithdrawals = useStore((s) =>
    s.withdrawals.filter(
      (w) => w.status === "requested" || w.status === "credits_pulled",
    ).length,
  );

  // Drop what this role can't open, then any group that empties out — a
  // heading over nothing reads as a broken menu.
  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => !item.roles || (!!me && item.roles.includes(me.role)),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <aside
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* Own scroll container: a long nav scrolls inside the sidebar, leaving
          the footer pinned and the page's own scroll untouched.

          The tall bottom padding is clearance for the agent live-feed button,
          which floats at `bottom-20 left-4` — i.e. over this column, roughly
          30–65px above this container's own bottom edge once the footer is
          accounted for. Without it the last nav item sits underneath and can't
          be clicked. */}
      <div className="min-h-0 flex-1 overflow-y-auto pt-3 pb-20">
        <nav className="flex flex-col gap-1 px-2">
          {groups.map((group, groupIndex) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              {collapsed ? (
                // No room for a heading on the icon rail — a rule keeps the
                // grouping legible without it.
                groupIndex > 0 && (
                  <div className="mx-auto my-2 h-px w-6 bg-sidebar-border" />
                )
              ) : (
                <div
                  className={cn(
                    "px-2.5 pb-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/45 uppercase",
                    groupIndex > 0 && "pt-4",
                  )}
                >
                  {group.label}
                </div>
              )}

              {group.items.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                const count =
                  item.badge === "pending_deposits"
                    ? pendingDeposits
                    : item.badge === "pending_withdrawals"
                      ? pendingWithdrawals
                      : 0;

                if (collapsed) {
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={`${group.label} · ${item.label}`}
                      aria-label={item.label}
                      className={cn(
                        "group relative flex items-center justify-center rounded-md py-2 transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {count > 0 && (
                        <span className="absolute top-0.5 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground">
                          {count > 98 ? "99+" : count}
                        </span>
                      )}
                    </Link>
                  );
                }

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {count > 0 && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </div>
      <div
        className={cn(
          "shrink-0 border-t border-sidebar-border p-3 text-[11px] text-muted-foreground",
          collapsed && "text-center text-[10px]",
        )}
      >
        {collapsed ? (
          <div title="Players Console v1.0 · Option 3 Prototype">v1.0</div>
        ) : (
          <>
            <div>Players Console</div>
            <div className="mt-0.5">v1.0 · Option 3 Prototype</div>
          </>
        )}
      </div>
    </aside>
  );
}

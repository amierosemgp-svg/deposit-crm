"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Wallet,
  Users,
  Banknote,
  ArrowLeftRight,
  History,
  BarChart3,
  Settings,
  Landmark,
  KeyRound,
  ChevronRight,
  Receipt,
  Bot,
  Network,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { REPORT_DEFS } from "@/lib/report-defs";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/deposits", label: "Deposits", icon: Wallet, badge: "pending_deposits" as const },
  { href: "/players", label: "Players", icon: Users },
  { href: "/hierarchy", label: "Organization Hierarchy", icon: Network },
  { href: "/withdrawals", label: "Withdrawals", icon: Banknote, badge: "pending_withdrawals" as const },
  { href: "/bank-accounts", label: "Bank Accounts", icon: Landmark },
  { href: "/provider-accounts", label: "Provider BO Accounts", icon: KeyRound },
  { href: "/bot-health", label: "Bot Health", icon: Bot },
  { href: "/game-transfer", label: "Game Credit Transfer", icon: ArrowLeftRight },
  { href: "/history", label: "Transaction History", icon: History },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/expenses", label: "Expenses", icon: Receipt },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const me = useStore((s) => s.me);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  // null = follow the route (open while inside /reports); true/false = user override.
  const [reportsToggled, setReportsToggled] = useState<boolean | null>(null);
  // Collapsed there is no room for the sub-list — Reports is just an icon.
  const reportsOpen =
    !collapsed && (reportsToggled ?? pathname.startsWith("/reports"));
  const pendingDeposits = useStore((s) =>
    s.deposits.filter((d) => d.status === "pending").length,
  );
  const pendingWithdrawals = useStore((s) =>
    s.withdrawals.filter(
      (w) => w.status === "requested" || w.status === "credits_pulled",
    ).length,
  );

  const items = NAV.filter(
    (item) =>
      (item.href !== "/settings" && item.href !== "/expenses") ||
      me?.role === "super_admin",
  );

  return (
    <aside
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
        collapsed ? "w-16" : "w-60",
      )}
    >
      {/* Own scroll container: a long nav scrolls inside the sidebar, leaving
          the footer pinned and the page's own scroll untouched. */}
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        <nav className="flex flex-col gap-0.5 px-2">
          {items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            const count =
              item.badge === "pending_deposits"
                ? pendingDeposits
                : item.badge === "pending_withdrawals"
                  ? pendingWithdrawals
                  : 0;
            // Collapsed, Reports falls through to the plain icon row below.
            if (item.href === "/reports" && !collapsed) {
              return (
                <div key={item.href}>
                  <div
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md py-2 pr-1 pl-2.5 text-sm font-medium transition-colors",
                      pathname === item.href
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Link
                      href={item.href}
                      className="flex flex-1 items-center gap-2.5"
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="flex-1">{item.label}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => setReportsToggled(!reportsOpen)}
                      aria-label={
                        reportsOpen ? "Collapse reports menu" : "Expand reports menu"
                      }
                      className="cursor-pointer rounded p-1 text-sidebar-foreground/60 hover:text-sidebar-accent-foreground"
                    >
                      <ChevronRight
                        className={cn(
                          "h-3.5 w-3.5 transition-transform",
                          reportsOpen && "rotate-90",
                        )}
                      />
                    </button>
                  </div>
                  {reportsOpen && (
                    <div className="mt-0.5 flex flex-col gap-0.5">
                      {REPORT_DEFS.map((r) => {
                        const subActive = pathname === `/reports/${r.id}`;
                        const SubIcon = r.icon;
                        return (
                          <Link
                            key={r.id}
                            href={`/reports/${r.id}`}
                            className={cn(
                              "flex items-center gap-2 rounded-md py-1.5 pr-2.5 pl-9 text-[13px] transition-colors",
                              subActive
                                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                                : "text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                            )}
                          >
                            <SubIcon className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{r.shortTitle}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            if (collapsed) {
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
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

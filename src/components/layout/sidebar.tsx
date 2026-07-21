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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { REPORT_DEFS } from "@/lib/report-defs";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/deposits", label: "Deposits", icon: Wallet, badge: "pending_deposits" as const },
  { href: "/players", label: "Players", icon: Users },
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
  // null = follow the route (open while inside /reports); true/false = user override.
  const [reportsToggled, setReportsToggled] = useState<boolean | null>(null);
  const reportsOpen = reportsToggled ?? pathname.startsWith("/reports");
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
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex-1 overflow-y-auto py-3">
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
            if (item.href === "/reports") {
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
      <div className="border-t border-sidebar-border p-3 text-[11px] text-muted-foreground">
        <div>Player Deposit CRM</div>
        <div className="mt-0.5">v1.0 · Option 3 Prototype</div>
      </div>
    </aside>
  );
}

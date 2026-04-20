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
  BarChart3,
  Settings,
  Network,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";

const NAV = [
  { href: "/hierarchy", label: "Hierarchy", icon: Network },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/deposits", label: "Deposits", icon: Wallet, badge: "pending_deposits" as const },
  { href: "/players", label: "Players", icon: Users },
  { href: "/withdrawals", label: "Withdrawals", icon: Banknote, badge: "pending_withdrawals" as const },
  { href: "/game-transfer", label: "Game Credit Transfer", icon: ArrowLeftRight },
  { href: "/history", label: "Transaction History", icon: History },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const pendingDeposits = useStore((s) =>
    s.deposits.filter((d) => d.status === "pending").length,
  );
  const pendingWithdrawals = useStore((s) =>
    s.withdrawals.filter(
      (w) => w.status === "requested" || w.status === "credits_pulled",
    ).length,
  );

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex-1 overflow-y-auto py-3">
        <nav className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            const count =
              item.badge === "pending_deposits"
                ? pendingDeposits
                : item.badge === "pending_withdrawals"
                  ? pendingWithdrawals
                  : 0;
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

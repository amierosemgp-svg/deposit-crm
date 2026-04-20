"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Search, Wallet, LogOut, Play } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { COMPANIES, CURRENT_USER } from "@/lib/mock-data";
import { initialsOf, formatRelative } from "@/lib/format";
import { useStore } from "@/lib/store";

export function TopNav() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string>("all");
  const notifications = useStore((s) => s.notifications);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const injectLiveDeposit = useStore((s) => s.injectLiveDeposit);

  return (
    <header className="h-14 shrink-0 border-b border-border bg-card/60 backdrop-blur-sm">
      <div className="flex h-full items-center gap-3 px-4">
        <div className="flex items-center gap-2 pr-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Wallet className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Player Deposit CRM</span>
            <span className="text-[10px] text-muted-foreground">MPG Organization</span>
          </div>
        </div>

        <div className="w-52">
          <Select value={companyId} onValueChange={(v) => setCompanyId(v ?? "all")}>
            <SelectTrigger className="h-9 w-full">
              <SelectValue placeholder="All Companies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Companies</SelectItem>
              {COMPANIES.map((c) => (
                <SelectItem key={c.company_id} value={String(c.company_id)}>
                  {c.company_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search players, transactions, references…"
            className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => injectLiveDeposit()}
            title="Simulate a new bot-detected deposit"
          >
            <Play className="h-3.5 w-3.5" />
            Simulate deposit
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <button
                  {...props}
                  className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  {notifications.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
                  )}
                </button>
              )}
            />
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel className="flex items-center justify-between">
                <span>Notifications</span>
                {notifications.length > 0 && (
                  <button
                    onClick={clearNotifications}
                    className="text-[11px] font-normal text-muted-foreground hover:text-foreground"
                  >
                    Clear all
                  </button>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {notifications.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No new notifications
                </div>
              ) : (
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
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <button
                  {...props}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted"
                >
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="text-[11px]">
                      {initialsOf(CURRENT_USER.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col items-start leading-tight">
                    <span className="text-xs font-medium">
                      {CURRENT_USER.full_name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {CURRENT_USER.role.replace("_", " ")}
                    </span>
                  </div>
                </button>
              )}
            />
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>
                <div className="text-sm">{CURRENT_USER.full_name}</div>
                <div className="text-[11px] font-normal text-muted-foreground">
                  {CURRENT_USER.email}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/login")}>
                <LogOut className="h-4 w-4" />
                Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

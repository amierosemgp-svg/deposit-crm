"use client";

import { useStore } from "@/lib/store";
import { formatDateTime, initialsOf } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/status-badge";
import {
  ArrowRightLeft,
  Banknote,
  Gamepad2,
  Gift,
  Landmark,
  UserRound,
} from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  company_leader: "Company Leader",
  cs_agent: "CS Agent",
  viewer: "Viewer",
};

export default function SettingsPage() {
  const me = useStore((s) => s.me);
  const settings = useStore((s) => s.settings);
  const entityName = useStore((s) => s.entityName);
  const games = useStore((s) => s.games)();
  const banks = useStore((s) => s.banks)();
  const bonusOptions = useStore((s) => s.bonusOptions)();

  const autoConfirmHours = settings.transfer_auto_confirm_hours;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your account and the server-managed system configuration (read-only)
        </p>
      </div>

      {/* Logged-in account */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-3">
          <UserRound className="h-3.5 w-3.5" />
          Logged-in Account
        </div>
        {me ? (
          <div className="flex flex-wrap items-start gap-4">
            <Avatar className="h-12 w-12">
              <AvatarFallback className="text-sm">
                {initialsOf(me.full_name)}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <div className="text-[11px] text-muted-foreground">Name</div>
                <div className="text-sm font-medium">{me.full_name}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  @{me.username}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Role</div>
                <div className="text-sm font-medium">
                  {ROLE_LABELS[me.role] ?? me.role}
                </div>
                <div className="mt-0.5">
                  <StatusBadge status={me.status} />
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Entity</div>
                <div className="text-sm font-medium">{entityName(me.entity_id)}</div>
                {me.email && (
                  <div className="text-[11px] text-muted-foreground">{me.email}</div>
                )}
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Scope</div>
                <div className="text-sm">
                  {me.ownedEntityIds === null
                    ? "All entities"
                    : `${me.ownedEntityIds.length} managed entit${me.ownedEntityIds.length === 1 ? "y" : "ies"}`}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-muted-foreground">Last login</div>
                <div className="text-sm">
                  {me.last_login_at ? formatDateTime(me.last_login_at) : "—"}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading account…</p>
        )}
      </Card>

      {/* System configuration */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Transfer Auto-Confirmation
          </div>
          <div className="text-2xl font-semibold">
            {autoConfirmHours != null ? `${autoConfirmHours} hours` : "—"}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Pending bank transfers are automatically confirmed after this window if
            the recipient takes no action.
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
            <Gift className="h-3.5 w-3.5" />
            Bonus Options
          </div>
          {bonusOptions.length ? (
            <div className="flex flex-wrap gap-1.5">
              {bonusOptions.map((b) => (
                <span
                  key={b}
                  className="inline-flex items-center rounded-full border bg-muted/30 px-2.5 py-1 text-[12px] font-medium tabular-nums"
                >
                  {b}%
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No bonus presets configured.</p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">
            Bonus percentages selectable when approving deposits.
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
            <Gamepad2 className="h-3.5 w-3.5" />
            Games
          </div>
          {games.length ? (
            <div className="flex flex-wrap gap-1.5">
              {games.map((g) => (
                <span
                  key={g}
                  className="inline-flex items-center rounded-full border bg-muted/30 px-2.5 py-1 text-[12px] font-medium"
                >
                  {g}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No games configured.</p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">
            Game providers available for top-ups, transfers, and BO accounts.
          </p>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
            <Landmark className="h-3.5 w-3.5" />
            Banks
          </div>
          {banks.length ? (
            <div className="flex flex-wrap gap-1.5">
              {banks.map((b) => (
                <span
                  key={b}
                  className="inline-flex items-center rounded-full border bg-muted/30 px-2.5 py-1 text-[12px] font-medium"
                >
                  {b}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No banks configured.</p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">
            Recognised banks for entity accounts and player payouts.
          </p>
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-start gap-2 text-[12px] text-muted-foreground">
          <Banknote className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            These values are managed on the server. Contact a super admin to change
            system configuration.
          </span>
        </div>
      </Card>
    </div>
  );
}

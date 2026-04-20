"use client";

import { ORG, COMPANIES, USERS, PLAYERS } from "@/lib/mock-data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initialsOf } from "@/lib/format";
import { Building2, Crown, UserCog, ChevronRight } from "lucide-react";

export default function HierarchyPage() {
  const companyLeaders = USERS.filter((u) => u.role === "company_leader");
  const csAgents = USERS.filter((u) => u.role === "cs_agent");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Organization Hierarchy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {ORG.org_name} → {COMPANIES.length} Companies → {csAgents.length} CS Agents → {PLAYERS.length} Players
        </p>
      </div>

      {/* Organization level */}
      <Card className="border-primary/20">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">{ORG.org_name}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Organization · Super Admin access
            </p>
          </div>
        </CardHeader>
      </Card>

      {/* Companies */}
      <div className="relative pl-6 space-y-4">
        <div className="absolute left-0 top-0 bottom-4 w-px bg-border" />

        {COMPANIES.map((c) => {
          const leader = companyLeaders.find((u) => u.user_id === c.leader_user_id);
          const agents = csAgents.filter((u) => u.company_id === c.company_id);
          const playerCount = PLAYERS.filter((p) => p.company_id === c.company_id).length;

          return (
            <div key={c.company_id} className="relative">
              <div className="absolute left-[-24px] top-6 h-px w-6 bg-border" />
              <Card>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-600">
                      <Crown className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">{c.company_name}</CardTitle>
                      <p className="text-[11px] text-muted-foreground">
                        Led by {leader?.full_name ?? "—"} · {agents.length} agents ·{" "}
                        {playerCount} players
                      </p>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                    {agents.map((a) => {
                      const assignedPlayers = Math.round(playerCount / (agents.length || 1));
                      return (
                        <div
                          key={a.user_id}
                          className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2"
                        >
                          <Avatar className="h-7 w-7">
                            <AvatarFallback className="text-[10px]">
                              {initialsOf(a.full_name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <UserCog className="h-3 w-3 text-muted-foreground shrink-0" />
                              <span className="text-xs font-medium truncate">
                                {a.full_name}
                              </span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              @{a.username} · {assignedPlayers} players
                            </div>
                          </div>
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

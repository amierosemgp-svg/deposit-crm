"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import type { Entity, User, UserRole } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { initialsOf } from "@/lib/format";
import {
  Building2,
  Crown,
  Headset,
  Landmark,
  Plus,
  UserPlus,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Role badges
// ---------------------------------------------------------------------------

const ROLE_BADGE: Record<UserRole, { label: string; cls: string }> = {
  super_admin: { label: "Super Admin", cls: "bg-primary/10 text-primary" },
  company_leader: { label: "Leader", cls: "bg-amber-500/10 text-amber-700" },
  cs_agent: { label: "CS Agent", cls: "bg-blue-500/10 text-blue-700" },
  viewer: { label: "Viewer", cls: "bg-zinc-500/10 text-zinc-600" },
};

function RoleBadge({ role }: { role: UserRole }) {
  const { label, cls } = ROLE_BADGE[role];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${cls}`}
    >
      {label}
    </span>
  );
}

function EntityUserChips({ users }: { users: User[] }) {
  if (users.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
      {users.map((u) => (
        <div
          key={u.user_id}
          className="flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2"
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-[10px]">
              {initialsOf(u.full_name)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{u.full_name}</div>
            <div className="truncate text-[10px] text-muted-foreground">
              @{u.username}
            </div>
          </div>
          <RoleBadge role={u.role} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

type EntityDialogState = {
  parentId: number;
  parentName: string;
  entityType: "leader" | "company" | "cs";
} | null;

type UserDialogState = {
  entityId: number;
  entityName: string;
  role: "company_leader" | "cs_agent" | "viewer";
} | null;

const ENTITY_TYPE_LABEL: Record<"leader" | "company" | "cs", string> = {
  leader: "Leader",
  company: "Company",
  cs: "CS Desk",
};

function AddEntityDialog({
  state,
  onClose,
}: {
  state: EntityDialogState;
  onClose: () => void;
}) {
  const addEntity = useStore((s) => s.addEntity);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const open = state !== null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !name.trim() || busy) return;
    setBusy(true);
    const res = await addEntity({
      parent_entity_id: state.parentId,
      entity_type: state.entityType,
      name: name.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create entity");
      return;
    }
    toast.success(`${ENTITY_TYPE_LABEL[state.entityType]} created`);
    setName("");
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogTitle>
          {state ? `Add ${ENTITY_TYPE_LABEL[state.entityType]}` : "Add"}
        </DialogTitle>
        {state && (
          <p className="text-xs text-muted-foreground -mt-2">
            Under <span className="font-medium text-foreground">{state.parentName}</span>
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="entity-name">
              Name <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="entity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                state?.entityType === "leader"
                  ? "Leader Alpha"
                  : state?.entityType === "company"
                    ? "Company A1"
                    : "CS Desk 1"
              }
              autoFocus
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || busy}
              className="cursor-pointer"
            >
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_USER_FORM = {
  username: "",
  email: "",
  full_name: "",
  password: "",
};

function AddUserDialog({
  state,
  onClose,
}: {
  state: UserDialogState;
  onClose: () => void;
}) {
  const addUser = useStore((s) => s.addUser);
  const [form, setForm] = useState(EMPTY_USER_FORM);
  const [busy, setBusy] = useState(false);
  const open = state !== null;

  const isValid =
    form.username.trim() &&
    form.email.trim() &&
    form.full_name.trim() &&
    form.password.length >= 6;

  function update<K extends keyof typeof EMPTY_USER_FORM>(
    key: K,
    value: string,
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    setForm(EMPTY_USER_FORM);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!state || !isValid || busy) return;
    setBusy(true);
    const res = await addUser({
      username: form.username.trim(),
      email: form.email.trim(),
      full_name: form.full_name.trim(),
      password: form.password,
      role: state.role,
      entity_id: state.entityId,
    });
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to create user");
      return;
    }
    toast.success(`User created — ${ROLE_BADGE[state.role].label}`);
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Add User</DialogTitle>
        {state && (
          <p className="text-xs text-muted-foreground -mt-2 flex items-center gap-1.5">
            Attached to{" "}
            <span className="font-medium text-foreground">{state.entityName}</span>
            <RoleBadge role={state.role} />
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="user-username">
                Username <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="user-username"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder="jdoe"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="user-fullname">
                Full name <span className="text-rose-600">*</span>
              </Label>
              <Input
                id="user-fullname"
                value={form.full_name}
                onChange={(e) => update("full_name", e.target.value)}
                placeholder="John Doe"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-email">
              Email <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="user-email"
              type="email"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="john@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-password">
              Password <span className="text-rose-600">*</span>
            </Label>
            <Input
              id="user-password"
              type="password"
              value={form.password}
              onChange={(e) => update("password", e.target.value)}
              placeholder="Min. 6 characters"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || busy}
              className="cursor-pointer"
            >
              {busy ? "Creating…" : "Create user"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function NodeActionButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 cursor-pointer gap-1 px-2 text-xs"
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

export default function HierarchyPage() {
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const users = useStore((s) => s.users);
  const players = useStore((s) => s.players);

  const [entityDialog, setEntityDialog] = useState<EntityDialogState>(null);
  const [userDialog, setUserDialogState] = useState<UserDialogState>(null);

  const byParent = useMemo(() => {
    const map = new Map<number, Entity[]>();
    for (const e of entities) {
      if (e.parent_entity_id == null) continue;
      const list = map.get(e.parent_entity_id) ?? [];
      list.push(e);
      map.set(e.parent_entity_id, list);
    }
    return map;
  }, [entities]);

  const usersByEntity = useMemo(() => {
    const map = new Map<number, User[]>();
    for (const u of users) {
      const list = map.get(u.entity_id) ?? [];
      list.push(u);
      map.set(u.entity_id, list);
    }
    return map;
  }, [users]);

  const playerCountByCompany = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of players) {
      map.set(
        p.company_entity_id,
        (map.get(p.company_entity_id) ?? 0) + 1,
      );
    }
    return map;
  }, [players]);

  const main = entities.find((e) => e.entity_type === "main_company");
  const leaders = main
    ? (byParent.get(main.entity_id) ?? []).filter(
        (e) => e.entity_type === "leader",
      )
    : [];
  const companyCount = entities.filter((e) => e.entity_type === "company").length;

  // --- permissions ---
  const isSuper = me?.role === "super_admin";
  const isLeader = me?.role === "company_leader";
  const canAddCompanyOn = (leaderId: number) =>
    isSuper || (isLeader && me?.entity_id === leaderId);
  const canAddCsOn = (company: Entity) =>
    isSuper || (isLeader && company.parent_entity_id === me?.entity_id);
  const canAddUserOn = (entity: Entity) => {
    if (isSuper) return true;
    if (isLeader && entity.entity_type === "cs") {
      const company = entities.find(
        (e) => e.entity_id === entity.parent_entity_id,
      );
      return company?.parent_entity_id === me?.entity_id;
    }
    return false;
  };
  const derivedRole = (
    entity: Entity,
  ): "company_leader" | "cs_agent" | "viewer" =>
    entity.entity_type === "leader"
      ? "company_leader"
      : entity.entity_type === "cs"
        ? "cs_agent"
        : "viewer";

  const openAddUser = (entity: Entity) =>
    setUserDialogState({
      entityId: entity.entity_id,
      entityName: entity.name,
      role: derivedRole(entity),
    });

  if (!hydrated) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Organization Hierarchy</h1>
          <p className="text-sm text-muted-foreground mt-1">Loading…</p>
        </div>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!main) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Organization Hierarchy</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Leaders, companies and CS desks in your organization
          </p>
        </div>
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No organization data yet — the main company will appear here once
            the server is initialized.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Organization Hierarchy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {main.name} → {leaders.length}{" "}
          {leaders.length === 1 ? "Leader" : "Leaders"} → {companyCount}{" "}
          {companyCount === 1 ? "Company" : "Companies"} → {players.length}{" "}
          {players.length === 1 ? "Player" : "Players"}
        </p>
      </div>

      {/* Main company */}
      <Card className="border-primary/20">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{main.name}</CardTitle>
            <p className="text-xs text-muted-foreground">
              Main Company · Super Admin access
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {isSuper && (
              <>
                <NodeActionButton
                  label="Leader"
                  icon={Plus}
                  onClick={() =>
                    setEntityDialog({
                      parentId: main.entity_id,
                      parentName: main.name,
                      entityType: "leader",
                    })
                  }
                />
                <NodeActionButton
                  label="Add User"
                  icon={UserPlus}
                  onClick={() => openAddUser(main)}
                />
              </>
            )}
          </div>
        </CardHeader>
        {(usersByEntity.get(main.entity_id) ?? []).length > 0 && (
          <CardContent className="pt-0">
            <EntityUserChips users={usersByEntity.get(main.entity_id) ?? []} />
          </CardContent>
        )}
      </Card>

      {/* Leaders */}
      {leaders.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No leaders yet
            {isSuper && " — use the “+ Leader” button above to create the first one"}
            .
          </CardContent>
        </Card>
      ) : (
        <div className="relative pl-6 space-y-4">
          <div className="absolute left-0 top-0 bottom-4 w-px bg-border" />

          {leaders.map((leader) => {
            const leaderCompanies = (byParent.get(leader.entity_id) ?? []).filter(
              (e) => e.entity_type === "company",
            );
            const leaderUsers = usersByEntity.get(leader.entity_id) ?? [];

            return (
              <div key={leader.entity_id} className="relative">
                <div className="absolute left-[-24px] top-6 h-px w-6 bg-border" />
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/10 text-amber-600">
                        <Crown className="h-4 w-4" />
                      </div>
                      <div>
                        <CardTitle className="text-sm">{leader.name}</CardTitle>
                        <p className="text-[11px] text-muted-foreground">
                          Leader · {leaderCompanies.length}{" "}
                          {leaderCompanies.length === 1 ? "company" : "companies"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {canAddCompanyOn(leader.entity_id) && (
                        <NodeActionButton
                          label="Company"
                          icon={Plus}
                          onClick={() =>
                            setEntityDialog({
                              parentId: leader.entity_id,
                              parentName: leader.name,
                              entityType: "company",
                            })
                          }
                        />
                      )}
                      {isSuper && (
                        <NodeActionButton
                          label="Add User"
                          icon={UserPlus}
                          onClick={() => openAddUser(leader)}
                        />
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    {leaderUsers.length > 0 && (
                      <EntityUserChips users={leaderUsers} />
                    )}

                    {leaderCompanies.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No companies under this leader yet.
                      </p>
                    ) : (
                      <div className="relative pl-5 space-y-3">
                        <div className="absolute left-0 top-0 bottom-3 w-px bg-border" />
                        {leaderCompanies.map((company) => {
                          const csDesks = (
                            byParent.get(company.entity_id) ?? []
                          ).filter((e) => e.entity_type === "cs");
                          const companyUsers =
                            usersByEntity.get(company.entity_id) ?? [];
                          const playerCount =
                            playerCountByCompany.get(company.entity_id) ?? 0;

                          return (
                            <div key={company.entity_id} className="relative">
                              <div className="absolute left-[-20px] top-5 h-px w-5 bg-border" />
                              <div className="rounded-lg border bg-card">
                                <div className="flex items-start justify-between gap-2 px-3.5 py-3">
                                  <div className="flex items-center gap-2.5">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-600">
                                      <Landmark className="h-4 w-4" />
                                    </div>
                                    <div>
                                      <div className="text-sm font-medium">
                                        {company.name}
                                      </div>
                                      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                                        <Users className="h-3 w-3" />
                                        {playerCount}{" "}
                                        {playerCount === 1 ? "player" : "players"}{" "}
                                        · {csDesks.length}{" "}
                                        {csDesks.length === 1
                                          ? "CS desk"
                                          : "CS desks"}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    {canAddCsOn(company) && (
                                      <NodeActionButton
                                        label="CS Desk"
                                        icon={Plus}
                                        onClick={() =>
                                          setEntityDialog({
                                            parentId: company.entity_id,
                                            parentName: company.name,
                                            entityType: "cs",
                                          })
                                        }
                                      />
                                    )}
                                    {isSuper && (
                                      <NodeActionButton
                                        label="Add User"
                                        icon={UserPlus}
                                        onClick={() => openAddUser(company)}
                                      />
                                    )}
                                  </div>
                                </div>

                                {(companyUsers.length > 0 ||
                                  csDesks.length > 0) && (
                                  <div className="space-y-2.5 border-t px-3.5 py-3">
                                    {companyUsers.length > 0 && (
                                      <EntityUserChips users={companyUsers} />
                                    )}
                                    {csDesks.map((cs) => {
                                      const csUsers =
                                        usersByEntity.get(cs.entity_id) ?? [];
                                      return (
                                        <div
                                          key={cs.entity_id}
                                          className="rounded-md border bg-muted/20"
                                        >
                                          <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                                            <div className="flex items-center gap-2">
                                              <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-500/10 text-emerald-600">
                                                <Headset className="h-3.5 w-3.5" />
                                              </div>
                                              <span className="text-xs font-medium">
                                                {cs.name}
                                              </span>
                                              <span className="text-[10px] text-muted-foreground">
                                                CS Desk · {csUsers.length}{" "}
                                                {csUsers.length === 1
                                                  ? "agent"
                                                  : "agents"}
                                              </span>
                                            </div>
                                            {canAddUserOn(cs) && (
                                              <NodeActionButton
                                                label="Add User"
                                                icon={UserPlus}
                                                onClick={() => openAddUser(cs)}
                                              />
                                            )}
                                          </div>
                                          {csUsers.length > 0 && (
                                            <div className="border-t px-2.5 py-2">
                                              <EntityUserChips users={csUsers} />
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      <AddEntityDialog
        state={entityDialog}
        onClose={() => setEntityDialog(null)}
      />
      <AddUserDialog
        state={userDialog}
        onClose={() => setUserDialogState(null)}
      />
    </div>
  );
}

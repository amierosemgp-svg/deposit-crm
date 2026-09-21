"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import type { Entity, LeaderMembership, User, UserRole } from "@/lib/types";
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
  Loader2,
  Pencil,
  Plus,
  Shuffle,
  Star,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Role badges
// ---------------------------------------------------------------------------

const ROLE_BADGE: Record<UserRole, { label: string; cls: string }> = {
  super_admin: { label: "Super Admin", cls: "bg-primary/10 text-primary" },
  company_leader: { label: "Leader", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  cs_agent: { label: "CS Agent", cls: "bg-blue-500/10 text-blue-700 dark:text-blue-300" },
  viewer: { label: "Viewer", cls: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" },
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

/**
 * The logins on an entity, with a way to take one away.
 *
 * Removing is offered to the super admin only, and never on their own account —
 * the server enforces both, plus the rule that the last super admin cannot go.
 * Deleting the only login on a CS desk removes the empty desk with it, which is
 * why that case is spelled out in the confirmation.
 */
function EntityUserChips({
  users,
  entityId,
  onRemove,
  onEditCompanies,
}: {
  users: User[];
  /**
   * The entity these chips are drawn under.
   *
   * A leader shows on every company they hold, so "remove" has to know which
   * card it was clicked from — taking them off this company is a different act
   * from deleting their login.
   */
  entityId: number;
  onRemove?: (u: User, fromEntityId: number) => void;
  /** Offered on leaders: which companies they hold. */
  onEditCompanies?: (u: User) => void;
}) {
  if (users.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
      {users.map((u) => (
        <div
          key={u.user_id}
          className="group flex items-center gap-2 rounded-md border bg-muted/20 px-2.5 py-2"
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
          {onEditCompanies && u.role === "company_leader" && (
            <button
              type="button"
              aria-label={`Companies held by ${u.username}`}
              title={`Companies held by ${u.username}`}
              onClick={() => onEditCompanies(u)}
              className="cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-amber-400"
            >
              <Building2 className="h-3.5 w-3.5" />
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${u.username}`}
              title={`Remove ${u.username}`}
              onClick={() => onRemove(u, entityId)}
              className="cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
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
  /**
   * Main-company accounts are the operator's own logins — username and
   * password and nothing else. Asking for an email produced invented ones,
   * which in a unique column is a collision waiting to happen.
   */
  isMain: boolean;
} | null;

/**
 * The levels, in the words the operator uses. A "leader" entity is the company
 * that owns casinos — AB (Abdullah Club) — and its partners are logins on it;
 * a "company" entity is one casino, Pokercity. The column names keep the old
 * words because the database does; only the screen changes.
 */
const ENTITY_TYPE_LABEL: Record<"leader" | "company" | "cs", string> = {
  leader: "Company",
  company: "Casino",
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
              Name <span className="text-rose-600 dark:text-rose-400">*</span>
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
    (state?.isMain || form.full_name.trim()) &&
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
      // Omitted, not blanked: the server derives both from the username for a
      // main-company account, and rejects an empty string for anyone else.
      ...(state.isMain
        ? {}
        : { full_name: form.full_name.trim() }),
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
        {/* Named for what is being created, matching the button that opened it. */}
        <DialogTitle>
          {state ? `Add New ${ROLE_BADGE[state.role].label}` : "Add User"}
        </DialogTitle>
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
                Username <span className="text-rose-600 dark:text-rose-400">*</span>
              </Label>
              <Input
                id="user-username"
                value={form.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder="jdoe"
                autoFocus
              />
            </div>
            {!state?.isMain && (
              <div className="space-y-1.5">
                <Label htmlFor="user-fullname">
                  Full name <span className="text-rose-600 dark:text-rose-400">*</span>
                </Label>
                <Input
                  id="user-fullname"
                  value={form.full_name}
                  onChange={(e) => update("full_name", e.target.value)}
                  placeholder="John Doe"
                />
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-password">
              Password <span className="text-rose-600 dark:text-rose-400">*</span>
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

/** Opens the entity edit page (rename / activate / deactivate). */
function EditEntityLink({ entity }: { entity: Entity }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 cursor-pointer gap-1 px-2 text-xs"
      // It renders an <a>, not a <button> — without this Base UI keeps the
      // native-button semantics and warns.
      nativeButton={false}
      render={<Link href={`/hierarchy/${entity.entity_id}`} />}
    >
      <Pencil className="h-3.5 w-3.5" />
      Edit
    </Button>
  );
}

/** Only drawn for retired nodes — "active" is the unremarkable default. */
function InactiveTag({ entity }: { entity: Entity }) {
  if (entity.status === "active") return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:text-zinc-400">
      Inactive
    </span>
  );
}

export default function HierarchyPage() {
  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const companyLeaders = useStore((s) => s.companyLeaders);
  const users = useStore((s) => s.users);
  const playerCounts = useStore((s) => s.playerCounts);
  const leaderMemberships = useStore((s) => s.leaderMemberships);

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

  // Counted by the server — one grouped query, rather than shipping every
  // member to be tallied in the browser.
  /** user_id → the companies they have been granted beyond their own. */
  const grantedCompanies = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const m of leaderMemberships) {
      const set = map.get(m.user_id) ?? new Set<number>();
      set.add(m.leader_entity_id);
      map.set(m.user_id, set);
    }
    return map;
  }, [leaderMemberships]);

  const playerCountByCompany = useMemo(
    () => new Map(playerCounts.map((c) => [c.company_entity_id, c.members])),
    [playerCounts],
  );
  const playerTotal = useMemo(
    () => playerCounts.reduce((n, c) => n + c.members, 0),
    [playerCounts],
  );

  /**
   * Every main company, not just the first one.
   *
   * This page took `entities.find(main_company)` and drew that one tree. With
   * a single main company that was indistinguishable from correct; the moment
   * a second one existed its leaders, companies, desks and players vanished
   * from the page entirely while still being in the database — the company
   * filter in the top bar listed them, and the org chart did not.
   */
  /**
   * Companies by leader, read from the ownership record rather than the tree.
   *
   * A company can be run by two leaders at once, and `parent_entity_id` names
   * only the primary — drawing from it alone hides the second leader's half of
   * the org chart while they can plainly see the company's players.
   */
  const companiesByLeader = useMemo(() => {
    const byId = new Map(entities.map((e) => [e.entity_id, e]));
    const m = new Map<number, { company: Entity; primary: boolean }[]>();
    for (const row of companyLeaders) {
      const company = byId.get(row.company_entity_id);
      if (!company || company.entity_type !== "company") continue;
      const list = m.get(row.leader_entity_id) ?? [];
      list.push({ company, primary: row.is_primary });
      m.set(row.leader_entity_id, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.company.name.localeCompare(b.company.name));
    }
    return m;
  }, [entities, companyLeaders]);

  /** How many leaders run this company — >1 gets a "shared" marker. */
  const leaderCountOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of companyLeaders) {
      m.set(r.company_entity_id, (m.get(r.company_entity_id) ?? 0) + 1);
    }
    return m;
  }, [companyLeaders]);

  const [ownerDialog, setOwnerDialog] = useState<Entity | null>(null);
  /** Editing one company's whole list of casinos, from the company's side. */
  const [companyCasinosDialog, setCompanyCasinosDialog] = useState<Entity | null>(null);
  const [restructure, setRestructure] = useState<Entity | null>(null);
  /** The login the super admin has asked to remove, pending confirmation. */
  const [removing, setRemoving] = useState<{ user: User; fromEntityId: number } | null>(
    null,
  );
  /** The leader whose list of companies is being edited. */
  const [leaderCompanies, setLeaderCompanies] = useState<User | null>(null);

  const mains = entities
    .filter((e) => e.entity_type === "main_company")
    .sort((a, b) => a.entity_id - b.entity_id);
  const leadersOf = (mainId: number) =>
    (byParent.get(mainId) ?? []).filter((e) => e.entity_type === "leader");
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
  /** Mirror of assertCanEdit in /api/entities/[id]. */
  const canEditEntity = (entity: Entity) => {
    if (!me || me.role === "viewer" || me.role === "cs_agent") return false;
    if (isSuper) return true;
    if (entity.entity_id === me.entity_id) return true;
    if (entity.entity_type === "company") {
      return entity.parent_entity_id === me.entity_id;
    }
    if (entity.entity_type === "cs") {
      const company = entities.find(
        (e) => e.entity_id === entity.parent_entity_id,
      );
      return company?.parent_entity_id === me.entity_id;
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

  /**
   * What the button makes, in the words the screen uses.
   *
   * Derived from derivedRole rather than written per button, so the label can
   * never promise one thing while the form submits another: a company takes a
   * Leader, a CS desk takes a CS agent, and a casino or the group takes a
   * read-only Viewer.
   */
  const addUserLabel = (entity: Entity) =>
    ({
      company_leader: "Add Leader",
      cs_agent: "Add CS",
      viewer: "Add Viewer",
    })[derivedRole(entity)];

  const openAddUser = (entity: Entity) =>
    setUserDialogState({
      entityId: entity.entity_id,
      entityName: entity.name,
      role: derivedRole(entity),
      isMain: entity.entity_type === "main_company",
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

  /**
   * Not for the desk. Hidden from the menu too; this is the guard for anyone
   * who types the URL, and it comes before the empty-state below — a CS agent
   * is no longer sent a main company, so without it they would land on "no
   * organization data yet" and reasonably read it as something being broken.
   */
  if (me?.role === "cs_agent") {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Organization Hierarchy</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Leaders, companies and CS desks in your organization
          </p>
        </div>
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            This page is for company leaders and admins.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!mains.length) {
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
          {mains.length}{" "}
          {mains.length === 1 ? "Main Company" : "Main Companies"} →{" "}
          {mains.reduce((n, m) => n + leadersOf(m.entity_id).length, 0)}{" "}
          Leaders → {companyCount}{" "}
          {companyCount === 1 ? "Company" : "Companies"} → {playerTotal}{" "}
          {playerTotal === 1 ? "Player" : "Players"}
        </p>
      </div>

      {/* One block per main company. Each is a separate organisation: its own
          leaders, companies and desks, rendered as its own tree. */}
      {mains.map((main) => {
        const leaders = leadersOf(main.entity_id);
        return (
          <div key={main.entity_id} className="space-y-4">
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
                {canEditEntity(main) && <EditEntityLink entity={main} />}
                {isSuper && (
                  <>
                    <NodeActionButton
                      label="Company"
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
                      label={addUserLabel(main)}
                      icon={UserPlus}
                      onClick={() => openAddUser(main)}
                    />
                  </>
                )}
              </div>
            </CardHeader>
            {(usersByEntity.get(main.entity_id) ?? []).length > 0 && (
              <CardContent className="pt-0">
                <EntityUserChips
                  users={usersByEntity.get(main.entity_id) ?? []}
                  entityId={main.entity_id}
                  onRemove={
                    isSuper ? (u, fromEntityId) => setRemoving({ user: u, fromEntityId }) : undefined
                  }
                  onEditCompanies={isSuper ? setLeaderCompanies : undefined}
                />
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
                const owned = companiesByLeader.get(leader.entity_id) ?? [];
                const leaderCompanies = owned.map((o) => o.company);
                /**
                 * Everyone who leads this company: those created under it, plus
                 * anyone granted it since. One person can lead several.
                 */
                const leaderUsers = [
                  ...(usersByEntity.get(leader.entity_id) ?? []),
                  ...users.filter(
                    (u) =>
                      u.entity_id !== leader.entity_id &&
                      grantedCompanies.get(u.user_id)?.has(leader.entity_id),
                  ),
                ];

                return (
                  <div key={leader.entity_id} className="relative">
                    <div className="absolute left-[-24px] top-6 h-px w-6 bg-border" />
                    <Card>
                      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            <Crown className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <CardTitle className="text-sm">{leader.name}</CardTitle>
                              <InactiveTag entity={leader} />
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              Company · {leaderCompanies.length}{" "}
                              {leaderCompanies.length === 1 ? "casino" : "casinos"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {canEditEntity(leader) && <EditEntityLink entity={leader} />}
                          {canAddCompanyOn(leader.entity_id) && (
                            <NodeActionButton
                              label="Casino"
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
                              label={addUserLabel(leader)}
                              icon={UserPlus}
                              onClick={() => openAddUser(leader)}
                            />
                          )}
                          {isSuper && (
                            <NodeActionButton
                              label="Casinos"
                              icon={Building2}
                              onClick={() => setCompanyCasinosDialog(leader)}
                            />
                          )}
                          {isSuper && leaders.length > 1 && (
                            <NodeActionButton
                              label="Restructure"
                              icon={Shuffle}
                              onClick={() => setRestructure(leader)}
                            />
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="pt-0 space-y-3">
                        {leaderUsers.length > 0 && (
                          <EntityUserChips
                            users={leaderUsers}
                            entityId={leader.entity_id}
                            onRemove={
                              isSuper ? (u, fromEntityId) => setRemoving({ user: u, fromEntityId }) : undefined
                            }
                  onEditCompanies={isSuper ? setLeaderCompanies : undefined}
                          />
                        )}

                        {leaderCompanies.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            No casinos under this company yet.
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
                                        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
                                          <Landmark className="h-4 w-4" />
                                        </div>
                                        <div>
                                          <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium">
                                              {company.name}
                                            </span>
                                            <InactiveTag entity={company} />
                                            {(leaderCountOf.get(company.entity_id) ?? 1) > 1 && (
                                              <span
                                                title="Run by more than one company — it appears under each of them"
                                                className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300"
                                              >
                                                Shared ×{leaderCountOf.get(company.entity_id)}
                                              </span>
                                            )}
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
                                        {canEditEntity(company) && (
                                          <EditEntityLink entity={company} />
                                        )}
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
                                            label="Companies"
                                            icon={Crown}
                                            onClick={() => setOwnerDialog(company)}
                                          />
                                        )}
                                        {isSuper && (
                                          <NodeActionButton
                                            label={addUserLabel(company)}
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
                                          <EntityUserChips
                                          users={companyUsers}
                                          entityId={company.entity_id}
                                          onRemove={
                              isSuper ? (u, fromEntityId) => setRemoving({ user: u, fromEntityId }) : undefined
                            }
                  onEditCompanies={isSuper ? setLeaderCompanies : undefined}
                                        />
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
                                                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                                                    <Headset className="h-3.5 w-3.5" />
                                                  </div>
                                                  <span className="text-xs font-medium">
                                                    {cs.name}
                                                  </span>
                                                  <InactiveTag entity={cs} />
                                                  <span className="text-[10px] text-muted-foreground">
                                                    CS Desk · {csUsers.length}{" "}
                                                    {csUsers.length === 1
                                                      ? "agent"
                                                      : "agents"}
                                                  </span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                  {canEditEntity(cs) && (
                                                    <EditEntityLink entity={cs} />
                                                  )}
                                                  {canAddUserOn(cs) && (
                                                    <NodeActionButton
                                                      label={addUserLabel(cs)}
                                                      icon={UserPlus}
                                                      onClick={() => openAddUser(cs)}
                                                    />
                                                  )}
                                                </div>
                                              </div>
                                              {csUsers.length > 0 && (
                                                <div className="border-t px-2.5 py-2">
                                                  <EntityUserChips
                                                  users={csUsers}
                                                  entityId={cs.entity_id}
                                                  onRemove={
                              isSuper ? (u, fromEntityId) => setRemoving({ user: u, fromEntityId }) : undefined
                            }
                  onEditCompanies={isSuper ? setLeaderCompanies : undefined}
                                                />
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
          </div>
        );
      })}

      {ownerDialog && (
        <CompanyLeadersDialog
          company={ownerDialog}
          onClose={() => setOwnerDialog(null)}
        />
      )}
      {companyCasinosDialog && (
        <CompanyCasinosDialog
          company={companyCasinosDialog}
          onClose={() => setCompanyCasinosDialog(null)}
        />
      )}
      {leaderCompanies && (
        <LeaderCompaniesDialog
          leader={leaderCompanies}
          onClose={() => setLeaderCompanies(null)}
        />
      )}
      {removing && (
        <RemoveUserDialog
          user={removing.user}
          fromEntityId={removing.fromEntityId}
          entities={entities}
          users={users}
          leaderMemberships={leaderMemberships}
          onClose={() => setRemoving(null)}
        />
      )}
      {restructure && (
        <RestructureLeaderDialog
          leader={restructure}
          onClose={() => setRestructure(null)}
        />
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


// ---------------------------------------------------------------------------
// Who runs a company
// ---------------------------------------------------------------------------

/**
 * Add or remove the leaders running one company, and pick which of them the
 * hierarchy draws it under.
 *
 * Removing the last leader is refused by the server, not hidden here: the
 * button stays visible with the reason, because a disabled control with no
 * explanation reads as a bug rather than a rule.
 */
/**
 * The casinos one company runs — CompanyLeadersDialog from the other end.
 *
 * Mind the vocabulary: on screen a `leader` entity is a COMPANY (ICON, Abdullah
 * Club) and a `company` entity is a CASINO (Pokercity). The table is called
 * company_leaders because the database kept the old words; see
 * ENTITY_TYPE_LABEL.
 *
 * The relationship is many-to-many both ways: a casino can be run by more than
 * one company, and a company runs as many casinos as it likes. It could only be
 * edited casino by casino before, so putting one company over five casinos
 * meant opening five dialogs. This edits the company's whole list at once.
 *
 * A casino is offered whatever it currently sits under: ownership is what this
 * table records, not the parent it was created beneath.
 */
function CompanyCasinosDialog({
  company,
  onClose,
}: {
  /** A `leader` entity — a COMPANY on screen. */
  company: Entity;
  onClose: () => void;
}) {
  const entities = useStore((s) => s.entities);
  const companyLeaders = useStore((s) => s.companyLeaders);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const current = companyLeaders.filter((r) => r.leader_entity_id === company.entity_id);
  const currentIds = new Set(current.map((r) => r.company_entity_id));
  const available = entities.filter(
    (e) =>
      e.entity_type === "company" && e.status === "active" && !currentIds.has(e.entity_id),
  );

  async function act(
    action: "assign" | "end" | "set_primary",
    casinoId: number,
    key: string,
  ) {
    setBusy(key);
    try {
      const res = await fetch("/api/company-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          company_entity_id: casinoId,
          leader_entity_id: company.entity_id,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Could not change which casinos this company runs");
        return;
      }
      await refresh();
      if (action === "assign") setAdding("");
      toast.success(
        action === "assign"
          ? "Casino added"
          : action === "end"
            ? "Casino removed"
            : "Set as the primary company",
      );
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Casinos run by {company.name}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          A company runs any number of casinos, and a casino can be run by more than
          one company. Primary decides which company it appears under in the tree.
        </p>

        <div className="mt-3 space-y-2">
          {current.map((row) => {
            const casino = entities.find((e) => e.entity_id === row.company_entity_id);
            return (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm">
                    {casino?.name ?? `#${row.company_entity_id}`}
                  </span>
                  {row.is_primary && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      Primary
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!row.is_primary && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Make this company the primary for that casino"
                      className="h-7 cursor-pointer px-2"
                      disabled={busy !== null}
                      onClick={() => act("set_primary", row.company_entity_id, `p${row.id}`)}
                    >
                      {busy === `p${row.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Star className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Take this casino off the company"
                    className="h-7 cursor-pointer px-2 text-destructive"
                    disabled={busy !== null}
                    onClick={() => act("end", row.company_entity_id, `e${row.id}`)}
                  >
                    {busy === `e${row.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
          {current.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              This company runs no casinos yet.
            </p>
          )}
        </div>

        {available.length > 0 && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>Add a casino</Label>
              <select
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Pick a casino…</option>
                {available.map((c) => (
                  <option key={c.entity_id} value={String(c.entity_id)}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              className="cursor-pointer"
              disabled={!adding || busy !== null}
              onClick={() => act("assign", Number(adding), "add")}
            >
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompanyLeadersDialog({
  company,
  onClose,
}: {
  company: Entity;
  onClose: () => void;
}) {
  const entities = useStore((s) => s.entities);
  const companyLeaders = useStore((s) => s.companyLeaders);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const current = companyLeaders.filter(
    (r) => r.company_entity_id === company.entity_id,
  );
  const currentIds = new Set(current.map((r) => r.leader_entity_id));
  const leaders = entities.filter(
    (e) => e.entity_type === "leader" && e.status === "active",
  );
  const available = leaders.filter((l) => !currentIds.has(l.entity_id));

  async function act(
    action: "assign" | "end" | "set_primary",
    leaderId: number,
    key: string,
  ) {
    setBusy(key);
    try {
      const res = await fetch("/api/company-leaders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          company_entity_id: company.entity_id,
          leader_entity_id: leaderId,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Could not change who runs this casino");
        return;
      }
      await refresh();
      if (action === "assign") setAdding("");
      toast.success(
        action === "assign"
          ? "Company added"
          : action === "end"
            ? "Company removed"
            : "Primary company set",
      );
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Companies running {company.name}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Each of these can see and act on this casino. The primary is the one it
          appears under in the hierarchy.
        </p>

        <div className="mt-3 space-y-2">
          {current.map((row) => {
            const leader = entities.find((e) => e.entity_id === row.leader_entity_id);
            return (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Crown className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  <span className="text-sm">{leader?.name ?? `#${row.leader_entity_id}`}</span>
                  {row.is_primary && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                      Primary
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!row.is_primary && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 cursor-pointer px-2"
                      disabled={busy !== null}
                      onClick={() => act("set_primary", row.leader_entity_id, `p${row.id}`)}
                    >
                      {busy === `p${row.id}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Star className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 cursor-pointer px-2 text-destructive"
                    disabled={busy !== null}
                    onClick={() => act("end", row.leader_entity_id, `e${row.id}`)}
                  >
                    {busy === `e${row.id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
          {current.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No company runs this casino.
            </p>
          )}
        </div>

        {available.length > 0 && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>Add a company</Label>
              <select
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Pick a company…</option>
                {available.map((l) => (
                  <option key={l.entity_id} value={String(l.entity_id)}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              className="cursor-pointer"
              disabled={!adding || busy !== null}
              onClick={() => act("assign", Number(adding), "add")}
            >
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button variant="outline" className="cursor-pointer" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which companies a leader holds.
 *
 * A leader is a person; a company is Abdullah Club or ICON (a `leader` entity
 * in the database). One person can hold several — Tiong can lead Abdullah Club
 * and ICON — and everything they see follows: the casinos those companies run,
 * their banks, their reports, for the dates each company actually owned them.
 *
 * The company they were created under is always theirs and cannot be taken away
 * here; moving that is a different operation with different consequences.
 */
function LeaderCompaniesDialog({
  leader,
  onClose,
}: {
  leader: User;
  onClose: () => void;
}) {
  const entities = useStore((s) => s.entities);
  const leaderMemberships = useStore((s) => s.leaderMemberships);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState("");

  const granted = leaderMemberships
    .filter((m) => m.user_id === leader.user_id)
    .map((m) => m.leader_entity_id);
  const held = [...new Set([leader.entity_id, ...granted])];
  const companies = entities.filter((e) => e.entity_type === "leader");
  const available = companies.filter(
    (c) => c.status === "active" && !held.includes(c.entity_id),
  );

  async function act(action: "grant" | "revoke", entityId: number, key: string) {
    setBusy(key);
    try {
      const res = await fetch(`/api/users/${leader.user_id}/companies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, leader_entity_id: entityId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Could not change which companies they hold");
        return;
      }
      await refresh();
      if (action === "grant") setAdding("");
      toast.success(action === "grant" ? "Company added" : "Company removed");
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Companies led by {leader.full_name}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          A leader can hold more than one company. They see every casino those
          companies run, and their reports cover each company for the dates it
          actually owned it.
        </p>

        <div className="mt-3 space-y-2">
          {held.map((entityId) => {
            const company = entities.find((e) => e.entity_id === entityId);
            const isHome = entityId === leader.entity_id;
            return (
              <div
                key={entityId}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Crown className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  <span className="text-sm">{company?.name ?? `#${entityId}`}</span>
                  {isHome && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Created under
                    </span>
                  )}
                </div>
                {!isHome && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Take this company off them"
                    className="h-7 cursor-pointer px-2 text-destructive"
                    disabled={busy !== null}
                    onClick={() => act("revoke", entityId, `r${entityId}`)}
                  >
                    {busy === `r${entityId}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </div>

        {available.length > 0 && (
          <div className="mt-3 flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label>Add a company</Label>
              <select
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Pick a company…</option>
                {available.map((c) => (
                  <option key={c.entity_id} value={String(c.entity_id)}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              className="cursor-pointer"
              disabled={!adding || busy !== null}
              onClick={() => act("grant", Number(adding), "add")}
            >
              {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Take a leader off one company, or delete their login altogether.
 *
 * Two different acts, and until a leader could hold several companies they were
 * the same one. Taking them off ICON leaves them running Abdullah Club; deleting
 * the login ends their access everywhere. The dialog offers whichever apply and
 * defaults to the gentler one.
 *
 * The company a leader was created under cannot be taken away here — that is
 * users.entity_id, and moving it is a different operation with different
 * consequences — so for that card only the delete is offered.
 *
 * The server is the authority either way: it refuses your own account, refuses
 * the last super admin, and confines a leader to CS agents in their own
 * companies. This explains and asks.
 */
function RemoveUserDialog({
  user,
  fromEntityId,
  entities,
  users,
  leaderMemberships,
  onClose,
}: {
  user: User;
  /** The entity card the remove was clicked from. */
  fromEntityId: number;
  entities: Entity[];
  users: User[];
  leaderMemberships: LeaderMembership[];
  onClose: () => void;
}) {
  const deleteUser = useStore((s) => s.deleteUser);
  const refresh = useStore((s) => s.refresh);
  const [busy, setBusy] = useState(false);

  const fromEntity = entities.find((e) => e.entity_id === fromEntityId);
  const homeEntity = entities.find((e) => e.entity_id === user.entity_id);
  const siblings = users.filter(
    (u) => u.entity_id === user.entity_id && u.user_id !== user.user_id,
  ).length;
  const deskGoesToo = homeEntity?.entity_type === "cs" && siblings === 0;

  /** Companies they hold: the one they sit on, plus anything granted. */
  const held = [
    ...new Set([
      user.entity_id,
      ...leaderMemberships
        .filter((m) => m.user_id === user.user_id)
        .map((m) => m.leader_entity_id),
    ]),
  ];
  // Only a granted company can be given back here — never the home one.
  const canDetach =
    user.role === "company_leader" &&
    fromEntityId !== user.entity_id &&
    held.includes(fromEntityId);

  const [mode, setMode] = useState<"detach" | "delete">(canDetach ? "detach" : "delete");

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "detach") {
        const res = await fetch(`/api/users/${user.user_id}/companies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "revoke", leader_entity_id: fromEntityId }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          toast.error(data?.error ?? "Could not take them off this company");
          return;
        }
        await refresh();
        toast.success(`${user.username} taken off ${fromEntity?.name ?? "the company"}`);
      } else {
        const res = await deleteUser(user.user_id);
        if (!res.ok) {
          toast.error(res.error ?? "Could not remove the login");
          return;
        }
        toast.success(`${user.username} removed`);
      }
      onClose();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Remove {user.full_name}?</DialogTitle>

        <div className="mt-3 space-y-3 text-sm">
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="font-medium">@{user.username}</div>
            <div className="text-[11px] text-muted-foreground">
              {ROLE_BADGE[user.role].label}
              {fromEntity ? ` · on ${fromEntity.name}` : ""}
            </div>
          </div>

          {canDetach && (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2">
                <input
                  type="radio"
                  className="mt-0.5 cursor-pointer"
                  checked={mode === "detach"}
                  onChange={() => setMode("detach")}
                />
                <span>
                  <span className="font-medium">Take off {fromEntity?.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    They keep their login and still run{" "}
                    {held.length - 1 === 1
                      ? (entities.find((e) => e.entity_id === user.entity_id)?.name ??
                        "their other company")
                      : `${held.length - 1} other companies`}
                    .
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2">
                <input
                  type="radio"
                  className="mt-0.5 cursor-pointer"
                  checked={mode === "delete"}
                  onChange={() => setMode("delete")}
                />
                <span>
                  <span className="font-medium">Delete the login</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Ends their access to every company they hold.
                  </span>
                </span>
              </label>
            </div>
          )}

          {mode === "delete" && (
            <ul className="list-disc space-y-1 pl-5 text-[12px] text-muted-foreground">
              <li>They can no longer sign in. The login is deleted, not disabled.</li>
              <li>
                Nothing they recorded moves — deposits, withdrawals and expenses keep
                their history and still name them.
              </li>
              {deskGoesToo ? (
                <li className="text-amber-700 dark:text-amber-400">
                  This is the only login on <strong>{homeEntity?.name}</strong>, so that
                  CS desk is removed with them.
                </li>
              ) : homeEntity?.entity_type === "cs" ? (
                <li>
                  The <strong>{homeEntity.name}</strong> desk stays — {siblings} other
                  {siblings === 1 ? " login" : " logins"} remain on it.
                </li>
              ) : null}
              {user.role === "company_leader" && (
                <li>
                  The casinos their companies run stay where they are. To hand those
                  over, use <strong>Restructure</strong> instead.
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" className="cursor-pointer" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            className={
              mode === "delete"
                ? "cursor-pointer bg-red-600 text-white hover:bg-red-700"
                : "cursor-pointer"
            }
            onClick={submit}
            disabled={busy}
          >
            {busy
              ? "Working…"
              : mode === "detach"
                ? `Take off ${fromEntity?.name ?? "company"}`
                : "Delete login"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Merge a leader into another, or downgrade them.
 *
 * Both hand every company over and retire the leader; downgrade also
 * deactivates their logins. Nothing is deleted and no past figure moves — the
 * ownership rows they held are closed, not removed, so August still reports
 * against whoever actually ran the company in August.
 */
function RestructureLeaderDialog({
  leader,
  onClose,
}: {
  leader: Entity;
  onClose: () => void;
}) {
  const entities = useStore((s) => s.entities);
  const companyLeaders = useStore((s) => s.companyLeaders);
  const refresh = useStore((s) => s.refresh);
  const [action, setAction] = useState<"merge" | "downgrade">("merge");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const others = entities.filter(
    (e) =>
      e.entity_type === "leader" &&
      e.status === "active" &&
      e.entity_id !== leader.entity_id,
  );
  const moving = companyLeaders.filter(
    (r) => r.leader_entity_id === leader.entity_id,
  ).length;

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/leaders/${leader.entity_id}/restructure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, to_leader_entity_id: Number(target) }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; companies_moved?: number }
        | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Could not restructure");
        return;
      }
      await refresh();
      toast.success(
        `${leader.name} ${action === "merge" ? "merged" : "downgraded"} — ` +
          `${data?.companies_moved ?? 0} moved`,
      );
      onClose();
    } catch {
      toast.error("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Restructure {leader.name}</DialogTitle>

        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <Label>What is happening</Label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value as "merge" | "downgrade")}
              className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="merge">Merge into another leader</option>
              <option value="downgrade">Downgrade — also disable their logins</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Companies go to</Label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Pick a leader…</option>
              {others.map((l) => (
                <option key={l.entity_id} value={String(l.entity_id)}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:bg-amber-950/40">
            <p className="font-medium">
              {moving} {moving === 1 ? "company moves" : "companies move"}, and{" "}
              {leader.name} is retired.
            </p>
            <p className="mt-1 text-muted-foreground">
              Nothing is deleted and no past report changes — {leader.name} stays
              credited with whatever their companies did while they ran them.
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" className="cursor-pointer" onClick={onClose}>
            Cancel
          </Button>
          <Button className="cursor-pointer" disabled={!target || busy} onClick={submit}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Confirm"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

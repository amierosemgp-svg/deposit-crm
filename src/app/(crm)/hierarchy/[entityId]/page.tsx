"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  Crown,
  Headset,
  Landmark,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { StatusBadge } from "@/components/status-badge";
import { useStore } from "@/lib/store";
import { formatShortDateTime } from "@/lib/format";
import type { Entity, EntityType, Me } from "@/lib/types";

const TYPE_LABEL: Record<EntityType, string> = {
  main_company: "Main Company",
  leader: "Leader",
  company: "Company",
  cs: "CS Desk",
};

const TYPE_ICON: Record<
  EntityType,
  { icon: React.ComponentType<{ className?: string }>; cls: string }
> = {
  main_company: { icon: Building2, cls: "bg-primary text-primary-foreground" },
  leader: { icon: Crown, cls: "bg-amber-500/10 text-amber-600" },
  company: { icon: Landmark, cls: "bg-blue-500/10 text-blue-600" },
  cs: { icon: Headset, cls: "bg-emerald-500/10 text-emerald-600" },
};

/**
 * Mirror of assertCanEdit in /api/entities/[id] — the server is the authority,
 * this only decides whether to show the form or a read-only view.
 */
function canEdit(me: Me | null, entity: Entity, entities: Entity[]): boolean {
  if (!me || me.role === "viewer" || me.role === "cs_agent") return false;
  if (me.role === "super_admin") return true;
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
}

function BackLink() {
  return (
    <Link
      href="/hierarchy"
      className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Organization Hierarchy
    </Link>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Seeded from the entity on mount. The parent keys this on the saved values,
 * so a successful save (or navigating to another node) remounts it with fresh
 * defaults — no effect syncing server state into form state.
 */
function EditForm({ entity, editable }: { entity: Entity; editable: boolean }) {
  const updateEntity = useStore((s) => s.updateEntity);
  const [name, setName] = useState(entity.name);
  const [active, setActive] = useState(entity.status === "active");
  const [saving, setSaving] = useState(false);

  const isMain = entity.entity_type === "main_company";
  const trimmedName = name.trim();
  const dirty =
    trimmedName !== entity.name || active !== (entity.status === "active");

  async function handleSave() {
    if (!dirty || saving) return;
    if (!trimmedName) {
      toast.error("Name cannot be empty");
      return;
    }
    const patch: { name?: string; status?: "active" | "inactive" } = {};
    if (trimmedName !== entity.name) patch.name = trimmedName;
    if (!isMain && active !== (entity.status === "active")) {
      patch.status = active ? "active" : "inactive";
    }

    setSaving(true);
    const res = await updateEntity(entity.entity_id, patch);
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error ?? "Could not save changes");
      return;
    }
    toast.success(`${TYPE_LABEL[entity.entity_type]} updated`);
  }

  function handleReset() {
    setName(entity.name);
    setActive(entity.status === "active");
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Edit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!editable && (
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            You don&apos;t have permission to change this entity — it sits
            outside the part of the hierarchy you manage.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="entity-name">
            Name <span className="text-rose-600">*</span>
          </Label>
          <Input
            id="entity-name"
            value={name}
            maxLength={120}
            disabled={!editable || saving}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
          <div className="space-y-0.5">
            <Label htmlFor="entity-active" className="text-sm">
              Active
            </Label>
            <p className="text-xs text-muted-foreground">
              {isMain
                ? "The main company is always active."
                : "Entities are never deleted — deactivate one to retire it while its players, accounts and history stay intact. Child entities keep their own status."}
            </p>
          </div>
          <Switch
            id="entity-active"
            checked={active}
            disabled={!editable || isMain || saving}
            onCheckedChange={setActive}
            aria-label={`Toggle ${entity.name} active`}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            className="cursor-pointer"
            disabled={!editable || !dirty || saving}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={!dirty || saving}
            onClick={handleReset}
          >
            Reset
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Type and parent can&apos;t be changed — moving a node would re-scope
          every player, bank account and transaction under it.
        </p>
      </CardContent>
    </Card>
  );
}

export default function EntityEditPage() {
  const { entityId } = useParams<{ entityId: string }>();
  const id = Number(entityId);

  const hydrated = useStore((s) => s.hydrated);
  const me = useStore((s) => s.me);
  const entities = useStore((s) => s.entities);
  const users = useStore((s) => s.users);
  const players = useStore((s) => s.players);

  const entity = entities.find((e) => e.entity_id === id);
  const parent = entities.find((e) => e.entity_id === entity?.parent_entity_id);

  const children = useMemo(
    () => entities.filter((e) => e.parent_entity_id === id),
    [entities, id],
  );
  const userCount = useMemo(
    () => users.filter((u) => u.entity_id === id).length,
    [users, id],
  );
  const playerCount = useMemo(
    () => players.filter((p) => p.company_entity_id === id).length,
    [players, id],
  );

  if (!hydrated) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="space-y-5">
        <BackLink />
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No entity #{entityId} in your organization — it may sit outside what
            you can see.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { icon: Icon, cls } = TYPE_ICON[entity.entity_type];

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="flex items-start gap-3">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${cls}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold">{entity.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{TYPE_LABEL[entity.entity_type]}</span>
            {parent && <span>· under {parent.name}</span>}
            <StatusBadge status={entity.status} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EditForm
          key={`${entity.entity_id}:${entity.name}:${entity.status}`}
          entity={entity}
          editable={canEdit(me, entity, entities)}
        />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Entity ID" value={`#${entity.entity_id}`} />
            <Row label="Type" value={TYPE_LABEL[entity.entity_type]} />
            <Row label="Parent" value={parent ? parent.name : "—"} />
            <Row
              label="Created"
              value={formatShortDateTime(entity.created_at)}
            />
            <Row
              label="Users"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  {userCount}
                </span>
              }
            />
            {entity.entity_type === "company" && (
              <Row label="Players" value={playerCount} />
            )}
            <Row
              label="Child entities"
              value={
                children.length === 0
                  ? "—"
                  : `${children.length} · ${children.filter((c) => c.status === "active").length} active`
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

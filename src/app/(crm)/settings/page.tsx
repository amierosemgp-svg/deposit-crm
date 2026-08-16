"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  UserPlus,
  Users as UsersIcon,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRelative } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { ListLoading } from "@/components/list-loading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/status-badge";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiKeyRow, User } from "@/lib/types";

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  company_leader: "Leader",
  cs_agent: "CS Agent",
  viewer: "Viewer",
};

type TabKey = "account" | "team" | "keys" | "system";

export default function SettingsPage() {
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<TabKey>("account");

  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: "account", label: "My Account", show: true },
    { key: "team", label: "Team", show: me?.role === "super_admin" || me?.role === "company_leader" },
    { key: "keys", label: "API Keys", show: me?.role === "super_admin" },
    { key: "system", label: "System", show: me?.role === "super_admin" },
  ];
  const visible = tabs.filter((t) => t.show);

  useEffect(() => {
    if (!visible.find((t) => t.key === tab)) setTab("account");
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) {
    return <div className="py-24 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account, team, integration keys and system configuration.
        </p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {visible.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`cursor-pointer px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "account" && <AccountTab />}
      {tab === "team" && <TeamTab />}
      {tab === "keys" && <KeysTab />}
      {tab === "system" && <SystemTab />}
    </div>
  );
}

/* ---------------- Account ---------------- */

function AccountTab() {
  const me = useStore((s) => s.me)!;
  const entityName = useStore((s) => s.entityName);
  const changePassword = useStore((s) => s.changePassword);

  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirmPw) return toast.error("New passwords don't match");
    if (next.length < 8) return toast.error("New password must be at least 8 characters");
    setBusy(true);
    const r = await changePassword({ current_password: cur, new_password: next });
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Could not change password");
    toast.success("Password changed");
    setCur(""); setNext(""); setConfirmPw("");
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-4">Account</h2>
        <dl className="space-y-3 text-sm">
          <Row label="Name" value={me.full_name} />
          <Row label="Username" value={`@${me.username}`} />
          <Row label="Role" value={ROLE_LABELS[me.role]} />
          <Row label="Attached to" value={entityName(me.entity_id)} />
          <Row
            label="Scope"
            value={
              me.role === "super_admin"
                ? "All companies"
                : me.role === "company_leader"
                  ? `${me.companyIds?.length ?? 0} companies`
                  : "Own company"
            }
          />
        </dl>
      </Card>

      <Card className="p-5">
        <h2 className="text-sm font-semibold mb-4">Change password</h2>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cur">Current password</Label>
            <Input id="cur" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np">New password</Label>
            <Input id="np" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp">Confirm new password</Label>
            <Input id="cp" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </div>
          <Button type="submit" disabled={busy || !cur || !next} className="cursor-pointer">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update password"}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-right">{value}</dd>
    </div>
  );
}

/* ---------------- Team ---------------- */

function TeamTab() {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const hydrated = useStore((s) => s.hydrated);
  const entities = useStore((s) => s.entities);
  const entityName = useStore((s) => s.entityName);
  const updateUser = useStore((s) => s.updateUser);
  const deleteUser = useStore((s) => s.deleteUser);
  const [addOpen, setAddOpen] = useState(false);

  const companyOf = (entityId: number) => {
    const e = entities.find((x) => x.entity_id === entityId);
    if (!e) return "—";
    if (e.entity_type === "cs") return entityName(e.parent_entity_id ?? 0);
    return e.name;
  };

  const managed = users.filter((u) => {
    if (u.user_id === me.user_id) return false;
    if (me.role === "super_admin") return true;
    if (u.role !== "cs_agent") return false;
    const cs = entities.find((e) => e.entity_id === u.entity_id);
    return cs?.parent_entity_id != null && (me.companyIds ?? []).includes(cs.parent_entity_id);
  });

  async function toggleStatus(u: User) {
    const r = await updateUser(u.user_id, {
      status: u.status === "active" ? "inactive" : "active",
    });
    if (!r.ok) toast.error(r.error ?? "Failed");
    else toast.success(u.status === "active" ? "User deactivated" : "User reactivated");
  }

  async function remove(u: User) {
    if (!confirm(`Remove ${u.full_name} (@${u.username})? This cannot be undone.`)) return;
    const r = await deleteUser(u.user_id);
    if (!r.ok) toast.error(r.error ?? "Failed");
    else toast.success("User removed");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <UsersIcon className="h-4 w-4" />
          {managed.length} team member{managed.length === 1 ? "" : "s"} you manage
        </div>
        <Button onClick={() => setAddOpen(true)} className="cursor-pointer gap-1.5">
          <UserPlus className="h-4 w-4" /> Add member
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Name</th>
                <th className="px-4 py-2.5 font-semibold">Role</th>
                <th className="px-4 py-2.5 font-semibold">Company</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {managed.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading team…" />
                    ) : (
                      "No team members yet. Add your first with “Add member”."
                    )}
                  </td>
                </tr>
              )}
              {managed.map((u) => (
                <tr key={u.user_id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.full_name}</div>
                    <div className="text-xs text-muted-foreground">@{u.username}</div>
                  </td>
                  <td className="px-4 py-3">{ROLE_LABELS[u.role]}</td>
                  <td className="px-4 py-3 text-muted-foreground">{companyOf(u.entity_id)}</td>
                  <td className="px-4 py-3"><StatusBadge status={u.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="outline" size="sm" className="cursor-pointer gap-1"
                        onClick={() => toggleStatus(u)}
                      >
                        {u.status === "active" ? <><Ban className="h-3.5 w-3.5" /> Deactivate</> : <><RotateCcw className="h-3.5 w-3.5" /> Reactivate</>}
                      </Button>
                      <Button
                        variant="outline" size="sm"
                        className="cursor-pointer text-red-600 dark:text-red-400 hover:text-red-700"
                        onClick={() => remove(u)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <AddMemberModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddMemberModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const me = useStore((s) => s.me)!;
  const companies = useStore((s) => s.companies)();
  const addCsAgent = useStore((s) => s.addCsAgent);
  const addLeader = useStore((s) => s.addLeader);

  const canAddLeader = me.role === "super_admin";
  const [kind, setKind] = useState<"cs" | "leader">("cs");
  const [companyId, setCompanyId] = useState("");
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind("cs");
      setCompanyId(companies[0] ? String(companies[0].company_id) : "");
      setFullName(""); setUsername(""); setEmail(""); setPassword(""); setCompanyName("");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    let r;
    if (kind === "leader") {
      r = await addLeader({ full_name: fullName, company_name: companyName || undefined, username, email, password });
    } else {
      if (!companyId) { setBusy(false); return toast.error("Pick a company"); }
      r = await addCsAgent({ company_entity_id: Number(companyId), full_name: fullName, username, email, password });
    }
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Failed to add member");
    toast.success("Member added");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>Add team member</DialogTitle>
        <DialogDescription>
          {kind === "cs"
            ? "Creates a CS agent under a company — they handle that company's deposits and withdrawals."
            : "Creates a leader (shareholder) with their own companies."}
        </DialogDescription>
        <form onSubmit={submit} className="mt-2 space-y-3">
          {canAddLeader && (
            <div className="space-y-1.5">
              <Label>Member type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "cs" | "leader")}>
                <SelectTrigger className="cursor-pointer"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cs">CS Agent</SelectItem>
                  <SelectItem value="leader">Leader</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === "cs" ? (
            <div className="space-y-1.5">
              <Label>Company</Label>
              <Select
                value={companyId}
                onValueChange={(v) => setCompanyId(v ?? "")}
                items={companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                }))}
              >
                <SelectTrigger className="cursor-pointer"><SelectValue placeholder="Select a company" /></SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.company_id} value={String(c.company_id)}>{c.company_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>First company name <span className="text-muted-foreground">(optional)</span></Label>
              <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Alpha Gaming" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Full name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Temporary password</Label>
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 8 characters" required />
            <p className="text-xs text-muted-foreground">Share this with them; they can change it under My Account.</p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy} className="cursor-pointer">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add member"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- API Keys ---------------- */

function KeysTab() {
  const apiKeys = useStore((s) => s.apiKeys);
  const hydrated = useStore((s) => s.hydrated);
  const fetchApiKeys = useStore((s) => s.fetchApiKeys);
  const updateApiKey = useStore((s) => s.updateApiKey);
  const deleteApiKey = useStore((s) => s.deleteApiKey);
  const entityName = useStore((s) => s.entityName);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [editIps, setEditIps] = useState<ApiKeyRow | null>(null);

  useEffect(() => { void fetchApiKeys(); }, [fetchApiKeys]);

  async function revoke(k: ApiKeyRow) {
    const r = await updateApiKey(k.key_id, { status: k.status === "active" ? "inactive" : "active" });
    if (!r.ok) toast.error(r.error ?? "Failed");
    else toast.success(k.status === "active" ? "Key revoked" : "Key reactivated");
  }
  async function remove(k: ApiKeyRow) {
    if (!confirm(`Delete key "${k.label}"? Any agent using it stops working immediately.`)) return;
    const r = await deleteApiKey(k.key_id);
    if (!r.ok) toast.error(r.error ?? "Failed");
    else toast.success("Key deleted");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground max-w-lg">
          Keys authenticate the deposit agent. The full key is shown only once at creation — store it securely.
        </p>
        <Button onClick={() => setCreateOpen(true)} className="cursor-pointer gap-1.5">
          <Plus className="h-4 w-4" /> Create key
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Label</th>
                <th className="px-4 py-2.5 font-semibold">Key</th>
                <th className="px-4 py-2.5 font-semibold">Scope</th>
                <th className="px-4 py-2.5 font-semibold">IP allowlist</th>
                <th className="px-4 py-2.5 font-semibold">Last used</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {!hydrated ? (
                      <ListLoading className="py-0" label="Loading API keys…" />
                    ) : (
                      "No API keys yet."
                    )}
                  </td>
                </tr>
              )}
              {apiKeys.map((k) => (
                <tr key={k.key_id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-medium">{k.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{k.hint ?? "dbk_••••"}</td>
                  <td className="px-4 py-3 text-xs">
                    {k.company_entity_id != null ? (
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        {entityName(k.company_entity_id)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Full access</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {k.allowed_ips?.length ? (
                      <span className="font-mono text-muted-foreground">{k.allowed_ips.join(", ")}</span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">Any IP</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {k.last_used_at ? formatRelative(k.last_used_at) : "Never"}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={k.status} /></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <Button variant="outline" size="sm" className="cursor-pointer gap-1" onClick={() => setEditIps(k)}>
                        <Shield className="h-3.5 w-3.5" /> IPs
                      </Button>
                      <Button variant="outline" size="sm" className="cursor-pointer" onClick={() => revoke(k)}>
                        {k.status === "active" ? "Revoke" : "Reactivate"}
                      </Button>
                      <Button variant="outline" size="sm" className="cursor-pointer text-red-600 dark:text-red-400 hover:text-red-700" onClick={() => remove(k)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <CreateKeyModal open={createOpen} onOpenChange={setCreateOpen} onCreated={(key) => setNewKey(key)} />
      <RevealKeyModal keyValue={newKey} onClose={() => setNewKey(null)} />
      <EditIpsModal apiKey={editIps} onClose={() => setEditIps(null)} />
    </div>
  );
}

function EditIpsModal({ apiKey, onClose }: { apiKey: ApiKeyRow | null; onClose: () => void }) {
  const updateApiKey = useStore((s) => s.updateApiKey);
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIps(apiKey?.allowed_ips?.length ? apiKey.allowed_ips.join(", ") : "");
  }, [apiKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey) return;
    setBusy(true);
    const allowed = ips.split(",").map((s) => s.trim()).filter(Boolean);
    // Send null (not []) to clear — the PATCH route treats an empty list as "any IP".
    const r = await updateApiKey(apiKey.key_id, { allowed_ips: allowed.length ? allowed : null });
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Failed to update allowlist");
    toast.success(allowed.length ? "IP allowlist updated" : "Allowlist cleared — key now works from any IP");
    onClose();
  }

  return (
    <Dialog open={!!apiKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>IP allowlist</DialogTitle>
        <DialogDescription>
          Restrict <span className="font-medium">{apiKey?.label}</span> to specific egress IPs. Requests from any
          other IP get a 403 — the key stays the primary control, this is a second layer.
        </DialogDescription>
        <form onSubmit={submit} className="mt-2 space-y-3">
          <div className="space-y-1.5">
            <Label>Allowed IPs</Label>
            <Input
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              placeholder="comma-separated, e.g. 74.220.52.20, 74.220.52.21"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to allow any IP. Only use this if the agent has a static egress IP — a rotating IP will get
              locked out.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy} className="cursor-pointer">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save allowlist"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyModal({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (key: string) => void }) {
  const createApiKey = useStore((s) => s.createApiKey);
  const companies = useStore((s) => s.companies)();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState("all");
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (open) { setLabel(""); setScope("all"); setIps(""); } }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const allowed = ips.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await createApiKey({
      label,
      company_entity_id: scope === "all" ? null : Number(scope),
      allowed_ips: allowed.length ? allowed : undefined,
    });
    setBusy(false);
    if (!r.ok || !r.key) return toast.error(r.error ?? "Failed to create key");
    onOpenChange(false);
    onCreated(r.key);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle>Create API key</DialogTitle>
        <DialogDescription>Issue a new key for an agent or integration.</DialogDescription>
        <form onSubmit={submit} className="mt-2 space-y-3">
          <div className="space-y-1.5">
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. OpenClaw agent — production" required />
          </div>
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v ?? "all")}
              items={[
                { value: "all", label: "Full access (all companies)" },
                ...companies.map((c) => ({
                  value: String(c.company_id),
                  label: c.company_name,
                })),
              ]}
            >
              <SelectTrigger className="h-9 w-full cursor-pointer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="cursor-pointer">
                  Full access (all companies)
                </SelectItem>
                {companies.map((c) => (
                  <SelectItem key={c.company_id} value={String(c.company_id)} className="cursor-pointer">
                    {c.company_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              A company scope limits this key to that company&apos;s bank accounts &amp; kiosks, and prefixes the key with its leader code.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>IP allowlist <span className="text-muted-foreground">(optional)</span></Label>
            <Input value={ips} onChange={(e) => setIps(e.target.value)} placeholder="comma-separated, e.g. 74.220.52.20" />
            <p className="text-xs text-muted-foreground">Leave blank to allow any IP. When set, requests from other IPs are rejected.</p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !label} className="cursor-pointer">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create key"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevealKeyModal({ keyValue, onClose }: { keyValue: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!keyValue) return;
    navigator.clipboard.writeText(keyValue).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <Dialog open={!!keyValue} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" /> Your new API key
        </DialogTitle>
        <DialogDescription>
          Copy it now — for security it is never shown again. Give it to the agent team over a secure channel.
        </DialogDescription>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/50 p-3">
          <code className="flex-1 break-all font-mono text-xs">{keyValue}</code>
          <Button size="sm" variant="outline" className="cursor-pointer shrink-0 gap-1" onClick={copy}>
            {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
          </Button>
        </div>
        <div className="flex justify-end pt-2">
          <Button className="cursor-pointer" onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- System ---------------- */

function SystemTab() {
  const settings = useStore((s) => s.settings);
  const updateSetting = useStore((s) => s.updateSetting);

  const [hours, setHours] = useState(String(settings.transfer_auto_confirm_hours ?? 24));
  const [games, setGames] = useState<string[]>(settings.games ?? []);
  const [banks, setBanks] = useState<string[]>(settings.banks ?? []);
  const [busy, setBusy] = useState(false);

  // Per-field re-sync: overwrite a local field only when the server's value for
  // THAT field actually changes (another admin saved, or our own auto-save came
  // back). Keying on per-field content — not the settings object reference —
  // means the 10s polling refresh never clobbers in-progress edits, and
  // auto-saving one field never wipes another field's unsaved edit.
  const srvHours = String(settings.transfer_auto_confirm_hours ?? 24);
  const srvGamesSig = JSON.stringify(settings.games ?? []);
  const srvBanksSig = JSON.stringify(settings.banks ?? []);
  const [synced, setSynced] = useState({
    hours: srvHours,
    games: srvGamesSig,
    banks: srvBanksSig,
  });
  if (srvHours !== synced.hours) {
    setSynced((s) => ({ ...s, hours: srvHours }));
    setHours(srvHours);
  }
  if (srvGamesSig !== synced.games) {
    setSynced((s) => ({ ...s, games: srvGamesSig }));
    setGames(settings.games ?? []);
  }
  if (srvBanksSig !== synced.banks) {
    setSynced((s) => ({ ...s, banks: srvBanksSig }));
    setBanks(settings.banks ?? []);
  }

  // Games and Banks persist immediately on add/remove — "Add" is a commit.
  async function commitGames(next: string[]) {
    setGames(next);
    const r = await updateSetting({ games: next.filter(Boolean) });
    if (!r.ok) toast.error(r.error ?? "Failed to save games");
  }
  async function commitBanks(next: string[]) {
    setBanks(next);
    const r = await updateSetting({ banks: next.filter(Boolean) });
    if (!r.ok) toast.error(r.error ?? "Failed to save banks");
  }

  async function save() {
    setBusy(true);
    const r = await updateSetting({
      transfer_auto_confirm_hours: Number(hours),
    });
    setBusy(false);
    if (!r.ok) toast.error(r.error ?? "Failed to save");
    else toast.success("Settings saved");
  }

  return (
    <div className="space-y-5">
      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Transfers</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How long a pending inter-account transfer waits for recipient confirmation before it auto-confirms.
          </p>
        </div>
        <div className="flex items-center gap-2 max-w-xs">
          <Input type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} />
          <span className="text-sm text-muted-foreground">hours</span>
        </div>
      </Card>

      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Games</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Master list of game providers. Saved instantly. A game becomes
            selectable for deposits/withdrawals once a company has an active
            kiosk (BO account) for it.
          </p>
        </div>
        <ChipEditor values={games} onChange={commitGames} placeholder="Add a game (e.g. Mega888)" />
      </Card>

      <Card className="p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Banks</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Bank names offered in deposit and account forms. Saved instantly.
          </p>
        </div>
        <ChipEditor values={banks} onChange={commitBanks} placeholder="Add a bank (e.g. Maybank)" />
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={busy} className="cursor-pointer">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save configuration"}
        </Button>
      </div>
    </div>
  );
}

function ChipEditor({
  values, onChange, placeholder,
}: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {values.length === 0 && <span className="text-sm text-muted-foreground">None yet.</span>}
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-sm">
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="cursor-pointer text-muted-foreground hover:text-red-600"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2 max-w-sm">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" className="cursor-pointer" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

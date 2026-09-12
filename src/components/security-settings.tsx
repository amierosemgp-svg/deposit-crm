"use client";

/**
 * Settings → Security: the three controls that sit between a password and a
 * session — a Telegram second factor, the list of browsers allowed to sign
 * in, and (super admin) which networks an account may sign in from.
 *
 * The device list is the part worth reading twice. There is no MAC address
 * behind it: a web page cannot read one, so a device is a random id in a
 * long-lived cookie — a browser profile, not a machine. The screen says so
 * rather than implying a hardware guarantee it can't make.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  Laptop,
  Loader2,
  Network,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRelative } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";

type TelegramState = {
  configured: boolean;
  bot_username: string | null;
  linked: boolean;
  telegram_username: string | null;
  two_factor_enabled: boolean;
  link_url: string | null;
  link_expires_minutes: number;
};

type DeviceRow = {
  device_id: number;
  user_id: number;
  user_name: string;
  username: string;
  label: string | null;
  user_agent: string | null;
  last_ip: string | null;
  status: "pending" | "approved" | "blocked";
  first_seen_at: string;
  last_seen_at: string;
  is_current: boolean;
};

// Base UI's Select shows the raw value in its trigger unless given the labels.
const POLICY_ITEMS = [
  { value: "off", label: "Allow (record only)" },
  { value: "enforce", label: "Refuse until approved" },
];

const DEVICE_TONE: Record<DeviceRow["status"], string> = {
  approved: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  pending: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "bg-red-500/10 text-red-700 dark:text-red-300",
};

export function SecurityTab() {
  const me = useStore((s) => s.me)!;
  const isSuperAdmin = me.role === "super_admin";

  return (
    <div className="space-y-5">
      <TwoFactorCard />
      <DevicesCard canSetPolicy={isSuperAdmin} />
      {isSuperAdmin && <IpAllowlistCard />}
    </div>
  );
}

/* ---------------- Telegram two-factor ---------------- */

function TwoFactorCard() {
  const [state, setState] = useState<TelegramState | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped to re-read after a change; the fetch itself lives in the effect. */
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/telegram")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body) setState(body as TelegramState);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    const res = await fetch("/api/auth/telegram", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ two_factor_enabled: enabled }),
    });
    setBusy(false);
    const body = await res.json().catch(() => null);
    if (!res.ok) return toast.error(body?.error ?? "Could not change that");
    toast.success(enabled ? "Two-factor sign-in is on" : "Two-factor sign-in is off");
    load();
  }

  async function unlink() {
    setBusy(true);
    const res = await fetch("/api/auth/telegram", { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return toast.error("Could not unlink Telegram");
    toast.success("Telegram unlinked — two-factor sign-in is off");
    load();
  }

  if (!state) {
    return (
      <Card className="p-5">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">Two-factor sign-in</h2>
          <p className="text-[13px] text-muted-foreground">
            After your password, a 6-digit code arrives on Telegram. It expires in
            five minutes and only works in the browser that asked for it.
          </p>
        </div>
      </div>

      {!state.configured ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[13px] text-amber-800 dark:text-amber-300">
          Telegram isn&apos;t set up on this server yet. An administrator needs to set{" "}
          <code className="font-mono text-xs">TELEGRAM_BOT_TOKEN</code>,{" "}
          <code className="font-mono text-xs">TELEGRAM_BOT_USERNAME</code> and{" "}
          <code className="font-mono text-xs">TELEGRAM_WEBHOOK_SECRET</code>, then point
          the bot&apos;s webhook at <code className="font-mono text-xs">/api/telegram/webhook</code>.
        </p>
      ) : state.linked ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3 text-[13px]">
            <Send className="h-3.5 w-3.5 text-[#229ED9]" />
            <span className="font-medium">
              {state.telegram_username ? `@${state.telegram_username}` : "Telegram connected"}
            </span>
            <span
              className={cn(
                "ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium",
                state.two_factor_enabled
                  ? DEVICE_TONE.approved
                  : "bg-muted text-muted-foreground",
              )}
            >
              {state.two_factor_enabled ? "On" : "Off"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={state.two_factor_enabled ? "outline" : "default"}
              disabled={busy}
              onClick={() => void toggle(!state.two_factor_enabled)}
              className="cursor-pointer"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {state.two_factor_enabled ? "Turn off" : "Turn on"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void unlink()}
              className="cursor-pointer text-muted-foreground"
            >
              Unlink Telegram
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-muted-foreground">
            Open the bot and press Start. It reports the chat back here — nobody
            knows their own Telegram chat id, so it can&apos;t be typed in by hand.
            The link is good for {state.link_expires_minutes} minutes.
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={state.link_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Send className="h-3.5 w-3.5" />
              Connect Telegram
            </a>
            <Button
              size="sm"
              variant="outline"
              onClick={() => load()}
              className="cursor-pointer"
            >
              I&apos;ve done it — check
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Devices ---------------- */

function DevicesCard({ canSetPolicy }: { canSetPolicy: boolean }) {
  const me = useStore((s) => s.me)!;
  const updateSetting = useStore((s) => s.updateSetting);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [policy, setPolicy] = useState<"off" | "enforce">("off");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/devices")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        setDevices(body.devices as DeviceRow[]);
        setPolicy(body.policy as "off" | "enforce");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function setStatus(d: DeviceRow, status: DeviceRow["status"]) {
    setBusyId(d.device_id);
    const res = await fetch(`/api/devices/${d.device_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    const body = await res.json().catch(() => null);
    if (!res.ok) return toast.error(body?.error ?? "Could not update that device");
    toast.success(
      status === "approved" ? "Device approved" : status === "blocked" ? "Device blocked" : "Device reset",
    );
    load();
  }

  async function remove(d: DeviceRow) {
    setBusyId(d.device_id);
    const res = await fetch(`/api/devices/${d.device_id}`, { method: "DELETE" });
    setBusyId(null);
    const body = await res.json().catch(() => null);
    if (!res.ok) return toast.error(body?.error ?? "Could not remove that device");
    toast.success("Device removed — it will ask again next time");
    load();
  }

  async function changePolicy(next: "off" | "enforce") {
    const pending = (devices ?? []).filter((d) => d.status !== "approved").length;
    if (next === "enforce" && pending > 0) {
      const ok = window.confirm(
        `${pending} device${pending === 1 ? "" : "s"} on this list ${pending === 1 ? "is" : "are"} not approved. ` +
          `Turning enforcement on will stop ${pending === 1 ? "it" : "them"} signing in. Continue?`,
      );
      if (!ok) return;
    }
    const r = await updateSetting({ device_policy: next });
    if (!r.ok) return toast.error(r.error ?? "Could not change the policy");
    setPolicy(next);
    toast.success(
      next === "enforce"
        ? "Only approved devices can sign in now"
        : "Devices are recorded but never refused",
    );
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <Laptop className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Devices</h2>
          <p className="text-[13px] text-muted-foreground">
            Every browser that signs in is recorded here.{" "}
            <span className="text-muted-foreground/80">
              This is a browser profile, not a machine — a web page can&apos;t read a
              MAC address. Clearing cookies or using another browser shows up as a
              new device.
            </span>
          </p>
        </div>
      </div>

      {canSetPolicy && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="min-w-0 flex-1">
            <Label className="text-[13px]">Unapproved devices</Label>
            <p className="text-[12px] text-muted-foreground">
              Approve the team&apos;s real machines before switching this on, or
              everyone is locked out at once.
            </p>
          </div>
          <Select
            value={policy}
            onValueChange={(v) => void changePolicy((v as "off" | "enforce") ?? "off")}
            items={POLICY_ITEMS}
          >
            <SelectTrigger className="h-8 w-48 cursor-pointer text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {POLICY_ITEMS.map((i) => (
                <SelectItem key={i.value} value={i.value} className="cursor-pointer">
                  {i.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {devices === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : devices.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No devices recorded yet.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {devices.map((d) => {
            const mine = d.user_id === me.user_id;
            return (
              <div key={d.device_id} className="flex flex-wrap items-center gap-3 p-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.label ?? "Unnamed device"}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", DEVICE_TONE[d.status])}>
                      {d.status === "approved" ? "Approved" : d.status === "blocked" ? "Blocked" : "Waiting"}
                    </span>
                    {d.is_current && (
                      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                        This device
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    {mine ? "You" : `${d.user_name} (@${d.username})`}
                    {d.last_ip ? ` · ${d.last_ip}` : ""} · last used {formatRelative(d.last_seen_at)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {busyId === d.device_id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {d.status !== "approved" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyId !== null}
                      onClick={() => void setStatus(d, "approved")}
                      className="cursor-pointer gap-1"
                    >
                      <Check className="h-3 w-3" />
                      Approve
                    </Button>
                  )}
                  {d.status !== "blocked" && !d.is_current && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busyId !== null}
                      onClick={() => void setStatus(d, "blocked")}
                      title="Refuse this device"
                      className="cursor-pointer gap-1 text-muted-foreground hover:text-red-600"
                    >
                      <X className="h-3 w-3" />
                      Block
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyId !== null}
                    onClick={() => void remove(d)}
                    title="Forget this device — it will ask again next time"
                    className="cursor-pointer text-muted-foreground hover:text-red-600"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ---------------- IP allowlist ---------------- */

function IpAllowlistCard() {
  const me = useStore((s) => s.me)!;
  const allUsers = useStore((s) => s.users);
  const refresh = useStore((s) => s.refresh);
  /**
   * Your own account is not in the list. Getting a range wrong on yourself
   * locks you out of the only screen that could undo it, and nothing short of
   * database access would get you back — the same reason the rest of the
   * account screens refuse self-edits.
   */
  const users = allUsers.filter((u: User) => u.user_id !== me.user_id);
  // Base UI's Select needs the value→label map to render a label in its trigger.
  const userItems = users.map((u: User) => ({
    value: String(u.user_id),
    label: `${u.full_name} (@${u.username})`,
  }));
  const [userId, setUserId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const selected = users.find((u: User) => String(u.user_id) === userId);

  // Load the chosen user's list into the editor.
  const [loadedFor, setLoadedFor] = useState<string>("");
  if (userId !== loadedFor) {
    setLoadedFor(userId);
    setEntries(selected?.ip_allowlist ?? []);
    setDraft("");
  }

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (entries.includes(v)) return setDraft("");
    setEntries([...entries, v]);
    setDraft("");
  }

  async function save() {
    if (!selected) return;
    setBusy(true);
    const res = await fetch(`/api/users/${selected.user_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip_allowlist: entries }),
    });
    setBusy(false);
    const body = await res.json().catch(() => null);
    if (!res.ok) return toast.error(body?.error ?? "Could not save the allowlist");
    toast.success(
      entries.length
        ? `${selected.full_name} can sign in from ${entries.length} ${entries.length === 1 ? "address" : "addresses"}`
        : `${selected.full_name} can sign in from anywhere`,
    );
    void refresh();
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <Network className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">Sign-in networks</h2>
          <p className="text-[13px] text-muted-foreground">
            Restrict an account to particular addresses or ranges — an office IP,
            a{" "}
            <code className="font-mono text-xs">203.0.113.0/24</code>{" "}
            block. Empty means anywhere, which is every account&apos;s default. Anyone on mobile
            data will change address often; don&apos;t list them. Your own account
            isn&apos;t here — a wrong range on yourself would lock you out of the
            screen that undoes it.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="max-w-sm space-y-1.5">
          <Label className="text-[13px]">Account</Label>
          <Select
            value={userId || null}
            onValueChange={(v) => setUserId(v ?? "")}
            items={userItems}
          >
            <SelectTrigger className="h-9 w-full cursor-pointer text-[13px]">
              <SelectValue placeholder="Pick a user" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u: User) => (
                <SelectItem key={u.user_id} value={String(u.user_id)} className="cursor-pointer">
                  {u.full_name} (@{u.username})
                  {(u.ip_allowlist?.length ?? 0) > 0 ? ` · ${u.ip_allowlist!.length} allowed` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selected && (
          <>
            <div className="flex flex-wrap gap-2">
              {entries.length === 0 && (
                <span className="text-[13px] text-muted-foreground">
                  No restriction — {selected.full_name} can sign in from anywhere.
                </span>
              )}
              {entries.map((v) => (
                <span
                  key={v}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 font-mono text-[12px]"
                >
                  {v}
                  <button
                    type="button"
                    onClick={() => setEntries(entries.filter((x) => x !== v))}
                    className="cursor-pointer text-muted-foreground hover:text-red-600"
                    aria-label={`Remove ${v}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="flex max-w-sm gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
                placeholder="203.0.113.7 or 203.0.113.0/24"
                className="h-9 font-mono text-[13px]"
              />
              <Button type="button" variant="outline" onClick={add} className="cursor-pointer">
                Add
              </Button>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void save()} className="cursor-pointer">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save allowlist
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

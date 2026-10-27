"use client";

/**
 * Emergency kill switch — the team's panic button, by casino.
 *
 * The header button or Ctrl+Alt+Delete (any signed-in user) opens it. Someone
 * with one casino confirms straight away; a leader with several picks which,
 * and the admin may also stop every casino at once. A stopped casino's agents
 * get a wipe order on their next poll (stop, delete local credentials/config/
 * data, clear their browser, don't reconnect) and its CS are signed out.
 *
 * Note: on Windows, Ctrl+Alt+Delete is reserved by the OS and never reaches
 * the browser — Ctrl+Alt+Backspace works there, and the Settings card's
 * button always does.
 */

import { useCallback, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { OctagonAlert, ShieldAlert } from "lucide-react";

type KillSwitchState = {
  active: boolean;
  activated_at?: string;
  activated_by?: string;
  released_at?: string;
  released_by?: string;
};

/**
 * Wipe everything this browser holds for the CRM origin — the part of the kill
 * switch that CAN run on the operator's own machine. Closing the tab itself is
 * not possible for a user-opened tab (browsers forbid it); the httpOnly session
 * cookie is cleared server-side by the logout the session-epoch triggers.
 */
async function wipeThisBrowser() {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* private mode / storage disabled */
  }
  // JS-readable cookies for this origin.
  try {
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0].trim();
      if (name) {
        document.cookie = `${name}=; Max-Age=0; path=/`;
      }
    }
  } catch {
    /* ignore */
  }
  // IndexedDB, best-effort (not on every browser).
  try {
    const idb = indexedDB as IDBFactory & {
      databases?: () => Promise<{ name?: string }[]>;
    };
    const dbs = (await idb.databases?.()) ?? [];
    await Promise.all(
      dbs.map((d) => d.name && indexedDB.deleteDatabase(d.name)),
    );
  } catch {
    /* ignore */
  }
  // Cache Storage (service-worker / PWA caches), best-effort.
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}

type CasinoKill = KillSwitchState & { id: number; name: string };
type KillState = { global: KillSwitchState; canGlobal: boolean; casinos: CasinoKill[] };
/** What a kill or release is aimed at: every casino, or these. */
type KillTarget = "all" | number[];

async function fetchKillState(): Promise<KillState | null> {
  try {
    const res = await fetch("/api/kill-switch");
    if (!res.ok) return null;
    const data = (await res.json()) as {
      kill_switch?: KillSwitchState;
      can_global?: boolean;
      casinos?: CasinoKill[];
    };
    return {
      global: data.kill_switch ?? { active: false },
      canGlobal: !!data.can_global,
      casinos: data.casinos ?? [],
    };
  } catch {
    return null;
  }
}

async function postKillSwitch(action: "activate" | "release", scope: KillTarget) {
  const res = await fetch("/api/kill-switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, scope }),
  });
  const data = (await res.json().catch(() => null)) as
    | { signed_out?: boolean; error?: string }
    | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return { signedOut: !!data?.signed_out };
}

/** This browser is signed out by its own kill: clear it and leave the CRM. */
async function leaveAfterKill() {
  await wipeThisBrowser();
  // Try to close this tab — only works if a script opened it (bot agents,
  // pop-outs). Browsers refuse to close a user-opened tab, so if it's still
  // here a beat later, navigate away from the CRM entirely. replace(), not
  // href: it overwrites this history entry so Back can't return to the CRM.
  window.close();
  setTimeout(() => {
    window.location.replace("https://google.com");
  }, 150);
}

/**
 * The kill switch, by casino.
 *
 * Someone with one casino goes straight to the confirmation for it. A leader
 * with several — and the admin, who also has "All casinos" — picks first.
 * Each casino's own state is shown, so a stopped one can be released here too.
 */
function KillPanel({
  open,
  onOpenChange,
  state,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  state: KillState | null;
  onChanged: () => void;
}) {
  const [picked, setPicked] = useState<Set<number | "all">>(new Set());
  const [confirm, setConfirm] = useState<{ action: "activate" | "release"; target: KillTarget } | null>(null);

  const casinos = state?.casinos ?? [];
  const single = !state?.canGlobal && casinos.length === 1 ? casinos[0] : null;

  // One casino: no picker — the confirmation is the whole flow.
  useEffect(() => {
    if (!open || !single) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfirm({ action: single.active ? "release" : "activate", target: [single.id] });
    onOpenChange(false);
  }, [open, single, onOpenChange]);

  const nameOf = (target: KillTarget) =>
    target === "all"
      ? "All casinos"
      : target.map((id) => casinos.find((c) => c.id === id)?.name ?? `#${id}`).join(", ");

  const toggle = (k: number | "all") =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const pickedTarget = (): KillTarget | null =>
    picked.has("all") ? "all" : picked.size ? ([...picked] as number[]) : null;

  const run = async (action: "activate" | "release", target: KillTarget) => {
    try {
      const { signedOut } = await postKillSwitch(action, target);
      if (action === "activate" && (signedOut || target === "all")) {
        await leaveAfterKill();
        return;
      }
      toast.success(
        action === "activate"
          ? `Kill switch on for ${nameOf(target)} — its bots are stopped, its CS signed out`
          : `Kill switch released for ${nameOf(target)} — its bots may reconnect`,
      );
      setPicked(new Set());
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  const target = confirm?.target;
  return (
    <>
      <Dialog open={open && !single} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Kill switch — pick the casino</DialogTitle>
            <DialogDescription>
              A stopped casino&apos;s bots get a stop-and-wipe order on their next poll, and
              its CS are signed out. Other casinos keep running.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
            {state?.canGlobal && (
              <li className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer"
                  checked={picked.has("all")}
                  onChange={() => toggle("all")}
                />
                <span className="flex-1 font-semibold text-red-700 dark:text-red-400">
                  All casinos (everyone signed out)
                </span>
                {state.global.active && (
                  <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                    STOPPED
                  </span>
                )}
              </li>
            )}
            {casinos.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer"
                  disabled={picked.has("all")}
                  checked={picked.has(c.id) || picked.has("all")}
                  onChange={() => toggle(c.id)}
                />
                <span className="flex-1">{c.name}</span>
                {c.active && (
                  <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                    STOPPED
                  </span>
                )}
              </li>
            ))}
            {!casinos.length && !state?.canGlobal && (
              <li className="px-3 py-3 text-center text-[12px] text-muted-foreground">
                No casino to stop.
              </li>
            )}
          </ul>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              disabled={!pickedTarget()}
              className="cursor-pointer"
              onClick={() => {
                const t = pickedTarget();
                if (!t) return;
                onOpenChange(false);
                setConfirm({ action: "release", target: t });
              }}
            >
              Release
            </Button>
            <Button
              type="button"
              disabled={!pickedTarget()}
              className="cursor-pointer bg-red-600 text-white hover:bg-red-700"
              onClick={() => {
                const t = pickedTarget();
                if (!t) return;
                onOpenChange(false);
                setConfirm({ action: "activate", target: t });
              }}
            >
              <OctagonAlert className="h-3.5 w-3.5" />
              Stop
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {confirm && target && (
        <ConfirmActionDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirm(null);
          }}
          title={
            confirm.action === "activate"
              ? `KILL SWITCH — ${nameOf(target)}`
              : `Release the kill switch — ${nameOf(target)}?`
          }
          description={
            confirm.action === "activate"
              ? target === "all"
                ? "Every bot gets a stop-and-wipe order on its next poll (delete local credentials, config and data; clear and close its browsers; don't reconnect), and every CRM sign-in is invalidated — you included."
                : "This casino's bots get a stop-and-wipe order on their next poll (delete local credentials, config and data; clear and close their browsers; don't reconnect), and its CS are signed out. Other casinos keep running."
              : "Re-opens the bot API for these casinos so their agents can reconnect. Anyone signed out stays signed out — they just log in again."
          }
          summary={
            confirm.action === "activate"
              ? [
                  { label: "Casinos", value: nameOf(target), emphasis: true },
                  { label: "Their bots", value: "Stop + wipe on next poll" },
                  { label: "Signed out", value: target === "all" ? "Everyone, you included" : "Their CS" },
                ]
              : [
                  { label: "Casinos", value: nameOf(target), emphasis: true },
                  { label: "Bot API", value: "Re-opened" },
                ]
          }
          confirmLabel={confirm.action === "activate" ? "STOP" : "Release"}
          tone={confirm.action === "activate" ? "danger" : "default"}
          onConfirm={async () => {
            await run(confirm.action, target);
            setConfirm(null);
          }}
        />
      )}
    </>
  );
}

/** Polls the switch state for the header button and the settings card. */
function useKillState(enabled: boolean) {
  const [state, setState] = useState<KillState | null>(null);
  const load = useCallback(async () => {
    const s = await fetchKillState();
    if (s) setState(s);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [enabled, load]);
  return { state, load };
}

/** Anything this user can see stopped — flashes the header button red. */
const anyStopped = (s: KillState | null) =>
  !!s && (s.global.active || s.casinos.some((c) => c.active));

/**
 * Compact header button + its panel, for the top-right nav. Visible to any
 * signed-in user. Flashes while any casino they can see is stopped.
 */
export function KillSwitchHeaderButton() {
  const me = useStore((s) => s.me);
  const [open, setOpen] = useState(false);
  const { state, load } = useKillState(!!me);
  const active = anyStopped(state);

  if (!me) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void load();
          setOpen(true);
        }}
        aria-label="Emergency kill switch"
        title="Emergency kill switch (Ctrl+Alt+Delete)"
        className={
          active
            ? "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-red-600 px-3 text-[13px] font-bold uppercase tracking-wide text-white shadow-sm ring-2 ring-red-400 animate-pulse"
            : "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-md bg-red-600 px-3 text-[13px] font-bold uppercase tracking-wide text-white shadow-sm hover:bg-red-700"
        }
      >
        <OctagonAlert className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">{active ? "Bots stopped" : "Kill switch"}</span>
      </button>
      <KillPanel open={open} onOpenChange={setOpen} state={state} onChanged={load} />
    </>
  );
}

/** Global Ctrl+Alt+Delete listener; mounted once in the CRM layout. */
export function KillSwitchListener() {
  const me = useStore((s) => s.me);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<KillState | null>(null);

  useEffect(() => {
    if (!me) return;
    const onKey = (e: KeyboardEvent) => {
      // Mac keyboards send Backspace for the main delete key — accept both.
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        e.preventDefault();
        e.stopPropagation();
        void fetchKillState().then((s) => {
          setState(s);
          setOpen(true);
        });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [me]);

  if (!me) return null;
  return (
    <KillPanel
      open={open}
      onOpenChange={setOpen}
      state={state}
      onChanged={() => void fetchKillState().then(setState)}
    />
  );
}

/** Settings-page card: what is stopped now, and the panel. Any signed-in user. */
export function KillSwitchCard() {
  const me = useStore((s) => s.me);
  const [open, setOpen] = useState(false);
  const { state, load } = useKillState(!!me);

  if (!me) return null;
  const stopped = [
    ...(state?.global.active ? [{ name: "All casinos", ...state.global }] : []),
    ...(state?.casinos.filter((c) => c.active) ?? []),
  ];

  return (
    <Card className="border-red-300/60 dark:border-red-900">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
          <OctagonAlert className="h-4 w-4" />
          Emergency Kill Switch
        </CardTitle>
        {stopped.length > 0 && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
            ACTIVE
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12px] leading-snug text-muted-foreground">
          Stops a casino&apos;s bots with an order to stop, wipe local credentials,
          configuration and data, and close their browsers — and signs out that
          casino&apos;s CS. Other casinos keep running. Shortcut:{" "}
          <kbd className="rounded border border-border bg-muted px-1 text-[10px] font-semibold">
            Ctrl+Alt+Delete
          </kbd>
        </p>
        {stopped.map((s) => (
          <p key={s.name} className="flex items-center gap-1.5 text-[12px] text-red-700 dark:text-red-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            {s.name} stopped {s.activated_at?.slice(0, 16).replace("T", " ")} by{" "}
            {s.activated_by ?? "unknown"}
          </p>
        ))}
        <Button
          size="sm"
          onClick={() => {
            void load();
            setOpen(true);
          }}
          className="cursor-pointer bg-red-600 text-white hover:bg-red-700"
        >
          <OctagonAlert className="h-3.5 w-3.5" />
          {stopped.length ? "Stop or release a casino" : "Stop a casino"}
        </Button>
      </CardContent>
      <KillPanel open={open} onOpenChange={setOpen} state={state} onChanged={load} />
    </Card>
  );
}

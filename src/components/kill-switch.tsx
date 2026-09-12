"use client";

/**
 * Emergency kill switch — the team's panic button.
 *
 * Ctrl+Alt+Delete anywhere in the CRM (any signed-in user) opens the
 * confirmation;
 * confirming closes the bot API with a wipe order (each agent, on its next
 * poll, is told to stop, delete its local credentials/config/data, clear its
 * browser and not reconnect), and signs out every CRM session — including the
 * admin who pressed it.
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

async function postKillSwitch(action: "activate" | "release") {
  const res = await fetch("/api/kill-switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const data = (await res.json().catch(() => null)) as
    | { kill_switch?: KillSwitchState; error?: string }
    | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data?.kill_switch;
}

function KillConfirm({
  open,
  onOpenChange,
  active = false,
  onReleased,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** When true the dialog offers to RELEASE the active switch instead. */
  active?: boolean;
  onReleased?: () => void;
}) {
  if (active) {
    return (
      <ConfirmActionDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Release the kill switch?"
        description="Re-opens the bot API so agents can reconnect. CRM sessions that were signed out stay signed out — people just log in again."
        summary={[{ label: "Bot API", value: "Re-opened", emphasis: true }]}
        confirmLabel="Release"
        onConfirm={async () => {
          try {
            await postKillSwitch("release");
            toast.success("Kill switch released — bot API re-opened");
            onReleased?.();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to release");
          }
        }}
      />
    );
  }
  return (
    <ConfirmActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="EMERGENCY KILL SWITCH"
      description="Cuts the bot agents off now: their next poll returns a stop-and-wipe order (delete local credentials, config and data; clear and close their own browsers; don't reconnect). Every CRM sign-in is invalidated, so everyone — you included — is logged out. This browser's CRM storage and cookies are cleared too; it tries to close this tab, and if the browser won't allow that it navigates away to google.com."
      summary={[
        { label: "Bot agents", value: "Stop + wipe on next poll" },
        { label: "Bot local credentials/data", value: "Deleted (on the agent)" },
        { label: "Bot browsers", value: "Closed + cache/cookies cleared" },
        { label: "Your CRM session", value: "Signed out — log in again", emphasis: true },
      ]}
      confirmLabel="ACTIVATE KILL SWITCH"
      tone="danger"
      onConfirm={async () => {
        try {
          await postKillSwitch("activate");
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to activate");
          return;
        }
        await wipeThisBrowser();
        // Try to close this tab — only works if a script opened it (bot agents,
        // pop-outs). Browsers refuse to close a user-opened tab, so if it's
        // still here a beat later, navigate away from the CRM entirely.
        // replace(), not href: it overwrites this history entry so the Back
        // button can't return to the CRM page.
        window.close();
        setTimeout(() => {
          window.location.replace("https://google.com");
        }, 150);
      }}
    />
  );
}

/**
 * Compact header button + its confirm dialog, for the top-right nav. Visible
 * to any signed-in user. Polls the switch state so it can flash red while the
 * switch is active (a running kill is something the whole team should see).
 */
export function KillSwitchHeaderButton() {
  const me = useStore((s) => s.me);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/kill-switch");
        if (!res.ok) return;
        const data = (await res.json()) as { kill_switch?: KillSwitchState };
        if (alive) setActive(!!data.kill_switch?.active);
      } catch {
        // transient; next tick retries
      }
    };
    void check();
    const t = setInterval(check, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me]);

  if (!me) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
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
      <KillConfirm
        open={open}
        onOpenChange={setOpen}
        active={active}
        onReleased={() => setActive(false)}
      />
    </>
  );
}

/** Global Ctrl+Alt+Delete listener; mounted once in the CRM layout. */
export function KillSwitchListener() {
  const me = useStore((s) => s.me);
  const [open, setOpen] = useState(false);

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
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [me]);

  if (!me) return null;
  return <KillConfirm open={open} onOpenChange={setOpen} />;
}

/** Settings-page card: current state, activate/release. Any signed-in user. */
export function KillSwitchCard() {
  const me = useStore((s) => s.me);
  const [state, setState] = useState<KillSwitchState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/kill-switch");
      if (!res.ok) return;
      const data = (await res.json()) as { kill_switch?: KillSwitchState };
      setState(data.kill_switch ?? { active: false });
    } catch {
      // leave as unknown; the card still renders the activate path
    }
  }, []);
  useEffect(() => {
    // Fetch-on-mount; setState happens after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!me) return null;

  return (
    <Card className="border-red-300/60 dark:border-red-900">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-400">
          <OctagonAlert className="h-4 w-4" />
          Emergency Kill Switch
        </CardTitle>
        {state?.active && (
          <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
            ACTIVE
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12px] leading-snug text-muted-foreground">
          Cuts every agent off with an order to stop, wipe local credentials,
          configuration and data, and close its browser (cache and cookies
          included) — and signs out every CRM session, yours included. Shortcut:{" "}
          <kbd className="rounded border border-border bg-muted px-1 text-[10px] font-semibold">
            Ctrl+Alt+Delete
          </kbd>
        </p>
        {state?.active ? (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-[12px] text-red-700 dark:text-red-400">
              <ShieldAlert className="h-3.5 w-3.5" />
              Activated {state.activated_at?.slice(0, 16).replace("T", " ")} by{" "}
              {state.activated_by ?? "unknown"} — the bot API is closed.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              className="cursor-pointer"
              onClick={async () => {
                setBusy(true);
                try {
                  await postKillSwitch("release");
                  toast.success("Kill switch released — bot API re-opened");
                  await load();
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Release — re-open the bot API
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setOpen(true)}
            className="cursor-pointer bg-red-600 text-white hover:bg-red-700"
          >
            <OctagonAlert className="h-3.5 w-3.5" />
            Activate kill switch
          </Button>
        )}
      </CardContent>
      <KillConfirm open={open} onOpenChange={setOpen} />
    </Card>
  );
}

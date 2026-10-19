"use client";

/**
 * The CS idle lock — and the clock their salary is paid on.
 *
 * Five minutes without a key, click, scroll or mouse move locks the page and
 * stops the work session at the last input (lib/work-sessions). The password
 * unlocks it and starts the next. Leaders, admins and viewers are not on the
 * clock and never see it.
 *
 * Every open tab shares one idea of "last input" through localStorage, so a CS
 * working in the Deposits tab doesn't get locked out by the Players tab they
 * left open behind it — and a lock or unlock in one tab reaches the others.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const IDLE_MS = 5 * 60_000;
/** At most one heartbeat per this long, however busy the mouse. */
const BEAT_MS = 30_000;
const CHECK_MS = 5_000;
const MAX_WRONG = 5;

const LAST_INPUT_KEY = "crm.idle.lastInput";
const LOCKED_KEY = "crm.idle.locked";

const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

function readNumber(key: string): number {
  try {
    return Number(localStorage.getItem(key)) || 0;
  } catch {
    return 0;
  }
}

function writeValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — this tab still locks on its own input */
  }
}

async function beat(active: boolean): Promise<{ tracked: boolean; locked: boolean } | null> {
  try {
    const res = await fetch("/api/work-sessions/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { tracked: boolean; locked: boolean };
  } catch {
    return null;
  }
}

export function IdleLock() {
  const role = useStore((s) => s.me?.role);
  const fullName = useStore((s) => s.me?.full_name);
  const logout = useStore((s) => s.logout);
  const clocked = role === "cs_agent";

  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const lastInput = useRef(0);
  const lastBeatAt = useRef(0);
  const lastBeatInput = useRef(0);

  const showLock = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);

  /** Lock here, tell the server, tell the other tabs. */
  const lockNow = useCallback(() => {
    if (lockedRef.current) return;
    showLock(true);
    writeValue(LOCKED_KEY, "1");
    void fetch("/api/work-sessions/lock", { method: "POST" }).catch(() => {});
  }, [showLock]);

  // Where does the clock stand? Asked once on load — a reload after an
  // unattended hour should land on the lock screen, not on the sheet.
  useEffect(() => {
    if (!clocked) return;
    lastInput.current = Date.now();
    writeValue(LAST_INPUT_KEY, String(lastInput.current));
    void beat(true).then((r) => {
      if (r?.locked) showLock(true);
      lastBeatAt.current = Date.now();
      lastBeatInput.current = lastInput.current;
    });
  }, [clocked, showLock]);

  // Input anywhere on the page counts, unless the lock screen is up.
  useEffect(() => {
    if (!clocked) return;
    let lastWrite = 0;
    const onActivity = () => {
      if (lockedRef.current) return;
      const now = Date.now();
      lastInput.current = now;
      // Throttled: pointermove fires hundreds of times a second.
      if (now - lastWrite > 2_000) {
        lastWrite = now;
        writeValue(LAST_INPUT_KEY, String(now));
      }
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { capture: true, passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, [clocked]);

  // The loop: lock at five idle minutes, otherwise report input to the server.
  useEffect(() => {
    if (!clocked) return;
    const timer = setInterval(() => {
      if (lockedRef.current) return;
      const last = Math.max(lastInput.current, readNumber(LAST_INPUT_KEY));
      const now = Date.now();
      if (now - last >= IDLE_MS) {
        lockNow();
        return;
      }
      if (last > lastBeatInput.current && now - lastBeatAt.current >= BEAT_MS) {
        lastBeatAt.current = now;
        lastBeatInput.current = last;
        void beat(true).then((r) => {
          // Closed under us — signed in elsewhere, or the server saw a gap.
          if (r?.locked) showLock(true);
        });
      }
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [clocked, lockNow, showLock]);

  // Another tab locked or unlocked.
  useEffect(() => {
    if (!clocked) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOCKED_KEY) return;
      if (e.newValue === "1") showLock(true);
      else if (e.newValue === "0") {
        lastInput.current = Date.now();
        lastBeatInput.current = lastInput.current;
        lastBeatAt.current = Date.now();
        showLock(false);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [clocked, showLock]);

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrong = useRef(0);

  const unlock = useCallback(async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        wrong.current = 0;
        setPassword("");
        const now = Date.now();
        lastInput.current = now;
        lastBeatAt.current = now;
        lastBeatInput.current = now;
        writeValue(LAST_INPUT_KEY, String(now));
        writeValue(LOCKED_KEY, "0");
        showLock(false);
        return;
      }
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 401 && d?.error === "Wrong password") {
        wrong.current += 1;
        if (wrong.current >= MAX_WRONG) {
          await logout();
          return;
        }
        setError(`Wrong password — ${MAX_WRONG - wrong.current} tries left before you're signed out`);
      } else {
        setError(d?.error ?? "Could not unlock");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }, [password, busy, logout, showLock]);

  // Keys typed while locked stay on the lock screen; the sheet's shortcuts
  // listen on window and would otherwise still fire underneath it.
  useEffect(() => {
    if (!locked) return;
    const stop = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-idle-lock]")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("keydown", stop, { capture: true });
    return () => window.removeEventListener("keydown", stop, { capture: true });
  }, [locked]);

  if (!clocked || !locked) return null;

  return (
    <div
      data-idle-lock
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-md"
    >
      <form
        className="w-full max-w-sm space-y-4 rounded-xl border bg-background p-6 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
      >
        <div className="flex items-center gap-2 text-base font-semibold">
          <Lock className="h-4 w-4 text-muted-foreground" />
          Locked
        </div>
        <p className="text-sm text-muted-foreground">
          No activity for 5 minutes, so the clock stopped. Enter your password to carry on
          {fullName ? <> as <span className="font-medium text-foreground">{fullName}</span></> : null}.
        </p>
        <Input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            className="cursor-pointer"
            onClick={() => void logout()}
          >
            Sign out
          </Button>
          <Button type="submit" className="cursor-pointer gap-1.5" disabled={!password || busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Unlock
          </Button>
        </div>
      </form>
    </div>
  );
}

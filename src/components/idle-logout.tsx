"use client";

/**
 * The CS idle sign-out — and the clock their salary is paid on.
 *
 * An hour without a key, click, scroll or mouse move signs the CS out and
 * stops the work session at the last input (lib/work-sessions), so the idle
 * hour is not paid. Leaders, admins and viewers are not on the clock and are
 * never signed out by it.
 *
 * Every open tab shares one idea of "last input" through localStorage, so a CS
 * working in the Deposits tab isn't signed out by the Players tab they left
 * open behind it.
 */

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { IDLE_MS } from "@/lib/idle";

/** At most one heartbeat per this long, however busy the mouse. */
const BEAT_MS = 30_000;
const CHECK_MS = 5_000;

const LAST_INPUT_KEY = "crm.idle.lastInput";

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
    /* private mode — this tab still times out on its own input */
  }
}

async function beat(): Promise<{ tracked: boolean; locked: boolean } | null> {
  try {
    const res = await fetch("/api/work-sessions/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { tracked: boolean; locked: boolean };
  } catch {
    return null;
  }
}

export function IdleLogout() {
  const role = useStore((s) => s.me?.role);
  const logout = useStore((s) => s.logout);
  const clocked = role === "cs_agent";

  const lastInput = useRef(0);
  const lastBeatAt = useRef(0);
  const lastBeatInput = useRef(0);
  const leaving = useRef(false);

  /**
   * Close the session at the last input first, then sign out — signing out
   * alone ends the clock "now", which would pay the idle hour.
   */
  const signOutIdle = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    await fetch("/api/work-sessions/lock", { method: "POST" }).catch(() => {});
    await logout();
  }, [logout]);

  // Where does the clock stand? Asked once on load — a reload after an
  // unattended hour (laptop lid shut) should land on the sign-in page.
  useEffect(() => {
    if (!clocked) return;
    lastInput.current = Date.now();
    writeValue(LAST_INPUT_KEY, String(lastInput.current));
    void beat().then((r) => {
      if (r?.locked) void signOutIdle();
      lastBeatAt.current = Date.now();
      lastBeatInput.current = lastInput.current;
    });
  }, [clocked, signOutIdle]);

  // Input anywhere on the page counts.
  useEffect(() => {
    if (!clocked) return;
    let lastWrite = 0;
    const onActivity = () => {
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

  // The loop: sign out at an idle hour, otherwise report input to the server.
  useEffect(() => {
    if (!clocked) return;
    const timer = setInterval(() => {
      if (leaving.current) return;
      const last = Math.max(lastInput.current, readNumber(LAST_INPUT_KEY));
      const now = Date.now();
      if (now - last >= IDLE_MS) {
        void signOutIdle();
        return;
      }
      if (last > lastBeatInput.current && now - lastBeatAt.current >= BEAT_MS) {
        lastBeatAt.current = now;
        lastBeatInput.current = last;
        void beat().then((r) => {
          // The server already closed it — idle past the limit while asleep.
          if (r?.locked) void signOutIdle();
        });
      }
    }, CHECK_MS);
    return () => clearInterval(timer);
  }, [clocked, signOutIdle]);

  return null;
}

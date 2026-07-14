"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";

/** Hydrates the store from /api/state and polls every 10s while mounted. */
export function StoreHydrator() {
  const startPolling = useStore((s) => s.startPolling);
  const stopPolling = useStore((s) => s.stopPolling);
  const refresh = useStore((s) => s.refresh);

  useEffect(() => {
    startPolling();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      stopPolling();
    };
  }, [startPolling, stopPolling, refresh]);

  return null;
}

"use client";

import { usePathname } from "next/navigation";

/**
 * Routes that own the whole content area: no max-width, no page scroll —
 * the page lays itself out and scrolls internally (the spreadsheet view).
 */
const FULL_BLEED_ROUTES = ["/transactions", "/players"];

export function PageContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullBleed = FULL_BLEED_ROUTES.some((p) => pathname?.startsWith(p));
  if (fullBleed) {
    return <div className="flex h-full flex-col">{children}</div>;
  }
  return <div className="mx-auto max-w-[1400px] px-6 py-6">{children}</div>;
}

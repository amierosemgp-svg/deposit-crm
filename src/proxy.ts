import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionToken } from "@/lib/session";

const PUBLIC_API = ["/api/auth/login", "/api/bot/", "/api/cron/"];
// Public, no-login pages (e.g. the agent API reference for the integration team)
const PUBLIC_PAGES = ["/bot-api.html"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Agent + cron routes authenticate themselves (API key / cron secret)
  if (PUBLIC_API.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }
  // Public documentation pages
  if (PUBLIC_PAGES.includes(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get("crm_session")?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (pathname.startsWith("/api/")) {
    if (!session) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Page routes
  if (pathname === "/login") {
    if (session) {
      return NextResponse.redirect(new URL("/transactions", request.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    const login = new URL("/login", request.url);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)).*)"],
};

import { db } from "@/db";
import { TALLY_COMPANIES, type TallyResult, runTally } from "@/lib/casino-tally";
import { sendEmail } from "@/lib/email";
import { googleSheets } from "@/lib/google-sheets";
import { dayLabel } from "@/lib/sheet-tally";

/**
 * GET /api/cron/tally — Vercel Cron target (see vercel.json), 06:00 Malaysian
 * time. Checks each casino in TALLY_COMPANIES — its Google Sheet against the
 * CRM — for the day before and the month so far, and emails one report
 * covering all of them.
 *
 * One casino failing (sheet not shared, tab renamed, company missing from the
 * CRM) is reported as that in the email; the others still run.
 *
 * Query parameters, for running it by hand:
 *   date=YYYY-MM-DD  check that day instead of yesterday
 *   company=<key>    only this casino (pokercity, fishingstar, robinhood, genting),
 *                    paused ones included
 *   sheet=<id>       with company=, use this spreadsheet instead of the configured one
 *   send=0           don't email, just return the report
 *
 * Emails TALLY_EMAIL_TO (comma-separated), or medusachurchill@gmail.com when
 * that isn't set, through the SMTP server in lib/email.ts.
 */

export const maxDuration = 60;

const DEFAULT_TO = "medusachurchill@gmail.com";

/** Yesterday, Malaysian time. */
function yesterday(): string {
  const now = new Date(Date.now() + 8 * 3600_000 - 24 * 3600_000);
  return now.toISOString().slice(0, 10);
}

type Outcome = TallyResult & { company: string };

function overviewLine(o: Outcome): string {
  if (!o.ok) return `• ${o.company}: ❌ couldn't run`;
  const today = o.toCheck ? `⚠️ ${o.toCheck} to check` : "✅ all match";
  const open = o.stillOpen ? `, ${o.stillOpen} still open from earlier` : "";
  return `• ${o.company}: ${today}${open}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function compose(day: string, outcomes: Outcome[]) {
  const toCheck = outcomes.reduce((a, o) => a + (o.ok ? o.toCheck : 0), 0);
  const broken = outcomes.filter((o) => !o.ok).length;
  const status = [
    ...(toCheck ? [`${toCheck} to check`] : []),
    ...(broken ? [`${broken} couldn't run`] : []),
  ];
  const year = day.slice(0, 4);
  const subject = `Tally · ${dayLabel(day)} ${year} — ${status.join(" · ") || "all match"}`;

  const overview = [`Sheet vs CRM · ${dayLabel(day)} ${year}`, ...outcomes.map(overviewLine)].join("\n");
  const sections = [overview, ...outcomes.map((o) => o.text)];
  const text = sections.join(`\n\n${"─".repeat(30)}\n\n`);

  const block = (s: string) =>
    `<div style="white-space:pre-wrap;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;` +
    `font-size:14px;line-height:1.5">${escapeHtml(s)}</div>`;
  const html = sections.map(block).join(`<hr style="border:none;border-top:1px solid #ddd;margin:20px 0">`);

  return { subject, text, html };
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const params = new URL(request.url).searchParams;
  const day = params.get("date") ?? yesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  const send = params.get("send") !== "0";
  const only = params.get("company");
  const sheetId = params.get("sheet");
  if (sheetId && !only) {
    return Response.json({ error: "sheet= needs company= to say whose sheet it is" }, { status: 400 });
  }
  // A paused casino is skipped in the daily run but can still be named.
  const companies = only
    ? TALLY_COMPANIES.filter((c) => c.key === only)
    : TALLY_COMPANIES.filter((c) => !c.paused);
  if (!companies.length) {
    return Response.json(
      { error: `company must be one of ${TALLY_COMPANIES.map((c) => c.key).join(", ")}` },
      { status: 400 },
    );
  }

  // One Google sign-in shared by every casino. Held as a promise so a sign-in
  // failure lands in each casino's section rather than ending the run.
  const google = googleSheets();
  google.catch(() => {}); // awaited per casino; don't let it go unhandled first
  const outcomes: Outcome[] = await Promise.all(
    companies.map(async (c) => {
      try {
        const result = await runTally(db, c, day, { sheetId, google: await google });
        return { ...result, company: c.name };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false as const,
          day,
          company: c.name,
          text: `${c.name} tally · ${dayLabel(day)} — ❌ couldn't run\n${message}`,
        };
      }
    }),
  );
  const mail = compose(day, outcomes);

  const to = (process.env.TALLY_EMAIL_TO ?? DEFAULT_TO)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let email: { sent: boolean; to: string[]; error?: string } = { sent: false, to };
  if (send) {
    const r = await sendEmail({ to, ...mail });
    email = r.ok ? { sent: true, to } : { sent: false, to, error: r.error };
  }

  return Response.json(
    {
      ok: outcomes.every((o) => o.ok),
      day,
      companies: outcomes.map((o) =>
        o.ok
          ? { company: o.company, ok: true, sheet: o.sheet, toCheck: o.toCheck, stillOpen: o.stillOpen }
          : { company: o.company, ok: false },
      ),
      subject: mail.subject,
      text: mail.text,
      email,
    },
    // A report that should have gone out and didn't is the failure worth
    // flagging in Vercel's cron log.
    { status: send && !email.sent ? 500 : 200 },
  );
}

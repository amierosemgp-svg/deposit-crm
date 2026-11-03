import { db } from "@/db";
import { TALLY_COMPANIES, runTally } from "@/lib/casino-tally";
import { sendEmail } from "@/lib/email";
import { googleSheets } from "@/lib/google-sheets";
import { dayLabel } from "@/lib/sheet-tally";
import { type CasinoOutcome, type LeaderPdf, buildLeaderPdfs } from "@/lib/tally-pdf";

/**
 * GET /api/cron/tally — Vercel Cron target (see vercel.json), 06:00 Malaysian
 * time. Checks each casino in TALLY_COMPANIES — its Google Sheet against the
 * CRM — for the day before and the month so far, and emails one report
 * covering all of them, with a PDF per CRM leader attached (lib/tally-pdf.ts).
 *
 * One casino failing (sheet not shared, tab renamed, company missing from the
 * CRM) is reported as that in the email; the others still run.
 *
 * Query parameters, for running it by hand:
 *   date=YYYY-MM-DD  check that day instead of yesterday
 *   company=<key>    only this casino (pokercity, fishingstar, robinhood, genting),
 *                    paused ones included; several comma-separated
 *   sheet=<id>       with a single company=, use this spreadsheet instead of the configured one
 *   send=0           don't email, just return the report
 *
 * Emails TALLY_EMAIL_TO (comma-separated), or medusachurchill@gmail.com when
 * that isn't set, through the SMTP server in lib/email.ts. A casino with its
 * own `emailTo` also goes to those people, in an email holding only that
 * casino and a PDF of only that casino.
 */

export const maxDuration = 60;

const DEFAULT_TO = "medusachurchill@gmail.com";

/** Yesterday, Malaysian time. */
function yesterday(): string {
  const now = new Date(Date.now() + 8 * 3600_000 - 24 * 3600_000);
  return now.toISOString().slice(0, 10);
}

type Outcome = CasinoOutcome;

function overviewLine(o: Outcome): string {
  if (!o.ok) return `• ${o.company}: ❌ couldn't run`;
  const problems = [
    ...(o.toCheck ? [`${o.toCheck} to check`] : []),
    ...(o.banksDiffer ? [`${o.banksDiffer} bank balance${o.banksDiffer === 1 ? "" : "s"} differ`] : []),
  ];
  const today = problems.length ? `⚠️ ${problems.join(", ")}` : "✅ all match";
  const open = o.stillOpen ? `, ${o.stillOpen} still open from earlier` : "";
  return `• ${o.company}: ${today}${open}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function compose(day: string, outcomes: Outcome[], pdfs: LeaderPdf[]) {
  const toCheck = outcomes.reduce((a, o) => a + (o.ok ? o.toCheck : 0), 0);
  const banks = outcomes.reduce((a, o) => a + (o.ok ? o.banksDiffer : 0), 0);
  const broken = outcomes.filter((o) => !o.ok).length;
  const status = [
    ...(toCheck ? [`${toCheck} to check`] : []),
    ...(banks ? [`${banks} bank balance${banks === 1 ? "" : "s"} differ`] : []),
    ...(broken ? [`${broken} couldn't run`] : []),
  ];
  const year = day.slice(0, 4);
  const subject = `Tally · ${dayLabel(day)} ${year} — ${status.join(" · ") || "all match"}`;

  const attached = pdfs.length
    ? [`Attached: full report per leader (${pdfs.map((p) => p.leader.name).join(", ")}).`]
    : [];
  const overview = [
    `Sheet vs CRM · ${dayLabel(day)} ${year}`,
    ...outcomes.map(overviewLine),
    ...(attached.length ? ["", ...attached] : []),
  ].join("\n");
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
  const only = params.get("company")?.split(",").map((s) => s.trim()).filter(Boolean);
  const sheetId = params.get("sheet");
  if (sheetId && only?.length !== 1) {
    return Response.json({ error: "sheet= needs one company= to say whose sheet it is" }, { status: 400 });
  }
  // A paused casino is skipped in the daily run but can still be named.
  const companies = only?.length
    ? TALLY_COMPANIES.filter((c) => only.includes(c.key))
    : TALLY_COMPANIES.filter((c) => !c.paused);
  if (!companies.length || (only && companies.length !== only.length)) {
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
  // A PDF that fails to build mustn't cost the email; it goes without them.
  const pdfsFor = async (os: Outcome[]) => {
    try {
      return { pdfs: await buildLeaderPdfs(day, os) };
    } catch (e) {
      return { pdfs: [] as LeaderPdf[], pdfError: e instanceof Error ? e.message : String(e) };
    }
  };
  type Email = { sent: boolean; to: string[]; error?: string };
  const deliver = async (to: string[], mail: ReturnType<typeof compose>, pdfs: LeaderPdf[]): Promise<Email> => {
    if (!send) return { sent: false, to };
    const r = await sendEmail({
      to,
      ...mail,
      attachments: pdfs.map((p) => ({ filename: p.filename, content: p.content, contentType: "application/pdf" })),
    });
    return r.ok ? { sent: true, to } : { sent: false, to, error: r.error };
  };

  const { pdfs, pdfError } = await pdfsFor(outcomes);
  const mail = compose(day, outcomes, pdfs);
  const to = (process.env.TALLY_EMAIL_TO ?? DEFAULT_TO)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const email = await deliver(to, mail, pdfs);

  // Each casino's own recipients see that casino and nothing else: its section
  // alone, and a PDF built from it alone (a leader's PDF may hold other casinos).
  const casinoEmails = await Promise.all(
    companies
      .map((c, i) => ({ to: c.emailTo ?? [], o: outcomes[i] }))
      .filter(({ to }) => to.length)
      .map(async ({ to, o }) => {
        const one = await pdfsFor([o]);
        const sent = await deliver(to, compose(day, [o], one.pdfs), one.pdfs);
        return { company: o.company, ...sent, ...(one.pdfError ? { pdfError: one.pdfError } : {}) };
      }),
  );

  return Response.json(
    {
      ok: outcomes.every((o) => o.ok),
      day,
      companies: outcomes.map((o) =>
        o.ok
          ? {
              company: o.company,
              ok: true,
              sheet: o.sheet,
              toCheck: o.toCheck,
              stillOpen: o.stillOpen,
              banksDiffer: o.banksDiffer,
            }
          : { company: o.company, ok: false },
      ),
      subject: mail.subject,
      text: mail.text,
      pdfs: pdfs.map((p) => ({ leader: p.leader.name, filename: p.filename, bytes: p.content.length })),
      ...(pdfError ? { pdfError } : {}),
      email,
      casinoEmails,
    },
    // A report that should have gone out and didn't is the failure worth
    // flagging in Vercel's cron log.
    { status: send && [email, ...casinoEmails].some((e) => !e.sent) ? 500 : 200 },
  );
}

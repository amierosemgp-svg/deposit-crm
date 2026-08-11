"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, Calendar, Clock, Mail } from "lucide-react";
import { REPORT_DEFS, REPORT_TONE_CLASSES } from "@/lib/report-defs";
import { cn } from "@/lib/utils";

type ScheduledReport = {
  id: string;
  name: string;
  template: string;
  cadence: string;
  recipients: string[];
  lastRun: string;
  nextRun: string;
  active: boolean;
};

// Scheduled report definitions will come from the API once supported.
const SCHEDULED: ScheduledReport[] = [];

export default function ReportsPage() {
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);
  const users = useStore((s) => s.users);
  const companies = useStore((s) => s.companies)();

  const rowCounts: Record<string, number> = {
    daily_deposits: deposits.length,
    daily_withdrawals: withdrawals.length,
    ggr_summary: companies.length,
    cs_performance: users.length,
    bonus_payout: deposits.filter((d) => d.bonus_amount > 0).length,
    bank_reconciliation: deposits.length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Live financial &amp; operational reports — filter on the page, export
          to CSV
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Reports
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {REPORT_DEFS.map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.id}
                href={`/reports/${t.id}`}
                className="group cursor-pointer rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                      REPORT_TONE_CLASSES[t.tone],
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{t.title}</div>
                    <p className="mt-0.5 text-[12px] text-muted-foreground line-clamp-2">
                      {t.description}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">
                    {(rowCounts[t.id] ?? 0).toLocaleString()} rows · CSV export
                  </span>
                  <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    View report <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Scheduled */}
      <Card className="p-0 gap-0 overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Scheduled Reports
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Auto-generated and emailed on a recurring schedule
          </p>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Name</th>
                <th className="px-3 py-2.5 text-left font-medium">Template</th>
                <th className="px-3 py-2.5 text-left font-medium">Cadence</th>
                <th className="px-3 py-2.5 text-left font-medium">Recipients</th>
                <th className="px-3 py-2.5 text-left font-medium">Last / Next run</th>
                <th className="px-3 py-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {SCHEDULED.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-10 text-center text-xs text-muted-foreground"
                  >
                    No scheduled reports configured yet.
                  </td>
                </tr>
              )}
              {SCHEDULED.map((s) => (
                <tr key={s.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[12px]">{s.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">{s.id}</div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px]">{s.template}</td>
                  <td className="px-3 py-2.5 text-[12px] whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                      {s.cadence}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      {s.recipients.map((r) => (
                        <span key={r} className="inline-flex items-center gap-1 text-[11px]">
                          <Mail className="h-3 w-3 text-muted-foreground" />
                          {r}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-muted-foreground whitespace-nowrap">
                    <div>Last: {formatRelative(s.lastRun)}</div>
                    <div>Next: {formatDateTime(s.nextRun)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                        s.active
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
                      )}
                    >
                      <span
                        className={cn(
                          "mr-1.5 h-1.5 w-1.5 rounded-full",
                          s.active ? "bg-emerald-500" : "bg-zinc-400",
                        )}
                      />
                      {s.active ? "Active" : "Paused"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

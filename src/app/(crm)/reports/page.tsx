"use client";

import { useState, useMemo } from "react";
import { useStore } from "@/lib/store";
import { COMPANIES, CURRENT_USER, USERS } from "@/lib/mock-data";
import { formatRM, formatDateTime, formatRelative, initialsOf } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Download,
  RefreshCw,
  Trash2,
  Calendar,
  Mail,
  Clock,
  Building2,
  Wallet,
  Banknote,
  UserCog,
  Gift,
  ScrollText,
  Play,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Template = {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: "emerald" | "blue" | "amber" | "purple" | "rose" | "slate";
  rows: (deps: number, wds: number) => number;
};

const TEMPLATES: Template[] = [
  {
    id: "daily_deposits",
    title: "Daily Deposits Report",
    description:
      "Every completed deposit with player, bonus %, game, CS agent, and top-up reference.",
    icon: Wallet,
    tone: "emerald",
    rows: (d) => d,
  },
  {
    id: "daily_withdrawals",
    title: "Daily Withdrawals Report",
    description:
      "All withdrawal requests with pulled amount, bank payout status, and processing CS agent.",
    icon: Banknote,
    tone: "blue",
    rows: (_d, w) => w,
  },
  {
    id: "ggr_summary",
    title: "GGR Summary",
    description:
      "Per-company gross gaming revenue: deposits − withdrawals − bonuses.",
    icon: Building2,
    tone: "purple",
    rows: () => 5,
  },
  {
    id: "cs_performance",
    title: "CS Agent Performance",
    description:
      "Transactions handled, volume, and approval times per agent for the period.",
    icon: UserCog,
    tone: "amber",
    rows: () => 15,
  },
  {
    id: "bonus_payout",
    title: "Bonus Payout Report",
    description:
      "Total bonuses issued — broken down by bonus %, game provider, and company.",
    icon: Gift,
    tone: "rose",
    rows: (d) => d,
  },
  {
    id: "bank_reconciliation",
    title: "Bank Reconciliation",
    description:
      "Bank-detected deposits vs CRM-recorded vs game top-ups, with discrepancy flags.",
    icon: ScrollText,
    tone: "slate",
    rows: (d) => d,
  },
];

const TONE_CLASSES: Record<Template["tone"], string> = {
  emerald: "bg-emerald-500/10 text-emerald-600",
  blue: "bg-blue-500/10 text-blue-600",
  amber: "bg-amber-500/10 text-amber-600",
  purple: "bg-purple-500/10 text-purple-600",
  rose: "bg-rose-500/10 text-rose-600",
  slate: "bg-slate-500/10 text-slate-600",
};

type Format = "PDF" | "CSV" | "Excel";

type GeneratedReport = {
  id: string;
  templateId: string;
  title: string;
  dateFrom: string;
  dateTo: string;
  companyId: string;
  format: Format;
  size: string;
  generatedBy: number;
  generatedAt: string;
  rows: number;
};

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function seedReports(): GeneratedReport[] {
  return [
    {
      id: "RPT-24019",
      templateId: "ggr_summary",
      title: "GGR Summary",
      dateFrom: daysAgoStr(7),
      dateTo: daysAgoStr(1),
      companyId: "all",
      format: "PDF",
      size: "128 KB",
      generatedBy: 1,
      generatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      rows: 5,
    },
    {
      id: "RPT-24018",
      templateId: "daily_deposits",
      title: "Daily Deposits Report",
      dateFrom: daysAgoStr(1),
      dateTo: daysAgoStr(1),
      companyId: "1",
      format: "CSV",
      size: "46 KB",
      generatedBy: 101,
      generatedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      rows: 42,
    },
    {
      id: "RPT-24017",
      templateId: "cs_performance",
      title: "CS Agent Performance",
      dateFrom: daysAgoStr(30),
      dateTo: todayStr(),
      companyId: "all",
      format: "Excel",
      size: "212 KB",
      generatedBy: 11,
      generatedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      rows: 15,
    },
    {
      id: "RPT-24016",
      templateId: "bank_reconciliation",
      title: "Bank Reconciliation",
      dateFrom: daysAgoStr(2),
      dateTo: daysAgoStr(2),
      companyId: "all",
      format: "PDF",
      size: "88 KB",
      generatedBy: 1,
      generatedAt: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
      rows: 18,
    },
    {
      id: "RPT-24015",
      templateId: "bonus_payout",
      title: "Bonus Payout Report",
      dateFrom: daysAgoStr(14),
      dateTo: daysAgoStr(7),
      companyId: "2",
      format: "CSV",
      size: "33 KB",
      generatedBy: 12,
      generatedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
      rows: 28,
    },
    {
      id: "RPT-24014",
      templateId: "daily_withdrawals",
      title: "Daily Withdrawals Report",
      dateFrom: daysAgoStr(3),
      dateTo: daysAgoStr(3),
      companyId: "all",
      format: "CSV",
      size: "22 KB",
      generatedBy: 101,
      generatedAt: new Date(Date.now() - 3 * 24 * 3600_000 - 4 * 3600_000).toISOString(),
      rows: 14,
    },
    {
      id: "RPT-24013",
      templateId: "ggr_summary",
      title: "GGR Summary",
      dateFrom: daysAgoStr(60),
      dateTo: daysAgoStr(30),
      companyId: "all",
      format: "PDF",
      size: "142 KB",
      generatedBy: 1,
      generatedAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
      rows: 5,
    },
    {
      id: "RPT-24012",
      templateId: "daily_deposits",
      title: "Daily Deposits Report",
      dateFrom: daysAgoStr(5),
      dateTo: daysAgoStr(5),
      companyId: "3",
      format: "CSV",
      size: "39 KB",
      generatedBy: 13,
      generatedAt: new Date(Date.now() - 5 * 24 * 3600_000 - 6 * 3600_000).toISOString(),
      rows: 31,
    },
  ];
}

const SCHEDULED = [
  {
    id: "SCH-001",
    name: "Weekly GGR Summary",
    template: "GGR Summary",
    cadence: "Every Monday 08:00 MYT",
    recipients: ["admin@mpg.local", "finance@mpg.local"],
    lastRun: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    nextRun: new Date(Date.now() + 5 * 24 * 3600_000).toISOString(),
    active: true,
  },
  {
    id: "SCH-002",
    name: "Daily Deposits — All Companies",
    template: "Daily Deposits Report",
    cadence: "Every day 23:59 MYT",
    recipients: ["ops@mpg.local"],
    lastRun: new Date(Date.now() - 8 * 3600_000).toISOString(),
    nextRun: new Date(Date.now() + 16 * 3600_000).toISOString(),
    active: true,
  },
  {
    id: "SCH-003",
    name: "Monthly Bank Reconciliation",
    template: "Bank Reconciliation",
    cadence: "1st of each month 09:00 MYT",
    recipients: ["finance@mpg.local", "audit@mpg.local"],
    lastRun: new Date(Date.now() - 14 * 24 * 3600_000).toISOString(),
    nextRun: new Date(Date.now() + 16 * 24 * 3600_000).toISOString(),
    active: false,
  },
];

export default function ReportsPage() {
  const deposits = useStore((s) => s.deposits);
  const withdrawals = useStore((s) => s.withdrawals);

  const [openTpl, setOpenTpl] = useState<Template | null>(null);
  const [reports, setReports] = useState<GeneratedReport[]>(() => seedReports());

  function handleGenerated(r: GeneratedReport) {
    setReports((prev) => [r, ...prev]);
    toast.success(`${r.title} generated`, {
      description: `${r.rows} rows · ${r.size} · ${r.format}`,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate, download, and schedule financial &amp; operational reports
        </p>
      </div>

      {/* Templates */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Generate a new report
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {TEMPLATES.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setOpenTpl(t)}
                className="group rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                      TONE_CLASSES[t.tone],
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
                  <span className="text-muted-foreground">PDF · CSV · Excel</span>
                  <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    Configure <Play className="h-3 w-3" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Recent reports */}
      <Card className="p-0 gap-0 overflow-hidden">
        <CardHeader className="border-b flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Recent Reports
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Generated in the last 30 days · {reports.length} total
            </p>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Report</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Date Range</th>
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">Company</th>
                <th className="px-3 py-2.5 text-left font-medium">Format</th>
                <th className="px-3 py-2.5 text-right font-medium whitespace-nowrap">Rows</th>
                <th className="px-3 py-2.5 text-right font-medium">Size</th>
                <th className="px-3 py-2.5 text-left font-medium">Generated</th>
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const gen = USERS.find((u) => u.user_id === r.generatedBy);
                const company = r.companyId === "all"
                  ? "All Companies"
                  : COMPANIES.find((c) => String(c.company_id) === r.companyId)?.company_name ?? r.companyId;
                return (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-[12px]">{r.title}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        {r.id}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] whitespace-nowrap">
                      {r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} → ${r.dateTo}`}
                    </td>
                    <td className="px-3 py-2.5 text-[12px]">{company}</td>
                    <td className="px-3 py-2.5">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                          r.format === "PDF" && "bg-red-500/10 text-red-600",
                          r.format === "CSV" && "bg-emerald-500/10 text-emerald-600",
                          r.format === "Excel" && "bg-blue-500/10 text-blue-600",
                        )}
                      >
                        {r.format}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-[12px]">
                      {r.rows.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-[12px] text-muted-foreground">
                      {r.size}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar className="h-5 w-5">
                          <AvatarFallback className="text-[9px]">
                            {initialsOf(gen?.full_name ?? "?")}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-[11px]">{gen?.username ?? "—"}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatRelative(r.generatedAt)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() =>
                            toast.success(`Downloading ${r.id}.${r.format.toLowerCase()}…`)
                          }
                          title="Download"
                        >
                          <Download className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() => toast.info("Re-running report…")}
                          title="Re-run"
                        >
                          <RefreshCw className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={() =>
                            setReports((prev) => prev.filter((x) => x.id !== r.id))
                          }
                          title="Delete"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {reports.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No reports generated yet. Pick a template above to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

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
                          ? "bg-emerald-500/10 text-emerald-700"
                          : "bg-zinc-500/10 text-zinc-600",
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

      <GenerateDialog
        template={openTpl}
        onOpenChange={(o) => !o && setOpenTpl(null)}
        onGenerated={(r) => handleGenerated(r)}
        depositCount={deposits.length}
        withdrawalCount={withdrawals.length}
      />
    </div>
  );
}

function GenerateDialog({
  template,
  onOpenChange,
  onGenerated,
  depositCount,
  withdrawalCount,
}: {
  template: Template | null;
  onOpenChange: (open: boolean) => void;
  onGenerated: (r: GeneratedReport) => void;
  depositCount: number;
  withdrawalCount: number;
}) {
  const [dateFrom, setDateFrom] = useState(daysAgoStr(7));
  const [dateTo, setDateTo] = useState(todayStr());
  const [companyId, setCompanyId] = useState<string>("all");
  const [format, setFormat] = useState<Format>("PDF");
  const [loading, setLoading] = useState(false);

  const open = template !== null;
  const Icon = template?.icon;

  const rowEstimate = useMemo(() => {
    if (!template) return 0;
    return template.rows(depositCount, withdrawalCount);
  }, [template, depositCount, withdrawalCount]);

  function handleGenerate() {
    if (!template) return;
    setLoading(true);
    setTimeout(() => {
      const size =
        format === "PDF"
          ? `${80 + Math.floor(Math.random() * 120)} KB`
          : format === "CSV"
            ? `${20 + Math.floor(Math.random() * 80)} KB`
            : `${150 + Math.floor(Math.random() * 250)} KB`;
      onGenerated({
        id: `RPT-${24020 + Math.floor(Math.random() * 99)}`,
        templateId: template.id,
        title: template.title,
        dateFrom,
        dateTo,
        companyId,
        format,
        size,
        generatedBy: CURRENT_USER.user_id,
        generatedAt: new Date().toISOString(),
        rows: rowEstimate,
      });
      setLoading(false);
      onOpenChange(false);
    }, 1200);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {template && Icon && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    TONE_CLASSES[template.tone],
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <DialogTitle>{template.title}</DialogTitle>
                  <DialogDescription>{template.description}</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>From</Label>
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>To</Label>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Company</Label>
                <Select value={companyId} onValueChange={(v) => setCompanyId(v ?? "all")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Companies</SelectItem>
                    {COMPANIES.map((c) => (
                      <SelectItem key={c.company_id} value={String(c.company_id)}>
                        {c.company_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Output format</Label>
                <div className="grid grid-cols-3 gap-2">
                  {(["PDF", "CSV", "Excel"] as Format[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={cn(
                        "h-9 rounded-md border text-sm font-medium transition-colors",
                        format === f
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-input bg-background hover:bg-muted",
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-md border bg-muted/30 p-3 text-[11px] space-y-0.5">
                <div className="font-medium text-foreground">Preview estimate</div>
                <div className="text-muted-foreground">
                  ~{rowEstimate.toLocaleString()} rows · {format} output · delivered to your
                  browser
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
                Cancel
              </Button>
              <Button onClick={handleGenerate} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <FileText className="h-3.5 w-3.5" />
                    Generate Report
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

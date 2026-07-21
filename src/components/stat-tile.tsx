import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "warning" | "success" | "danger";

const TONE_CLASSES: Record<StatTone, string> = {
  default: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-600",
  success: "bg-emerald-500/10 text-emerald-600",
  danger: "bg-rose-500/10 text-rose-600",
};

/**
 * A KPI/summary tile — an uppercase label, a big value, an optional sub-line,
 * and a tinted icon. Shared by the dashboard, reports, and player profile.
 */
export function StatTile({
  title,
  value,
  sub,
  icon: Icon,
  tone = "default",
  valueClassName,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: StatTone;
  /** Optional extra classes for the value text (e.g. green/red for profit). */
  valueClassName?: string;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1 px-5">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {title}
        </CardTitle>
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-md ${TONE_CLASSES[tone]}`}
        >
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div className={cn("text-2xl font-bold", valueClassName)}>{value}</div>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "warning" | "success" | "danger";

const TONE_CLASSES: Record<StatTone, string> = {
  default: "bg-primary/10 text-primary",
  warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  danger: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

/**
 * A KPI/summary tile — an uppercase label, a big value, an optional sub-line,
 * and a tinted icon. Shared by the dashboard, reports, and player profile.
 *
 * `compact` is the same tile with the air taken out, for places that show four
 * of them above a table the reader actually came for. The dashboard keeps the
 * roomy one: there the tiles are the page, here they are a caption to it.
 */
export function StatTile({
  title,
  value,
  sub,
  icon: Icon,
  tone = "default",
  valueClassName,
  compact = false,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: StatTone;
  /** Optional extra classes for the value text (e.g. green/red for profit). */
  valueClassName?: string;
  compact?: boolean;
}) {
  return (
    <Card className={compact ? "gap-0.5 py-2.5" : "gap-2 py-4"}>
      <CardHeader
        className={cn(
          "flex flex-row items-center justify-between space-y-0",
          compact ? "px-3.5 pb-0" : "px-5 pb-1",
        )}
      >
        <CardTitle
          className={cn(
            "font-medium text-muted-foreground uppercase tracking-wide",
            compact ? "text-[10px]" : "text-xs",
          )}
        >
          {title}
        </CardTitle>
        <div
          className={cn(
            "flex items-center justify-center rounded-md",
            TONE_CLASSES[tone],
            compact ? "h-6 w-6" : "h-8 w-8",
          )}
        >
          <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </div>
      </CardHeader>
      <CardContent className={compact ? "px-3.5" : "px-5"}>
        <div
          className={cn(
            "font-bold tabular-nums",
            compact ? "text-lg leading-tight" : "text-2xl",
            valueClassName,
          )}
        >
          {value}
        </div>
        {sub && (
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-[10px] leading-tight" : "text-[11px] mt-0.5",
            )}
          >
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

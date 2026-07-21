import { isOnline, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Live status pill for a kiosk / bank account. Green + pulse when the bot has
 * pinged recently, grey/red when stale or never seen.
 */
export function HeartbeatDot({
  lastHeartbeatAt,
  showLabel = true,
  className,
}: {
  lastHeartbeatAt: string | null | undefined;
  showLabel?: boolean;
  className?: string;
}) {
  const online = isOnline(lastHeartbeatAt);
  const label = !lastHeartbeatAt
    ? "Never"
    : online
      ? "Online"
      : `Offline · ${formatRelative(lastHeartbeatAt)}`;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      title={lastHeartbeatAt ? `Last ping ${formatRelative(lastHeartbeatAt)}` : "No heartbeat yet"}
    >
      <span className="relative flex h-2 w-2">
        {online && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            online ? "bg-emerald-500" : lastHeartbeatAt ? "bg-red-500" : "bg-zinc-400",
          )}
        />
      </span>
      {showLabel && (
        <span
          className={cn(
            "text-[11px] font-medium",
            online
              ? "text-emerald-700"
              : lastHeartbeatAt
                ? "text-red-600"
                : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      )}
    </span>
  );
}

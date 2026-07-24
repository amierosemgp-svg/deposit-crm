import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Centered spinner row shown while a list is waiting for store hydration. */
export function ListLoading({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground",
        className,
      )}
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}

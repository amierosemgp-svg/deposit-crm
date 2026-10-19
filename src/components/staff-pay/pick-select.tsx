"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type PickItem = { value: string; label: string };

/**
 * A Select that knows its labels — Base UI shows the raw value in the trigger
 * unless it is told what each value is called.
 */
export function PickSelect({
  value,
  onChange,
  items,
  placeholder,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  items: PickItem[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")} items={items} disabled={disabled}>
      <SelectTrigger className={cn("w-full cursor-pointer", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((it) => (
          <SelectItem key={it.value} value={it.value} className="cursor-pointer">
            {it.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Loader2, ShieldAlert } from "lucide-react";
import { useStore } from "@/lib/store";
import { formatRM } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BONUS_PERIOD_LABELS, BONUS_TYPE_LABELS, type BonusOption } from "@/lib/types";

/**
 * Pick the bonus for a deposit.
 *
 * The old control was a list of percentages, which put the whole rule in CS's
 * head: is this their first deposit, have they had today's already, are they
 * actually down this week. This asks the server instead, so every bonus arrives
 * with a yes or a no and the no arrives with its reason attached — a greyed-out
 * row that explains itself is how the rules get learned.
 *
 * Eligibility is fetched when the menu opens, never cached: it turns on the
 * player's live deposit and withdrawal history, and a stale "eligible" is
 * precisely the answer that would mislead.
 */
export function BonusPicker({
  playerId,
  depositAmount,
  depositId,
  planId,
  percentage,
  overrideReason,
  onPick,
  disabled,
  className,
  align = "start",
}: {
  playerId: number | null;
  depositAmount: number;
  /** The deposit being edited, so it never disqualifies itself. */
  depositId?: number;
  planId: number | null | undefined;
  percentage: number;
  overrideReason?: string | null;
  onPick: (choice: {
    bonus_plan_id: number | null;
    bonus_override_reason?: string;
  }) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
}) {
  const me = useStore((s) => s.me);
  const fetchBonusOptions = useStore((s) => s.fetchBonusOptions);
  const bonusPlanById = useStore((s) => s.bonusPlanById);

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<BonusOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The ineligible plan an admin is in the middle of forcing through, if any.
  const [overriding, setOverriding] = useState<BonusOption | null>(null);
  const [reason, setReason] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Where to draw the menu, in viewport coordinates. The deposits table scrolls
  // inside a container with overflow-x, which clips on both axes — so the menu
  // is portalled to the body and positioned against the trigger by hand.
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    above: boolean;
  } | null>(null);

  const canOverride = me?.role === "super_admin" || me?.role === "company_leader";
  const plan = bonusPlanById(planId);

  const label = plan
    ? `${plan.name} · ${plan.percentage}%`
    : percentage > 0
      ? `${percentage}%`
      : "No bonus";

  function close() {
    setOpen(false);
    setOverriding(null);
    setReason("");
    setPos(null);
  }

  const MENU_WIDTH = 290;
  const MENU_MAX_HEIGHT = 340;

  function place() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, MENU_WIDTH);
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip up only when below genuinely can't hold it and above can do better.
    const above = spaceBelow < MENU_MAX_HEIGHT && r.top > spaceBelow;
    const left = align === "end" ? r.right - width : r.left;
    setPos({
      top: above ? r.top - 4 : r.bottom + 4,
      // Keep it on screen on narrow viewports.
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      width,
      above,
    });
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      // The menu lives outside this subtree now, so it has to be checked too.
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // Capture, so scrolling the table's own container repositions it too.
    function reposition() {
      place();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function load() {
    if (playerId == null) {
      setOptions([]);
      setError("Assign a player before picking a bonus");
      return;
    }
    setLoading(true);
    setError(null);
    const res = await fetchBonusOptions({
      playerId,
      amount: depositAmount,
      depositId,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? "Could not load bonuses");
      setOptions([]);
      return;
    }
    setOptions(res.options ?? []);
  }

  function toggle() {
    if (open) return close();
    place();
    setOpen(true);
    void load();
  }

  async function pick(choice: {
    bonus_plan_id: number | null;
    bonus_override_reason?: string;
  }) {
    close();
    await onPick(choice);
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        title={overrideReason ?? undefined}
        className={cn(
          "flex h-7 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-background px-2 text-[12px] outline-none",
          "cursor-pointer hover:border-ring/60 focus:border-ring focus:ring-2 focus:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span className={cn("truncate", !plan && percentage === 0 && "text-muted-foreground")}>
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {overrideReason && (
            <ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-400" />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: pos.width,
            transform: pos.above ? "translateY(-100%)" : undefined,
          }}
          className="z-50 overflow-hidden rounded-md border bg-popover shadow-md"
        >
          <button
            type="button"
            onClick={() => void pick({ bonus_plan_id: null })}
            className="flex w-full cursor-pointer items-center justify-between px-2.5 py-2 text-left text-[13px] hover:bg-muted"
          >
            <span>No bonus</span>
            {!planId && percentage === 0 && (
              <Check className="h-3.5 w-3.5 text-primary" />
            )}
          </button>

          <div className="max-h-72 overflow-y-auto border-t">
            {loading && (
              <div className="flex items-center gap-2 px-2.5 py-3 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking what this player qualifies for…
              </div>
            )}

            {!loading && error && (
              <div className="px-2.5 py-3 text-[12px] text-amber-700 dark:text-amber-400">
                {error}
              </div>
            )}

            {!loading && !error && options?.length === 0 && (
              <div className="px-2.5 py-3 text-[12px] text-muted-foreground">
                No bonuses set up yet — an admin adds them on the Bonuses page.
              </div>
            )}

            {!loading &&
              !error &&
              options?.map((option) => {
                const isOverriding = overriding?.plan_id === option.plan_id;
                return (
                  <div key={option.plan_id} className="border-b last:border-b-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (option.eligible) {
                          void pick({ bonus_plan_id: option.plan_id });
                        } else if (canOverride) {
                          setOverriding(isOverriding ? null : option);
                          setReason("");
                        }
                      }}
                      disabled={!option.eligible && !canOverride}
                      className={cn(
                        "flex w-full items-start justify-between gap-2 px-2.5 py-2 text-left",
                        option.eligible
                          ? "cursor-pointer hover:bg-muted"
                          : canOverride
                            ? "cursor-pointer opacity-70 hover:bg-muted"
                            : "cursor-not-allowed opacity-55",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">
                            {option.name}
                          </span>
                          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                            {option.period
                              ? BONUS_PERIOD_LABELS[option.period]
                              : BONUS_TYPE_LABELS[option.type]}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                          {option.eligible ? (
                            <>
                              {option.percentage}% of{" "}
                              {option.type === "rebate"
                                ? `${formatRM(option.basis_amount)} lost`
                                : "the deposit"}
                            </>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400">
                              {option.reason}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={cn(
                            "block text-[12px] font-semibold",
                            option.eligible
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {option.eligible ? formatRM(option.bonus_amount) : "—"}
                        </span>
                        {planId === option.plan_id && (
                          <Check className="ml-auto mt-0.5 h-3.5 w-3.5 text-primary" />
                        )}
                      </span>
                    </button>

                    {isOverriding && (
                      <div className="space-y-2 border-t bg-amber-50 px-2.5 py-2 dark:bg-amber-950/40">
                        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                          This player isn&apos;t entitled to it. Say why — it goes
                          on the deposit and into the audit log.
                        </p>
                        <input
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && reason.trim()) {
                              e.preventDefault();
                              void pick({
                                bonus_plan_id: option.plan_id,
                                bonus_override_reason: reason.trim(),
                              });
                            }
                          }}
                          placeholder="Reason for the override"
                          className="h-7 w-full rounded-md border border-input bg-background px-2 text-[12px] outline-none focus:border-ring"
                        />
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setOverriding(null)}
                            className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!reason.trim()}
                            onClick={() =>
                              void pick({
                                bonus_plan_id: option.plan_id,
                                bonus_override_reason: reason.trim(),
                              })
                            }
                            className="cursor-pointer rounded-md bg-amber-600 px-2 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Apply anyway
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

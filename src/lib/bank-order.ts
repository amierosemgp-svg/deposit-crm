/**
 * The order the operator's own workbook lists bank accounts in.
 *
 * Fixed, not alphabetical and not whatever the database returns: the desk
 * reads these cards against a sheet they have used for years, and an account
 * that moves is an account they have to hunt for. Rows also came back in
 * update order, so saving a deposit reshuffled the list under the cursor.
 *
 * Matched on the account's label — "AMBANK 2", "CIMB 3" — ignoring case and
 * spacing. An account matching nothing here still shows; it sorts to the
 * bottom, alphabetically, so an unanticipated label is visible and easy to fix
 * rather than silently gone.
 */
const BANK_ORDER: readonly string[] = [
  "MBB", "CIMB", "PBB", "HLBB", "RHB", "AMBANK", "BSN", "GoPay",
  "MBB 2", "CIMB 2", "PBB 2", "HLBB 2", "RHB 2", "AMBANK 2", "BSN 2",
  "MBB 3", "CIMB 3", "PBB 3", "HLBB 3", "RHB 3", "AMBANK 3", "BSN 3",
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const RANK = new Map<string, number>(BANK_ORDER.map((name, i) => [key(name), i]));

/** Where an account sits in the workbook's order; unknown ones go last. */
export function bankRank(label?: string | null): number {
  return RANK.get(key(label ?? "")) ?? Number.MAX_SAFE_INTEGER;
}

/** Sort comparator: workbook order, then by label so ties never shuffle. */
export function byBankOrder<T extends { label?: string | null; bank_name?: string }>(
  a: T,
  b: T,
): number {
  const ra = bankRank(a.label), rb = bankRank(b.label);
  if (ra !== rb) return ra - rb;
  return (a.label ?? a.bank_name ?? "").localeCompare(b.label ?? b.bank_name ?? "");
}

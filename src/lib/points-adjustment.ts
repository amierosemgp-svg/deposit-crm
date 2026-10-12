/**
 * A deposit keyed with no bank is a points-only adjustment: CS keyed points
 * wrong and puts them right through the Deposit sheet. The kiosk and the
 * player's game move as for any deposit, but no money came in, so it books no
 * bank, adds nothing to total_deposits, earns no recommend bonus, and is left
 * out of every deposit / sales / win-loss total. The row is marked by this
 * bank_name (deposits.bank_name is NOT NULL, and an imported row also has no
 * account, so a null account alone can't tell the two apart).
 */
export const POINTS_ONLY_BANK = "Points adjustment";

export const isPointsOnly = (row: { bank_name: string | null }) =>
  row.bank_name === POINTS_ONLY_BANK;

/**
 * A withdrawal keyed with "Forfeit" in Paid From: the player's points are
 * taken back into the kiosk and nobody is paid. It is pulled and never paid,
 * so it stays at credits_pulled — which no withdrawal total counts (they
 * count paid rows only) — and is kept out of the "waiting to be paid" queues.
 * The row is marked by this bank_name; the Remark says why.
 */
export const POINTS_FORFEIT_BANK = "Points forfeit";

/** What the Paid From cell says for a forfeit. */
export const FORFEIT_PAID_FROM = "Forfeit";

export const isForfeit = (row: { bank_name?: string | null }) =>
  row.bank_name === POINTS_FORFEIT_BANK;

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

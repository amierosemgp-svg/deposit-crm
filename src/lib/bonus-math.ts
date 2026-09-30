/**
 * How a bonus is worked out — the arithmetic only, no database.
 *
 * Kept apart from lib/bonus.ts so the worksheet can use the same function: that
 * module reaches for the db and the session, which a client component cannot
 * import. Sharing the rule is the whole point — three copies of it is how the
 * figure CS reads before saving ends up fifty cents from the one that lands.
 */

/**
 * A percentage of a figure, to the cent: RM 50 at 5% is RM 2.50.
 *
 * It was floored to whole ringgit for a while (a0be4c5, to match Pokercity's
 * book); the house pays the decimals, so that was reverted on 2026-09-30.
 */
export function bonusOn(base: number, percentage: number): number {
  return +((base * percentage) / 100).toFixed(2);
}

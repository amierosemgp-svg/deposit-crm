/**
 * How a bonus is worked out — the arithmetic only, no database.
 *
 * Kept apart from lib/bonus.ts so the worksheet can use the same function: that
 * module reaches for the db and the session, which a client component cannot
 * import. Sharing the rule is the whole point — three copies of it is how the
 * figure CS reads before saving ends up fifty cents from the one that lands.
 */

/**
 * A percentage of a figure, floored to whole ringgit.
 *
 * The house pays down, never up: RM 50 at 5% is RM 2, not RM 2.50. All 1,877
 * bonuses in the operator's own book do this — rounding to the nearest cent
 * matches only 1,343 of them.
 */
export function bonusOn(base: number, percentage: number): number {
  return Math.floor((base * percentage) / 100);
}

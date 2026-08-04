import type { BankAccount } from "./types";

/**
 * Malaysian bank abbreviations bots are named after. `hlb-ebca249a` is a Hong
 * Leong bot; nothing in the bank name itself says so.
 */
const BANK_ALIASES = [
  "maybank",
  "mbb",
  "cimb",
  "hongleong",
  "hlb",
  "publicbank",
  "pbb",
  "rhb",
  "ambank",
  "bsn",
  "ocbc",
  "uob",
  "hsbc",
  "affin",
  "alliance",
  "bimb",
  "muamalat",
];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Is this bot driving a bank login or a game kiosk?
 *
 * Deliberately matches **banks** and defaults everything else to kiosk, rather
 * than matching games. Banks are a small closed set; game providers are
 * open-ended and new ones appear without a kiosk record existing yet —
 * `allcity`, `pussy888` and `kiss918` all have no provider row today. Matching
 * games would silently drop those, and a bot vanishing from a health page is
 * the one failure this page must not have.
 *
 * Bot ids carry a suffix (`maybank-9b0100…`, `bsn-0200NX…`), so this matches on
 * prefix after stripping punctuation.
 */
export function botCategory(
  botId: string,
  bankNames: string[] = [],
): "bank" | "kiosk" {
  const id = normalize(botId);
  const tokens = [...BANK_ALIASES, ...bankNames.map(normalize)].filter(Boolean);
  return tokens.some((t) => id.startsWith(t)) ? "bank" : "kiosk";
}

/** Bank names actually configured, so a bank we don't hardcode still matches. */
export function bankNamesFrom(accounts: BankAccount[], settingsBanks: string[]) {
  return [...accounts.map((a) => a.bank_name), ...settingsBanks];
}

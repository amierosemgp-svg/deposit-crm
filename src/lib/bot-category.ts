import type { BankAccount } from "./types";

/**
 * Malaysian bank abbreviations agents are named after. `hlb-ebca249a` is a Hong
 * Leong agent; nothing in the bank name itself says so.
 */
const BANK_ALIASES: Record<string, string[]> = {
  maybank: ["maybank", "mbb"],
  cimb: ["cimb"],
  hongleong: ["hongleong", "hlb"],
  publicbank: ["publicbank", "pbb"],
  rhb: ["rhb"],
  ambank: ["ambank"],
  bsn: ["bsn"],
  ocbc: ["ocbc"],
  uob: ["uob"],
  hsbc: ["hsbc"],
  affin: ["affin"],
  alliance: ["alliance"],
  bankislam: ["bankislam", "bimb"],
  muamalat: ["muamalat"],
};

const ALL_BANK_PREFIXES = Object.values(BANK_ALIASES).flat();

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Is this agent driving a bank login or a game kiosk?
 *
 * Deliberately matches **banks** and defaults everything else to kiosk, rather
 * than matching games. Banks are a small closed set; game providers are
 * open-ended and new ones appear without a kiosk record existing yet —
 * `allcity`, `pussy888` and `kiss918` all have no provider row today. Matching
 * games would silently drop those, and an agent vanishing from a health page is
 * the one failure this page must not have.
 *
 * Agent ids carry a suffix (`maybank-9b0100…`, `bsn-0200NX…`), so this matches on
 * prefix after stripping punctuation.
 */
export function botCategory(
  botId: string,
  bankNames: string[] = [],
): "bank" | "kiosk" {
  const id = normalize(botId);
  const tokens = [...ALL_BANK_PREFIXES, ...bankNames.map(normalize)].filter(
    Boolean,
  );
  return tokens.some((t) => id.startsWith(t)) ? "bank" : "kiosk";
}

/**
 * The agent process driving a given bank or game — matched on the same id prefix
 * `botCategory` classifies on, with the alias table so `hlb-ebca249a` is found
 * for "Hong Leong". Game names need no aliases: kiosk agents are named after the
 * provider (`mega888-…`).
 *
 * Only the *bank or game* is encoded in an agent id, never which account it is on,
 * so two accounts at the same bank resolve to the same agent. That is the real
 * granularity available — a per-account signal would have to come from the agent.
 */
export function botForName<T extends { bot_id: string }>(
  bots: T[],
  bankOrGameName: string | null | undefined,
): T | undefined {
  const name = normalize(bankOrGameName ?? "");
  if (!name) return undefined;
  const prefixes = BANK_ALIASES[name] ?? [name];
  return bots.find((b) => {
    const id = normalize(b.bot_id);
    return prefixes.some((p) => id.startsWith(p));
  });
}

/** Bank names actually configured, so a bank we don't hardcode still matches. */
export function bankNamesFrom(accounts: BankAccount[], settingsBanks: string[]) {
  return [...accounts.map((a) => a.bank_name), ...settingsBanks];
}

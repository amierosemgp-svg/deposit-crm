/**
 * Pull the counterparty name out of a bank transaction remark.
 *
 * Malaysian statements write an inbound transfer as
 *   `MBB CT- HAZMAN FOOD ENTERPR*Payment`
 *   `Payment THARSHINI A/P BOGHI*Sent from AmOn`
 * — a channel prefix, the counterparty (truncated by the bank to ~19 chars),
 * then `*` and the transaction type. Everything before the `*`, minus the
 * prefix, is the sender.
 *
 * Some remarks carry no counterparty at all (`Fund Trf fr CA to CA-Internet`,
 * `CDM CASH DEPOSIT`, `Instant Transfer`) — those return null rather than a
 * fragment of the transaction type.
 *
 * IMPORTANT — this is NOT the player. On the live data every recurring sender
 * is a merchant or agent account (`HAZMAN FOOD ENTERPR` appears across nine
 * deposits from different players), because money arrives through third-party
 * payment channels. Matching a player on this name would misassign
 * confidently. It is shown to tell CS which channel the money came through,
 * and nothing more.
 */

/** Channel noise the bank prepends before the counterparty. */
const LEADING_NOISE =
  /^(mbb\s*ct-|ibg payment into a\/c|duitnow transfer|instant transfer|fund transfer|payment)\s*/i;

/** Remarks that are a transaction type with no counterparty in them. */
const NO_COUNTERPARTY =
  /^(fund trf|instant transfer|cdm cash deposit|ca online|atm |cash deposit)/i;

export function extractSenderName(
  description: string | null | undefined,
): string | null {
  const raw = (description ?? "").trim();
  if (!raw || NO_COUNTERPARTY.test(raw)) return null;
  if (!raw.includes("*")) return null;

  let name = raw.split("*", 1)[0].trim();
  // Strip repeatedly: "payment MFF SMART TRADING" carries two layers.
  let previous = "";
  while (previous !== name) {
    previous = name;
    name = name.replace(LEADING_NOISE, "").trim();
  }
  name = name.replace(/[\s-]+$/, "").trim();

  // Guard against a leftover scrap of the transaction type.
  if (name.length < 4) return null;
  if (!/[A-Za-z]{3}/.test(name)) return null;
  return name;
}

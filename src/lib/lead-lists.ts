/** Format a member/lead code: prefix + zero-padded sequence (AZ0001). */
export function formatCode(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

// ---------- Reading a pasted lead list ----------

export type ParsedLead = {
  line: number;
  /** Blank when the source sheet had no number for this lead. */
  phone: string;
  name: string;
  telegram?: string;
  error?: string;
};

/** Header words a first line may be made of — dropped rather than imported. */
const HEADER_WORDS =
  /^(phone|contact|contact_number|number|mobile|hp|name|full_name|telegram|telegram_username)$/i;

function isHeaderLine(cols: string[]): boolean {
  const filled = cols.filter(Boolean);
  return (
    filled.length > 0 &&
    filled.every((c) => HEADER_WORDS.test(c.replace(/\s+/g, "_")))
  );
}

/** Digits and the punctuation phone numbers are written with — no letters. */
function isNumeric(v: string): boolean {
  return /^[+\d][\d\s()+.\-]*$/.test(v);
}

/** A real number, not a stray "12" — Malaysian mobiles run 9–11 digits. */
function looksLikePhone(v: string): boolean {
  return isNumeric(v) && v.replace(/\D/g, "").length >= 7;
}

/**
 * Split a pasted/CSV block into lead rows. One lead per line:
 * phone, name[, telegram]. Commas or tabs separate columns; a header line is
 * dropped.
 *
 * The phone is optional — plenty of bought lists arrive as names only, and
 * refusing them meant retyping the sheet. A first column that reads as a
 * number is the phone; anything else (or a blank one) means the line starts
 * at the name. Only the name is actually required.
 *
 * A lead with no phone can't be matched to an existing person, so it lands as
 * a fresh person flagged for review — the modal says so before importing.
 */
export function parseLeads(text: string): ParsedLead[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: ParsedLead[] = [];
  lines.forEach((raw, i) => {
    if (!raw) return;
    const cols = raw.split(/[\t,]/).map((c) => c.trim());
    if (i === 0 && isHeaderLine(cols)) return;

    // A first column that's numeric but too short is a typo, not a name —
    // say so rather than quietly importing "0191" as somebody's name.
    if (cols[0] && isNumeric(cols[0]) && !looksLikePhone(cols[0])) {
      out.push({ line: i + 1, phone: cols[0], name: cols[1] ?? "", error: "Phone looks invalid" });
      return;
    }

    let phone = "";
    let rest = cols;
    if (looksLikePhone(cols[0] ?? "")) {
      phone = cols[0];
      rest = cols.slice(1);
    } else if (cols[0] === "") {
      rest = cols.slice(1); // an empty phone column, then the name
    }

    const name = rest[0] ?? "";
    const telegram = rest[1] || undefined;
    if (!name) {
      out.push({ line: i + 1, phone, name: "", error: "Needs a name" });
      return;
    }
    out.push({ line: i + 1, phone, name, telegram });
  });
  return out;
}

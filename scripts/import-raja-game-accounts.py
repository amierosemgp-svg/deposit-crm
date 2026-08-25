"""
Backfill game_accounts for the Raja roster imported on 2026-08-12.

The source (`raja 10-8.xlsx`) stores game accounts as ONE COLUMN PER GAME —
eighteen of them, `3win8` through `XE88`. The CSV importer reads the opposite
shape: a single `game_accounts` cell packed as "Mega888:0905|XE88:1234". The
conversion to CSV kept only the left-hand columns, so 3,116 accounts across
2,608 players were dropped without an error — a missing column and an empty one
look identical to the parser.

This repairs the players in place. They already exist and their usernames match
the sheet's `Code` exactly (verified 2617/2617, no duplicates), so this is an
UPDATE keyed on username, never an insert.

Usage:
    python3 import-raja-game-accounts.py <xlsx>            # dry run
    python3 import-raja-game-accounts.py <xlsx> --apply    # write
"""
import collections
import json
import os
import subprocess
import sys

import openpyxl

# The sheet's header spellings that differ from the CRM catalogue.
#   Scr918Kiss — 918Kiss's former name (SCR888), confirmed as the same product.
#   Joker123   — the platform's full name; the catalogue calls it Joker.
# LuckyPalace is deliberately NOT mapped: it was added to the catalogue as a
# game in its own right rather than folded into LPE88.
GAME_ALIASES = {
    "Scr918Kiss": "918Kiss",
    "Joker123": "Joker",
}

CODE_COL = 0
FIRST_GAME_COL = 11


def clean(value):
    """Cells arrive with stray tabs from the original export."""
    return "" if value is None else str(value).replace("\t", "").strip()


def psql(dsn, sql, quiet=False):
    out = subprocess.run(
        ["psql", dsn, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode:
        sys.exit(f"psql failed:\n{out.stderr}")
    if not quiet and out.stdout.strip():
        print(out.stdout.strip())
    return out.stdout


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path, apply = sys.argv[1], "--apply" in sys.argv
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set")

    rows = list(
        openpyxl.load_workbook(path, read_only=True, data_only=True)["Sheet1"]
        .iter_rows(values_only=True)
    )
    header = [clean(v) for v in rows[0]]
    games = header[FIRST_GAME_COL:]

    catalogue = json.loads(
        psql(dsn, "select value from settings where key='games'", quiet=True)
    )
    lower = {g.lower(): g for g in catalogue}

    # Resolve every column heading up front: an unmapped name must stop the run
    # rather than quietly drop that provider's accounts, which is the exact
    # failure this script exists to undo.
    resolved, unknown = {}, []
    for g in games:
        target = GAME_ALIASES.get(g, g)
        canonical = lower.get(target.lower())
        if canonical:
            resolved[g] = canonical
        else:
            unknown.append(g)

    payload, per_game, skipped = {}, collections.Counter(), []
    for row in rows[1:]:
        code = clean(row[CODE_COL] if CODE_COL < len(row) else None)
        if not code:
            continue
        accounts = []
        for offset, column in enumerate(games):
            idx = FIRST_GAME_COL + offset
            login = clean(row[idx] if idx < len(row) else None)
            if not login:
                continue
            if column in unknown:
                skipped.append((code, column, login))
                continue
            accounts.append(
                {"game_name": resolved[column], "game_username": login}
            )
            per_game[resolved[column]] += 1
        if accounts:
            payload[code] = accounts

    print(f"players in sheet:        {len(rows) - 1}")
    print(f"players with accounts:   {len(payload)}")
    print(f"accounts to write:       {sum(per_game.values())}")
    print("\nper game:")
    for game, count in per_game.most_common():
        alias = [k for k, v in resolved.items() if v == game and k != game]
        note = f"   (from '{alias[0]}')" if alias else ""
        print(f"  {game:<14} {count}{note}")
    if unknown:
        print(f"\nheadings with no catalogue match: {unknown}")
        if skipped:
            sys.exit(
                f"\nABORT: {len(skipped)} accounts sit under unmatched headings "
                f"{sorted({s[1] for s in skipped})}. Add them to the catalogue "
                "or add an alias, then re-run."
            )
        print("  (all empty — nothing lost)")

    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    # One statement, one transaction: a partial backfill would leave the roster
    # in two states with no way to tell which players had been done.
    def lit(text):
        """A single-quoted SQL literal; doubling embedded quotes."""
        return "'" + str(text).replace("'", "''") + "'"

    values = ",".join(
        f"({lit(code)},{lit(json.dumps(accounts))}::jsonb)"
        for code, accounts in payload.items()
    )
    sql = f"""
BEGIN;
CREATE TEMP TABLE incoming(username text primary key, accounts jsonb) ON COMMIT DROP;
INSERT INTO incoming(username, accounts) VALUES {values};
UPDATE players p SET game_accounts = i.accounts
FROM incoming i WHERE p.username = i.username;
SELECT count(*) AS updated FROM players p JOIN incoming i USING (username)
WHERE p.game_accounts = i.accounts;
COMMIT;
"""
    print("\nwriting…")
    print(psql(dsn, sql).strip(), "players updated")


if __name__ == "__main__":
    main()

"""
Import Pokercity's trading history into the casino seeded by seed-tree.ts.

The source is the operator's own working spreadsheet, not an export: the first
dozen rows of every sheet are a dashboard, the transaction table starts further
down, and the columns to the right of it are summary blocks that run past the
last real row. Nothing in it is labelled as authoritative, so the dashboard is
used the only way it can be trusted — as an independent check. Every figure the
importer derives from the transaction rows is compared against the dashboard's
own totals before a single row is written, and a mismatch aborts the run.

What lands in the CRM
---------------------
    entities        main company → leader → company → CS desk (new, empty tree)
    users           one login per role, password from --password
    bank_accounts   one per bank the dashboard tracks, opening + closing balance
    provider_bo_accounts   one kiosk per game, credit = the month's closing figure
    people/players  one person + one member per member code seen anywhere
    member_game_accounts / member_bank_accounts
    deposits        every bank credit, with its bonus
    referral_bonuses     the REKEMEN rows, linked upline → downline
    withdrawals     every payout against a game product
    bank_cash_outs  Clear Bank / Bank Charge / Expenses — bank movement with no player
    game_transfers  the ID TO ID pairs
    transactions    the ledger row(s) each of the above would have written live

Usage
-----
    export DATABASE_URL=postgres://…
    python3 import-pokercity.py <xlsx>                  # parse + reconcile, write nothing
    python3 import-pokercity.py <xlsx> --apply          # write, in one transaction
    python3 import-pokercity.py <xlsx> --verify         # tally the DB against the sheet
    python3 import-pokercity.py <xlsx> --apply --replace   # drop a previous run first

The same command runs against production; only DATABASE_URL changes.
"""
import argparse
import collections
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from decimal import Decimal, ROUND_HALF_UP

import openpyxl

# ── The casino this import loads into ────────────────────────────────────────
#
# The tree itself — ALL Group, the 24 clubs, the 57 logins — is built by
# scripts/launch/seed-tree.ts. This import only fills one casino with its
# members and their history, and refuses to run if that casino is missing.
COMPANY = "Pokercity"

# Malaysian time. The sheet's clock readings are local wall-clock with no offset;
# storing them as UTC would move every deposit eight hours (see
# migrations/2026-08-24c-deposit-date-myt.sql for the last time that happened).
TZ = "+08:00"

# ── Sheet layout. Header row is 1-based; data starts on the row after. ───────
#
# Same workbook template as RajaClub's, laid out differently: the sheets are
# named with +/- prefixes, the headers sit higher, and the Deposit sheet leads
# with the date rather than the remark. Column order is therefore declared
# rather than assumed — see unpack_deposit below.
SHEETS = {
    "+Deposit":    dict(header=15, width=15),
    "-Withdrawal": dict(header=12, width=9),
    "Free Credit": dict(header=10, width=10),
}

# Bank codes as the sheet writes them → the bank each one actually is. The code
# is kept as the account's label so a row can always be traced back.
BANK_NAMES = {
    "MBB": "Maybank",
    "MBB 2": "Maybank",
    "MBB 3": "Maybank",
    "CIMB": "CIMB",
    "CIMB 2": "CIMB",
    "CIMB 3": "CIMB",
    "HLBB": "Hong Leong",
    "HLBB 2": "Hong Leong",
    "HLBB 3": "Hong Leong",
    "RHB": "RHB",
    "RHB 2": "RHB",
    "RHB 3": "RHB",
    "AMBANK": "Ambank",
    "AMBANK 2": "Ambank",
    "AMBANK 3": "Ambank",
    "BSN": "BSN",
    "BSN 2": "BSN",
    "BSN 3": "BSN",
    "PBB": "Public Bank",
    "PBB 2": "Public Bank",
    "AFFIN": "Affin",
    "GoPay": "GoPayz",
}

# Product names in the sheet → the CRM game catalogue. Only the three the
# operator abbreviates are aliased; the rest already match, and any product not
# listed here is added to the catalogue rather than guessed at.
GAME_ALIASES = {
    # Their own spellings, from the workbook's "code" sheet. The " 2" names are
    # a second account on the same kiosk, not a different product.
    "LIve22": "Live22",
    "Mega 2": "Mega888",
    "Scr888 2": "Scr888",
    "Rollex 2": "Rollex",
    "Pussy 2": "Pussy888",
    "3win8 2": "3win8",
    "Crown 2": "Crown",
    "LuckyPalace 2": "LuckyPalace",
    "918kiss": "Scr888",
    "LPE": "LPE88",
    "LPE 2": "LPE88",
}

# The physical account behind each code the sheet writes, as the club supplied
# them. Codes absent here still get an account — the deposits have to land
# somewhere and the balance has to tally — but with a placeholder number, so it
# is obvious in the UI which ones still need their details filled in.
BANK_ACCOUNTS = {
    "RHB":      ("26437500013166",   "JAIRUS A/L KANABATHY"),
    "CIMB":     ("7651676207",       "JAIRUS A/L KANABATHY"),
    "AMBANK":   ("8881069881954",    "GANESH A/L RAMASOMDRAM"),
    "CIMB 2":   ("7657851907",       "MOGANAH DEVI A/P PANNEAR SELVAN"),
    "BSN 2":    ("1419141100047617", "MOGANAH DEVI A/P PANNEAR SELVAN"),
    "HLBB 2":   ("04650234411",      "MOGANAH DEVI A/P PANNEAR SELVAN"),
    "AMBANK 2": ("8881071576184",    "MOGANAH DEVI A/P PANNEAR SELVAN"),
    "RHB 2":    ("26227800046310",   "MOGANAH DEVI A/P PANNEAR SELVAN"),
    # Supplied with the cutoff file. All three appear in the Abdullah Club and
    # Club 2 lists as well — the same accounts serving more than one casino,
    # which is what the "BACKUP TO AC2 RHB" rows in the sheet were already
    # telling us. The bank name decides the mapping: the only Maybank of the
    # three is MBB 2, the only spare CIMB is CIMB 3.
    "CIMB 3":   ("7658901890",       "ARNEETHA A/P SIVA"),
    "MBB 2":    ("514477723194",     "ARNEETHA A/P SIVA"),
    "AMBANK 3": ("8881067566478",    "SUGUNA A/P PONNIAH"),
}
PLACEHOLDER = "TO BE CONFIRMED"

# Rows in the Withdrawal sheet whose "product" is not a game: they move money
# out of a bank without a player behind them.
NON_GAME_PRODUCTS = {"Clear Bank", "Bank Charge", "Expenses"}

# Bank values in the Deposit sheet that are not a bank credit.
PSEUDO_BANKS = {"REKEMEN", "ID TO ID"}

# The sheet writes it capitalised as "Rekemen"; matching is upper-cased.

CENT = Decimal("0.01")


# ── Cell readers ─────────────────────────────────────────────────────────────

def S(v):
    """Text, trimmed. The export leaves stray tabs and non-breaking spaces."""
    if v is None:
        return ""
    return str(v).replace("\t", "").replace("\xa0", " ").strip()


def digits(v):
    """
    An identifier that is all digits, with Excel's float tail removed.

    475 of the member bank account numbers were read as numbers, so
    "130639150657" is sitting in the file as 130639150657.0. Only an
    all-digits value is unpacked this way — a login that genuinely ends in
    ".0" would be left alone, and none do.
    """
    s = S(v)
    return s[:-2] if re.fullmatch(r"\d+\.0+", s) else s


def D(v):
    """A money cell as Decimal. Blank and unparseable both read as zero."""
    if v is None or (isinstance(v, str) and not v.strip()):
        return Decimal(0)
    try:
        return Decimal(str(v))
    except Exception:
        return Decimal(0)


def money(v):
    return Decimal(v).quantize(CENT, rounding=ROUND_HALF_UP)


def read_date(v):
    """
    The date column arrives in two shapes and one of them is wrong.

    Days 1–12 were read by Excel as m/d/y, so "1/8/2026" (1 August) is sitting
    in the file as datetime(2026, 1, 8) — day and month swapped. Days 13–31
    could not be a month, so those stayed as the original "13/8/2026" string.
    Both are d/m/y once the datetime's fields are read back in the other order.
    """
    if isinstance(v, datetime.datetime):
        return datetime.date(v.year, v.day, v.month)
    s = S(v)
    if not s:
        return None
    parts = re.split(r"[/-]", s)
    if len(parts) != 3:
        return None
    try:
        return datetime.date(int(parts[2]), int(parts[1]), int(parts[0]))
    except ValueError:
        return None


def read_time(v):
    """
    The clock column is HHMM with no padding: 2 is 00:02, 1953 is 19:53.

    Thirteen cells in the month are typos ("19*34", "13343", "95"). A guess at
    what they meant would be invention, so they return None and the row is
    stored as midnight with deposit_time_known false — the same treatment the
    CRM already gives a date-only report.
    """
    s = S(v)
    if not s:
        return None
    try:
        n = int(float(s))
    except ValueError:
        return None
    if not 0 <= n <= 2359 or n % 100 >= 60:
        return None
    return datetime.time(n // 100, n % 100)


def stamp(date, time):
    """An ISO timestamp in MYT, and whether the clock reading was real."""
    if date is None:
        return None, False
    t = time or datetime.time(0, 0)
    return f"{date.isoformat()} {t.strftime('%H:%M:%S')}{TZ}", time is not None


def is_member_code(code):
    """A real member code is a letter (or two) followed by digits: S2413, F3275."""
    return bool(re.fullmatch(r"[A-Za-z]{1,3}\d{2,6}", code))


# ── Parsing ──────────────────────────────────────────────────────────────────

class Sheet:
    """Rows of one sheet, trimmed to the transaction table's own columns."""

    def __init__(self, wb, name):
        cfg = SHEETS[name]
        self.name = name
        self.header = cfg["header"]
        self.width = cfg["width"]
        ws = wb[name]
        self.rows = []
        for i, row in enumerate(ws.iter_rows(min_row=self.header + 1, values_only=True)):
            core = list(row[: self.width]) + [None] * self.width
            self.rows.append((self.header + 1 + i, core[: self.width]))


def parse_dashboard(wb):
    """
    The summary block at the top of the +Deposit sheet, which is what every
    derived total gets checked against.

    Two bank columns sit side by side: the first account of each bank on the
    left (name in B, balance in A, deposit count in F) and the second on the
    right (name in J, balance in I, count in G). The kiosk credits run down
    columns N/O, and the per-game targets down S/T.
    """
    ws = wb["+Deposit"]
    cell = lambda r, c: ws.cell(row=r, column=c).value

    banks = {}
    for r in range(2, 10):
        for name_col, bal_col, count_col in ((2, 1, 6), (10, 9, 7)):
            code = S(cell(r, name_col))
            if not code:
                continue
            banks[code] = dict(balance=D(cell(r, bal_col)),
                               deposits=D(cell(r, count_col)))

    # Closing credit per kiosk, down the GAME column.
    # Rows 2-13 only: row 15 is the transaction table's own header ("RKM AMT",
    # "Name Mistake"), which read as kiosks named after column headings.
    kiosks = []
    for r in range(2, 14):
        name = S(cell(r, 14))
        if name and not re.fullmatch(r"[\d.]+", name):
            kiosks.append((re.sub(r"\s+2$", "", name), name, "1", D(cell(r, 15))))

    return dict(banks=banks, kiosks=kiosks, matrix={})


def parse(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    dash = parse_dashboard(wb)
    out = dict(dashboard=dash, warnings=[])
    warn = out["warnings"].append

    # Every member code seen anywhere, with the names and logins attached to it.
    members = collections.defaultdict(lambda: dict(
        names=collections.Counter(),
        contacts=collections.Counter(),
        games=collections.Counter(),
        banks=collections.Counter(),
        first_seen=None,
    ))

    def touch(code, when):
        m = members[code]
        if when and (m["first_seen"] is None or when < m["first_seen"]):
            m["first_seen"] = when
        return m

    # ── Deposit sheet ────────────────────────────────────────────────────────
    deposits, referrals, id_to_id, bonus_only = [], [], [], []
    cash_outs_from_deposits = []
    for n, row in Sheet(wb, "+Deposit").rows:
        # A B C D E F G H I J K L M N O
        # date time code contact remark login product pct bank amount _ bonus kwn rkm mistake
        (date, time, code, contact, remark, login, product, pct,
         bank, amount, _spare, bonus, kwn, kwn_amt, _mistake) = row
        date, time = read_date(date), read_time(time)
        code, bank, product, login = S(code), S(bank), S(product), digits(login)
        # Padding: the summary columns to the right run on past the last real
        # row, leaving a date and a zero in the transaction columns.
        if not bank and not code and D(bonus) == 0:
            continue
        if date is None:
            warn(f"Deposit row {n}: unreadable date, row skipped")
            continue

        ts, timed = stamp(date, time)
        member = touch(code, date) if is_member_code(code) else None
        if member is not None:
            if S(remark):
                member["names"][S(remark)] += 1
            if S(contact):
                member["contacts"][S(contact)] += 1
            if product and login:
                member["games"][(product, login)] += 1

        rec = dict(row=n, at=ts, timed=timed, date=date, code=code if member else "",
                   login=login, product=product, remark=S(remark), contact=S(contact),
                   pct=D(pct), bonus=money(D(bonus)))

        if product in NON_GAME_PRODUCTS:
            # The Deposit sheet carries these too: bank sweeps and charges
            # written as deposits. They have no member and no game, so they
            # travel with the withdrawal sheet's cash-outs rather than becoming
            # a top-up nobody received.
            cash_outs_from_deposits.append({**rec, "kind": product, "bank": bank,
                                            "amount": money(D(amount)),
                                            # The withdrawal sheet's cash-outs
                                            # name who took the money in the
                                            # holder column; here it is the
                                            # remark, and there is no account.
                                            "holder": S(remark), "account": ""})
            continue
        if bank.upper() == "REKEMEN":
            kwn = S(kwn)
            if not is_member_code(kwn):
                warn(f"Deposit row {n}: REKEMEN with no friend code, skipped")
                continue
            touch(kwn, date)
            referrals.append({**rec, "downline": kwn, "amount": money(D(kwn_amt))})
        elif bank.upper() == "ID TO ID":
            id_to_id.append({**rec, "amount": money(D(amount))})
        elif bank:
            deposits.append({**rec, "bank": bank, "amount": money(D(amount))})
        elif rec["bonus"] != 0:
            # A bonus with no bank credit behind it — goodwill, or a clawback.
            bonus_only.append(rec)

    # ── Withdrawal sheet ─────────────────────────────────────────────────────
    withdrawals, cash_outs = [], []
    for n, row in Sheet(wb, "-Withdrawal").rows:
        date, time, code, login, product, bank, amount, holder, account = row
        date, time = read_date(date), read_time(time)
        code, product, bank = S(code), S(product), S(bank)
        if not product:
            continue                      # padding, same as above
        if date is None:
            warn(f"Withdrawal row {n}: unreadable date, row skipped")
            continue
        ts, timed = stamp(date, time)
        rec = dict(row=n, at=ts, timed=timed, date=date, bank=bank,
                   amount=money(D(amount)), holder=S(holder), account=digits(account))

        if product in NON_GAME_PRODUCTS:
            cash_outs.append({**rec, "kind": product})
            continue
        if not is_member_code(code):
            warn(f"Withdrawal row {n}: '{product}' payout with no member code "
                 f"({code!r}) — recorded as a bank cash-out")
            cash_outs.append({**rec, "kind": product})
            continue

        member = touch(code, date)
        if S(holder):
            member["names"][S(holder)] += 1
        if digits(login):
            member["games"][(product, digits(login))] += 1
        if rec["account"]:
            member["banks"][(rec["account"], S(holder))] += 1
        withdrawals.append({**rec, "code": code, "login": digits(login), "product": product})

    # ── Free Credit sheet ────────────────────────────────────────────────────
    free_credits = []
    for n, row in Sheet(wb, "Free Credit").rows:
        # A B C D E F G H I J
        # date time code login product amount contact remark1 remark2 remark3
        date, time, code, login, product, amount, _contact, remark, remark2, _r3 = row
        code, product, login = S(code), S(product), digits(login)
        if not product:
            continue
        if not is_member_code(code):
            warn(f"Free Credit row {n}: no member code ({code!r}), skipped")
            continue
        date, time = read_date(date), read_time(time)
        if date is None:
            warn(f"Free Credit row {n}: unreadable date, row skipped")
            continue
        ts, timed = stamp(date, time)
        member = touch(code, date)
        if login:
            member["games"][(product, login)] += 1
        note = " ".join(x for x in (S(remark), S(remark2)) if x)
        free_credits.append(dict(row=n, at=ts, code=code, login=login, product=product,
                                 amount=money(D(amount)), remark=note))

    out.update(members=members, deposits=deposits, referrals=referrals,
               id_to_id=id_to_id, bonus_only=bonus_only, withdrawals=withdrawals,
               cash_outs=cash_outs + cash_outs_from_deposits, free_credits=free_credits,
               dep_sheet_sweeps=cash_outs_from_deposits)
    out["transfers"] = pair_transfers(id_to_id, warn)
    resolve_orphans(out)
    return out


def pair_transfers(rows, warn):
    """
    ID TO ID is written as two rows: the wallet the credit left (negative) and
    the one it arrived in (positive). They sit next to each other and carry the
    same member, but not always the same minute — four of the month's moves have
    the two legs a minute apart, so the clock cannot be part of the key.

    Pairing therefore walks each member's rows in sheet order and matches a
    credit against the most recent debit of the same size still waiting. A leg
    that never finds its partner is reported rather than halved into a transfer
    that only happened in one direction.
    """
    by_member = collections.defaultdict(list)
    for r in rows:
        by_member[r["code"]].append(r)

    transfers = []
    for code, rs in sorted(by_member.items()):
        # Either leg can come first — one move in the month is written the
        # other way round — so both signs wait for their partner. The sign
        # says which end of the move a row is; row order never does.
        waiting = {-1: [], 1: []}
        for r in sorted(rs, key=lambda x: x["row"]):
            if r["amount"] == 0:
                continue
            sign = 1 if r["amount"] > 0 else -1
            other = waiting[-sign]
            match = next((i for i in range(len(other) - 1, -1, -1)
                          if other[i]["amount"] == -r["amount"]), None)
            if match is None:
                waiting[sign].append(r)
                continue
            partner = other.pop(match)
            debit, credit = (partner, r) if sign > 0 else (r, partner)
            transfers.append(dict(row=min(debit["row"], credit["row"]), at=debit["at"],
                                  code=code, amount=credit["amount"],
                                  from_product=debit["product"], from_login=debit["login"],
                                  to_product=credit["product"], to_login=credit["login"]))
        for r in waiting[-1] + waiting[1]:
            warn(f"ID TO ID row {r['row']}: leg of {r['amount']} with no matching "
                 f"opposite leg for {code}, skipped")
    return sorted(transfers, key=lambda t: t["row"])


def resolve_orphans(data):
    """
    A handful of rows carry a bare "S" where the member code belongs, but still
    name the game login the money moved through. A login belongs to exactly one
    member, so where the lookup is unambiguous the row can be given back its
    owner; where it is not, the row keeps a null player rather than being
    attached to a guess.
    """
    owner = {}
    for code, m in data["members"].items():
        for key in m["games"]:
            owner.setdefault(key, set()).add(code)
    unique = {k: next(iter(v)) for k, v in owner.items() if len(v) == 1}

    recovered = 0
    for rec in data["deposits"] + data["bonus_only"]:
        if rec["code"]:
            continue
        found = unique.get((rec["product"], rec["login"]))
        if found:
            rec["code"] = found
            recovered += 1
    data["recovered"] = recovered


# ── Reconciliation ───────────────────────────────────────────────────────────

def reconcile(data):
    """
    Check the parse against the sheet's own dashboard. Returns a list of
    (label, expected, got) — empty means every total agrees.

    This workbook's dashboard reports a deposit *count* per bank rather than a
    movement matrix, so that is what gets checked: if the importer reads 1,309
    rows into CIMB and the sheet's own counter says 1,309, the bank column was
    read correctly for every row. The kiosk credits are listed beside it and
    are what the game balances are set from, so they are reported rather than
    derived — nothing in the transaction rows adds up to a closing balance.
    """
    dash = data["dashboard"]
    checks = []

    # The dashboard's counter is keyed on the Bank column, so it counts the
    # sweeps written on the Deposit sheet alongside the real top-ups. Counting
    # only deposits here would report a three-row shortfall on CIMB that says
    # nothing about whether the import is right.
    count_by_bank = collections.Counter()
    for r in data["deposits"] + data.get("dep_sheet_sweeps", []):
        count_by_bank[r["bank"]] += 1

    for code, fig in sorted(dash["banks"].items()):
        expected = fig.get("deposits", Decimal(0))
        got = Decimal(count_by_bank.get(code, 0))
        if expected == 0 and got == 0:
            continue
        checks.append((f"bank {code} deposit count", expected, got))

    return [(label, e, g) for label, e, g in checks if money(e) != money(g)]


def check_bonus_math(data):
    """
    Every bonus in the sheet should be its own row's percentage of its own
    amount — the deposit for an ordinary row, the friend's deposit for a
    REKEMEN row. Any row where it isn't is listed, because a bonus that doesn't
    follow from the row is either a manual override worth knowing about or a
    typo worth fixing before it is imported as fact.
    """
    off = []
    for r in data["deposits"]:
        if money(r["amount"] * r["pct"]) != r["bonus"]:
            off.append((r["row"], r["amount"], r["pct"], r["bonus"],
                        money(r["amount"] * r["pct"])))
    for r in data["referrals"]:
        if money(r["amount"] * r["pct"]) != r["bonus"]:
            off.append((r["row"], r["amount"], r["pct"], r["bonus"],
                        money(r["amount"] * r["pct"])))
    return off


# ── SQL generation ───────────────────────────────────────────────────────────

def lit(v):
    """A SQL literal. None is NULL; everything else is quoted text."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, Decimal)):
        return str(v)
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def copy_block(table, columns, rows):
    """
    A COPY block written inline in the script. Faster than thousands of INSERTs
    and, unlike a giant multi-row VALUES, it does not build one statement the
    size of the file.
    """
    if not rows:
        return ""
    out = [f"COPY {table} ({', '.join(columns)}) FROM stdin;"]
    for r in rows:
        fields = []
        for v in r:
            if v is None:
                fields.append(r"\N")
            elif isinstance(v, bool):
                fields.append("t" if v else "f")
            else:
                s = str(v)
                for a, b in (("\\", "\\\\"), ("\t", "\\t"), ("\n", "\\n"), ("\r", "\\r")):
                    s = s.replace(a, b)
                fields.append(s)
        out.append("\t".join(fields))
    out.append("\\.")
    return "\n".join(out) + "\n"


def build_sql(data, password_hash, games_catalogue, banks_catalogue, replace):
    d = data
    sql = ["BEGIN;", "SET LOCAL client_min_messages = warning;", ""]
    add = sql.append

    def game(product):
        return GAME_ALIASES.get(product, product)

    # ── 1. the casino, which seed-tree.ts has already built ──────────────────
    #
    # Unlike RajaClub's import this creates no entities and no logins: the
    # group tree is seeded once for all 24 clubs, and this only finds the
    # casino it is loading into. It fails loudly rather than inventing one,
    # because a second "Pokercity" would split the members across two
    # companies and every report would quietly halve.
    add(f"""
CREATE TEMP TABLE ctx (k text PRIMARY KEY, v int) ON COMMIT DROP;
INSERT INTO ctx
  SELECT 'company', entity_id FROM entities
   WHERE name = {lit(COMPANY)} AND entity_type = 'company';
INSERT INTO ctx
  SELECT 'cs', entity_id FROM entities
   WHERE entity_type = 'cs' AND parent_entity_id = (SELECT v FROM ctx WHERE k = 'company')
   LIMIT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM ctx WHERE k = 'company') THEN
    RAISE EXCEPTION 'No company named {COMPANY} — run seed-tree.ts first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ctx WHERE k = 'cs') THEN
    RAISE EXCEPTION '{COMPANY} has no CS desk — run seed-tree.ts first';
  END IF;
END $$;

-- Whose name the imported rows are handled under: the casino's first CS login.
CREATE TEMP VIEW cs_user AS
  SELECT u.user_id AS v FROM users u, ctx c
   WHERE c.k = 'cs' AND u.entity_id = c.v AND u.role = 'cs_agent'
   ORDER BY u.user_id LIMIT 1;""")

    # ── 2. clear a previous run ──────────────────────────────────────────────
    #
    # Scoped to this casino's data, never to the tree: the entities and the 57
    # logins are seeded separately and shared with clubs this import knows
    # nothing about. A re-run replaces members and their history; it must not
    # take the group down with it.
    if replace:
        add("""
CREATE TEMP TABLE old_pl ON COMMIT DROP AS
  SELECT player_id FROM players WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
CREATE TEMP TABLE old_acct ON COMMIT DROP AS
  SELECT account_id FROM bank_accounts WHERE entity_id = (SELECT v FROM ctx WHERE k = 'company');

DELETE FROM referral_bonuses WHERE upline_player_id IN (SELECT player_id FROM old_pl)
                                OR downline_player_id IN (SELECT player_id FROM old_pl);
DELETE FROM rebate_payouts   WHERE player_id IN (SELECT player_id FROM old_pl);
DELETE FROM game_transfers   WHERE player_id IN (SELECT player_id FROM old_pl);
DELETE FROM game_credits     WHERE player_id IN (SELECT player_id FROM old_pl);
DELETE FROM withdrawals      WHERE player_id IN (SELECT player_id FROM old_pl);
DELETE FROM transactions     WHERE player_id IN (SELECT player_id FROM old_pl)
                                OR entity_id = (SELECT v FROM ctx WHERE k = 'company');
DELETE FROM deposits         WHERE player_id IN (SELECT player_id FROM old_pl)
                                OR company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
DELETE FROM member_bank_accounts WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
DELETE FROM member_game_accounts WHERE member_id IN (SELECT player_id FROM old_pl);
DELETE FROM bank_cash_outs   WHERE account_id IN (SELECT account_id FROM old_acct);
DELETE FROM bank_transfers   WHERE from_account_id IN (SELECT account_id FROM old_acct)
                                OR to_account_id IN (SELECT account_id FROM old_acct);
DELETE FROM bot_commands     WHERE bank_account_id IN (SELECT account_id FROM old_acct)
                                OR company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
DELETE FROM expenses         WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
CREATE TEMP TABLE old_person ON COMMIT DROP AS
  SELECT DISTINCT person_id FROM players
   WHERE player_id IN (SELECT player_id FROM old_pl) AND person_id IS NOT NULL;
DELETE FROM players WHERE player_id IN (SELECT player_id FROM old_pl);
DELETE FROM people  WHERE person_id IN (SELECT person_id FROM old_person);
DELETE FROM provider_bo_accounts WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
DELETE FROM bank_accounts WHERE account_id IN (SELECT account_id FROM old_acct);
DELETE FROM activity_log WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company');
""")
    else:
        add(f"""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM players
              WHERE company_entity_id = (SELECT v FROM ctx WHERE k = 'company')) THEN
    RAISE EXCEPTION '{COMPANY} already has members — re-run with --replace to overwrite them';
  END IF;
END $$;""")

    # ── 3. catalogue: any game or bank this month uses that the CRM lacks ────
    if games_catalogue:
        add(f"""
UPDATE settings SET value = {lit(json.dumps(games_catalogue))}::jsonb, updated_at = now()
  WHERE key = 'games';""")
    if banks_catalogue:
        add(f"""
UPDATE settings SET value = {lit(json.dumps(banks_catalogue))}::jsonb, updated_at = now()
  WHERE key = 'banks';""")

    # The operator's own product spellings, so the worksheet still accepts what
    # CS has always typed. The import folds MG888 into Mega888 to keep one
    # canonical game in the data; without this the grid then rejected "MG888"
    # as an unknown product and the row could not be saved at all.
    aliases = {k: v for k, v in GAME_ALIASES.items() if k != v}
    add(f"""
INSERT INTO settings (key, value) VALUES ('game_aliases', {lit(json.dumps(aliases))}::jsonb)
  ON CONFLICT (key) DO UPDATE
    SET value = settings.value || excluded.value, updated_at = now();""")

    # ── 4. bank accounts ─────────────────────────────────────────────────────
    dep_banks = {r["bank"] for r in d["deposits"]}
    used_banks = dep_banks | {r["bank"] for r in d["withdrawals"] + d["cash_outs"] if r["bank"]}
    banks = sorted(set(d["dashboard"]["banks"]) | used_banks)
    # The dashboard tracks a second, mostly dormant set of accounts ("MBB 2",
    # "RHB 3"). One that held nothing, took nothing and paid nothing all month
    # is left out — there is no evidence in the file that it is still open.
    bank_rows = []
    for code in banks:
        fig = d["dashboard"]["banks"].get(code, {})
        opening = fig.get("opening", Decimal(0))
        deposit = fig.get("deposit", Decimal(0))
        withdrawal = fig.get("withdrawal", Decimal(0))
        if code not in used_banks and not (opening or deposit or withdrawal):
            continue
        number, holder = BANK_ACCOUNTS.get(code, (PLACEHOLDER, PLACEHOLDER))
        bank_rows.append((
            code,
            BANK_NAMES.get(code, code),
            # Every one of these both collects and pays — the sheet posts
            # deposits and withdrawals through the same codes.
            "both",
            money(fig.get("balance", Decimal(0))),
            number,
            holder,
        ))
    add("""
CREATE TEMP TABLE imp_bank (code text PRIMARY KEY, bank_name text, role text,
                            closing numeric, account_number text, account_holder text,
                            account_id int) ON COMMIT DROP;""")
    add(copy_block("imp_bank",
                   ["code", "bank_name", "role", "closing", "account_number", "account_holder"],
                   bank_rows))
    add("""
UPDATE imp_bank SET account_id = nextval('bank_accounts_account_id_seq');
INSERT INTO bank_accounts (account_id, entity_id, role, bank_name, account_number,
                           account_holder, label, current_balance, status)
  SELECT b.account_id, c.v, b.role::bank_account_role, b.bank_name,
         b.account_number, b.account_holder, b.code, b.closing, 'active'
    FROM imp_bank b, ctx c WHERE c.k = 'company';""")

    # ── 5. kiosks ────────────────────────────────────────────────────────────
    kiosk_rows = []
    for name, label, group, credit in d["dashboard"]["kiosks"]:
        kiosk_rows.append((game(name), f"PC-{label.replace(' ', '')}",
                           f"Kiosk {group}", money(credit),
                           f"Closing credit for {label} at the end of the imported month."))
    add("""
CREATE TEMP TABLE imp_kiosk (game_name text, bo_username text, bo_label text,
                             credit numeric, notes text) ON COMMIT DROP;""")
    add(copy_block("imp_kiosk", ["game_name", "bo_username", "bo_label", "credit", "notes"], kiosk_rows))
    add("""
INSERT INTO provider_bo_accounts (company_entity_id, game_name, bo_username, bo_label,
                                  current_credit, status, notes)
  SELECT c.v, k.game_name, k.bo_username, k.bo_label, k.credit, 'active', k.notes
    FROM imp_kiosk k, ctx c WHERE c.k = 'company';""")

    # ── 6. one general bonus per percentage the operator gives ───────────────
    #
    # The operator has no rule attached to these — a percentage is just what CS
    # gave that member on that deposit. bonus_plans cannot say that: the table's
    # own CHECK (bonus_plans_period_ck) requires a period on anything that is
    # not a welcome bonus, so the loosest expressible plan is recurring/daily.
    #
    # That cap is inert for everything imported here. periodStart("daily")
    # measures from this morning, so an August deposit is never in the lookback
    # and linking the history cannot make a plan look claimed. It bites only on
    # deposits entered from now on, where CS keeps the escape they used all
    # month anyway: the Bonus % cell takes a typed number, which posts
    # bonus_percentage with no plan and skips eligibility entirely.
    # ── 6. bonus plans: deliberately none ────────────────────────────────────
    #
    # RajaClub's import minted a plan per percentage. This one does not, and the
    # data is why: 339 member-days in this month carry more than one bonus, and
    # one member took fifteen in a day. A plan is a once-per-period rule — the
    # loosest the table's CHECK allows is daily — so plans for 5% and 10% would
    # have rejected 624 of these very rows and blocked the desk every day after.
    #
    # The everyday rates stay what they already are in this sheet: a percentage
    # typed into the Bonus % cell, which posts bonus_percentage with no plan and
    # skips eligibility entirely. The two welcome rates ARE plans, because "once
    # ever" is exactly what a plan enforces — they are seeded in settings.sql.
    add("""
CREATE TEMP TABLE imp_plan (name text, pct numeric, plan_id int) ON COMMIT DROP;""")

    # ── 7. people and members ────────────────────────────────────────────────
    dep_total = collections.Counter()
    wd_total = collections.Counter()
    for r in d["deposits"]:
        if r["code"]:
            dep_total[r["code"]] += r["amount"]
    for r in d["withdrawals"]:
        wd_total[r["code"]] += r["amount"]

    member_rows = []
    for code in sorted(d["members"]):
        m = d["members"][code]
        # The sheet re-types the name on every row and truncates some of them;
        # the most frequent spelling wins, longest breaking a tie. A member who
        # only ever appears on the Free Credit sheet, or as somebody's referral,
        # is never named there at all — that member carries their code as a name
        # and says so in their notes, rather than being quietly left blank.
        name = max(m["names"].items(), key=lambda kv: (kv[1], len(kv[0])))[0] if m["names"] else None
        contact = m["contacts"].most_common(1)[0][0] if m["contacts"] else ""
        first = m["first_seen"]
        member_rows.append((
            code, (name or code)[:120], name is not None,
            "Telegram" if contact == "Telegram" else None,
            f"{first.isoformat()} 00:00:00{TZ}" if first else None,
            money(dep_total.get(code, Decimal(0))),
            money(wd_total.get(code, Decimal(0))),
        ))
    add("""
CREATE TEMP TABLE imp_member (code text PRIMARY KEY, full_name text, named boolean,
                              channel text, first_seen timestamptz,
                              total_dep numeric, total_wd numeric,
                              person_id int, player_id int) ON COMMIT DROP;""")
    add(copy_block("imp_member", ["code", "full_name", "named", "channel", "first_seen",
                                  "total_dep", "total_wd"], member_rows))
    add(f"""
UPDATE imp_member SET person_id = nextval('people_person_id_seq'),
                      player_id = nextval('players_player_id_seq');
-- No phone number appears anywhere in the source, so identity cannot be matched
-- across companies. Each member gets a distinct person, flagged for review.
INSERT INTO people (person_id, full_name, needs_review, created_at)
  SELECT person_id, full_name, true, coalesce(first_seen, now()) FROM imp_member;
INSERT INTO players (player_id, username, full_name, person_id, company_entity_id,
                     registration_date, status, total_deposits, total_withdrawals, notes)
  SELECT m.player_id, m.code, m.full_name, m.person_id, c.v,
         coalesce(m.first_seen, now()), 'active', m.total_dep, m.total_wd,
         CASE WHEN m.named THEN 'Imported from the Pokercity trading sheet.'
              ELSE 'Imported from the Pokercity trading sheet. The source never '
                   'records a name for this member — only free credits and '
                   'referrals, which carry the code alone. Name needs filling in.'
         END
    FROM imp_member m, ctx c WHERE c.k = 'company';""")

    # ── 8. member game and bank accounts ─────────────────────────────────────
    ga_rows = sorted({(code, game(p), login)
                      for code, m in d["members"].items()
                      for (p, login) in m["games"] if login})
    add("""
CREATE TEMP TABLE imp_ga (code text, game_name text, game_username text) ON COMMIT DROP;""")
    add(copy_block("imp_ga", ["code", "game_name", "game_username"], ga_rows))
    add("""
INSERT INTO member_game_accounts (member_id, game_name, game_username)
  SELECT DISTINCT m.player_id, g.game_name, g.game_username
    FROM imp_ga g JOIN imp_member m USING (code)
  ON CONFLICT DO NOTHING;
-- players.game_accounts is the jsonb the agent and the older screens still read.
UPDATE players p SET game_accounts = a.accounts
  FROM (SELECT m.player_id,
               jsonb_agg(jsonb_build_object('game_name', g.game_name,
                                            'game_username', g.game_username)
                         ORDER BY g.game_name, g.game_username) AS accounts
          FROM imp_ga g JOIN imp_member m USING (code) GROUP BY m.player_id) a
 WHERE p.player_id = a.player_id;""")

    # One bank account per number. The sheet re-types the holder's name per row,
    # so the first spelling of each number wins and later ones are dropped —
    # the account number is what identifies the account.
    seen_acct = {}
    for code in sorted(d["members"]):
        for (acct, holder), _ in d["members"][code]["banks"].most_common():
            if acct and acct not in seen_acct:
                seen_acct[acct] = (code, holder)
    ba_rows = [(code, acct, (holder or code)[:120]) for acct, (code, holder) in sorted(seen_acct.items())]
    add("""
CREATE TEMP TABLE imp_ba (code text, account_number text, account_holder text) ON COMMIT DROP;""")
    add(copy_block("imp_ba", ["code", "account_number", "account_holder"], ba_rows))
    add("""
-- The source never records which bank a member's account is at, only its
-- number, so bank_name is left empty rather than guessed.
INSERT INTO member_bank_accounts (member_id, company_entity_id, bank_name,
                                  account_number, account_holder)
  SELECT m.player_id, c.v, '', b.account_number, b.account_holder
    FROM imp_ba b JOIN imp_member m USING (code), ctx c WHERE c.k = 'company'
  ON CONFLICT DO NOTHING;
UPDATE players p SET bank_accounts = a.accounts
  FROM (SELECT m.player_id,
               jsonb_agg(jsonb_build_object('bank_name', '',
                                            'account_number', b.account_number,
                                            'account_holder', b.account_holder)) AS accounts
          FROM imp_ba b JOIN imp_member m USING (code) GROUP BY m.player_id) a
 WHERE p.player_id = a.player_id;""")

    # ── 9. deposits ──────────────────────────────────────────────────────────
    dep_rows = []
    for r in d["deposits"] + d["bonus_only"]:
        is_adj = "bank" not in r
        pct = (r["pct"] * 100).quantize(CENT)
        amount = r.get("amount", Decimal(0))
        description = " · ".join(x for x in (r["remark"], r["contact"]) if x)
        dep_rows.append((
            f"pokercity:D{r['row']}", f"PC-D-{r['row']}", r["at"], r["timed"],
            r["code"] or None, amount, r.get("bank", "Adjustment"),
            None if is_adj else r["bank"],
            pct, r["bonus"], money(amount + r["bonus"]),
            game(r["product"]) if r["product"] else None, r["login"] or None,
            (description or None) if not is_adj
            else f"Bonus adjustment with no bank credit. {description}".strip(),
        ))
    add("""
CREATE TEMP TABLE imp_dep (external_id text, ref text, at timestamptz, timed boolean,
                           code text, amount numeric, bank_label text, bank_code text,
                           pct numeric, bonus numeric, total numeric,
                           game_name text, game_username text, description text,
                           deposit_id int) ON COMMIT DROP;""")
    add(copy_block("imp_dep", ["external_id", "ref", "at", "timed", "code", "amount",
                               "bank_label", "bank_code", "pct", "bonus", "total",
                               "game_name", "game_username", "description"], dep_rows))
    add("""
UPDATE imp_dep SET deposit_id = nextval('deposits_deposit_id_seq');
INSERT INTO deposits (deposit_id, external_id, transaction_ref, deposit_date,
                      deposit_time_known, player_id, player_username, company_entity_id,
                      deposit_amount, bank_name, bank_description, received_into_account_id,
                      bonus_plan_id, bonus_percentage, bonus_amount, total_amount,
                      selected_game, selected_game_username, status, source, skip_bot,
                      matched_at, approved_at, handled_by_user_id, created_at, updated_at)
  SELECT d.deposit_id, d.external_id, d.ref, d.at, d.timed, m.player_id, d.code, c.v,
         d.amount,
         coalesce(nullif(b.bank_name, ''), d.bank_label),
         d.description, b.account_id,
         pl.plan_id, d.pct, d.bonus, d.total, d.game_name, d.game_username,
         'completed', 'manual', true, d.at, d.at, u.v, d.at, d.at
    FROM imp_dep d
    LEFT JOIN imp_member m ON m.code = d.code
    LEFT JOIN imp_bank b ON b.code = d.bank_code
    LEFT JOIN imp_plan pl ON pl.pct = d.pct AND d.pct > 0,
         ctx c, cs_user u
   WHERE c.k = 'company';""")

    # ── 10. referral bonuses ─────────────────────────────────────────────────
    ref_rows = [(f"PC-R-{r['row']}", r["at"], r["code"], r["downline"], r["amount"],
                 (r["pct"] * 100).quantize(CENT), r["bonus"], game(r["product"]) or None)
                for r in d["referrals"] if r["code"]]
    add("""
CREATE TEMP TABLE imp_ref (ref text, at timestamptz, upline text, downline text,
                           amount numeric, pct numeric, bonus numeric, game_name text,
                           bonus_id int) ON COMMIT DROP;""")
    add(copy_block("imp_ref", ["ref", "at", "upline", "downline", "amount", "pct",
                               "bonus", "game_name"], ref_rows))
    add("""
UPDATE imp_ref SET bonus_id = nextval('referral_bonuses_bonus_id_seq');
INSERT INTO referral_bonuses (bonus_id, upline_player_id, downline_player_id,
                              deposit_amount, bonus_percentage, bonus_amount, status,
                              game_name, skip_bot, assigned_by_user_id, assigned_at,
                              note, created_at)
  SELECT r.bonus_id, up.player_id, dn.player_id, r.amount, r.pct, r.bonus, 'assigned',
         r.game_name, true, u.v, r.at, 'Imported REKEMEN row ' || r.ref, r.at
    FROM imp_ref r
    JOIN imp_member up ON up.code = r.upline
    JOIN imp_member dn ON dn.code = r.downline, cs_user u;
-- The REKEMEN row is the only record of who referred whom, so it also sets the
-- downline's upline. Earliest referral wins if a code somehow appears twice.
UPDATE players p SET upline_player_id = x.upline_id, upline_assigned_at = x.at
  FROM (SELECT DISTINCT ON (dn.player_id) dn.player_id AS downline_id,
               up.player_id AS upline_id, r.at
          FROM imp_ref r JOIN imp_member up ON up.code = r.upline
                         JOIN imp_member dn ON dn.code = r.downline
         ORDER BY dn.player_id, r.at) x
 WHERE p.player_id = x.downline_id;""")

    # ── 11. withdrawals ──────────────────────────────────────────────────────
    wd_rows = [(f"PC-W-{r['row']}", r["at"], r["code"], r["amount"], game(r["product"]),
                r["login"] or None, r["account"] or None, r["holder"] or None, r["bank"])
               for r in d["withdrawals"]]
    add("""
CREATE TEMP TABLE imp_wd (ref text, at timestamptz, code text, amount numeric,
                          game_name text, game_username text, account_number text,
                          holder text, bank_code text, withdrawal_id int) ON COMMIT DROP;""")
    add(copy_block("imp_wd", ["ref", "at", "code", "amount", "game_name", "game_username",
                              "account_number", "holder", "bank_code"], wd_rows))
    add("""
UPDATE imp_wd SET withdrawal_id = nextval('withdrawals_withdrawal_id_seq');
INSERT INTO withdrawals (withdrawal_id, player_id, requested_amount, game_name,
                         game_username, credit_pulled_amount, status, skip_bot, source,
                         handled_by_user_id, bank_name, bank_account_number,
                         paid_from_account_id, paid_at, created_at, updated_at)
  SELECT w.withdrawal_id, m.player_id, w.amount, w.game_name, w.game_username, w.amount,
         'paid', true, 'manual', u.v, '', w.account_number, b.account_id,
         w.at, w.at, w.at
    FROM imp_wd w JOIN imp_member m USING (code)
    LEFT JOIN imp_bank b ON b.code = w.bank_code, cs_user u;""")

    # ── 12. bank cash-outs, and the expenses among them ─────────────────────
    #
    # The sheet keeps three different things in one column. "Clear Bank" is the
    # house moving its own money between accounts — that belongs with the cash
    # withdrawals, because it is what makes each account's closing balance come
    # out right. The other two are the business paying for things:
    #
    #   Bank Charge   what the bank took, or (negative) the hibah it paid
    #   Expenses      groceries, loyalty payouts, a rebate top-up
    #
    # Those go to the expenses book, where the desk reads them, rather than
    # sitting in a list of cash somebody walked out of the bank with.
    EXPENSE_KINDS = {"Bank Charge": "bank_charge", "Expenses": "other"}
    ex_src = [r for r in d["cash_outs"] if r["kind"] in EXPENSE_KINDS]
    co_src = [r for r in d["cash_outs"] if r["kind"] not in EXPENSE_KINDS]

    ex_rows = [(r["at"], EXPENSE_KINDS[r["kind"]],
                (r["holder"] or r["kind"])[:200], r["amount"], r["bank"])
               for r in ex_src]
    add("""
CREATE TEMP TABLE imp_ex (at timestamptz, category text, description text,
                          amount numeric, bank_code text) ON COMMIT DROP;""")
    add(copy_block("imp_ex", ["at", "category", "description", "amount", "bank_code"], ex_rows))
    add("""
-- The account each one was paid from is named, so the Expenses sheet shows it
-- and a future correction can put the money back where it came from. Balances
-- are not moved here: they are set from the dashboard's closing figures, which
-- already account for these.
INSERT INTO expenses (expense_date, category, description, amount,
                      company_entity_id, paid_from_account_id, recorded_by_user_id, notes)
  SELECT e.at, e.category::expense_category, e.description, e.amount, c.v,
         b.account_id, u.v, 'Imported from the Pokercity trading sheet.'
    FROM imp_ex e LEFT JOIN imp_bank b ON b.code = e.bank_code, ctx c, cs_user u
   WHERE c.k = 'company';""")

    co_rows = [(f"PC-C-{r['row']}", r["at"], r["bank"], r["amount"], r["kind"],
                (r["holder"] or r["kind"])[:120]) for r in co_src]
    add("""
CREATE TEMP TABLE imp_co (ref text, at timestamptz, bank_code text, amount numeric,
                          kind text, taken_by text, cash_out_id int) ON COMMIT DROP;""")
    add(copy_block("imp_co", ["ref", "at", "bank_code", "amount", "kind", "taken_by"], co_rows))
    add("""
UPDATE imp_co SET cash_out_id = nextval('bank_cash_outs_cash_out_id_seq');
-- Money that left (or, negative, arrived in) a bank account with no player on
-- either side: inter-bank clearing, bank charges and two phone top-ups. Kept
-- here rather than in expenses because this is what makes each account's
-- closing balance come out right.
INSERT INTO bank_cash_outs (cash_out_id, account_id, entity_id, amount, taken_by,
                            occurred_at, notes, recorded_by_user_id, created_at)
  SELECT o.cash_out_id, b.account_id, c.v, o.amount, o.taken_by, o.at,
         o.kind || ' — imported row ' || o.ref, u.v, o.at
    FROM imp_co o JOIN imp_bank b ON b.code = o.bank_code, ctx c, cs_user u
   WHERE c.k = 'company';""")

    # ── 13. game transfers ───────────────────────────────────────────────────
    tr_rows = [(f"PC-T-{r['row']}", r["at"], r["code"], r["amount"],
                game(r["from_product"]), r["from_login"] or None,
                game(r["to_product"]), r["to_login"] or None) for r in d["transfers"]]
    add("""
CREATE TEMP TABLE imp_tr (ref text, at timestamptz, code text, amount numeric,
                          from_game text, from_login text, to_game text, to_login text,
                          transfer_id int) ON COMMIT DROP;""")
    add(copy_block("imp_tr", ["ref", "at", "code", "amount", "from_game", "from_login",
                              "to_game", "to_login"], tr_rows))
    add("""
UPDATE imp_tr SET transfer_id = nextval('game_transfers_transfer_id_seq');
INSERT INTO game_transfers (transfer_id, player_id, from_game, from_game_username,
                            to_game, to_game_username, transfer_amount,
                            from_game_balance_before, status, handled_by_user_id,
                            created_at, started_at, completed_at, note)
  SELECT t.transfer_id, m.player_id, t.from_game, t.from_login, t.to_game, t.to_login,
         t.amount, 0, 'completed', u.v, t.at, t.at, t.at,
         'Imported ID TO ID row ' || t.ref
    FROM imp_tr t JOIN imp_member m USING (code), cs_user u;""")

    # ── 14. free credits ─────────────────────────────────────────────────────
    fc_rows = [(f"PC-F-{r['row']}", r["at"], r["code"], r["amount"], game(r["product"]),
                r["login"] or None, r["remark"] or None) for r in d["free_credits"]]
    add("""
CREATE TEMP TABLE imp_fc (ref text, at timestamptz, code text, amount numeric,
                          game_name text, game_username text, remark text) ON COMMIT DROP;""")
    add(copy_block("imp_fc", ["ref", "at", "code", "amount", "game_name", "game_username",
                              "remark"], fc_rows))

    # ── 15. the ledger ───────────────────────────────────────────────────────
    add("""
-- One transactions row per event the CRM would have written had these gone
-- through the app: the intent, and the credit that settled it.
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT m.player_id, c.v, 'deposit', d.amount, d.game_name, d.deposit_id, u.v,
         jsonb_build_object('source', 'import', 'action', 'imported',
                            'status', 'completed', 'bonus_percentage', d.pct,
                            'bonus_amount', d.bonus, 'bank', d.bank_label,
                            'sheet_row', d.ref),
         d.at
    FROM imp_dep d LEFT JOIN imp_member m ON m.code = d.code, ctx c, cs_user u
   WHERE c.k = 'company';

INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT m.player_id, c.v, 'game_topup', d.total, d.game_name, d.deposit_id, u.v,
         jsonb_build_object('source', 'import', 'action', 'imported_complete',
                            'game_username', d.game_username,
                            'bonus_amount', d.bonus, 'sheet_row', d.ref),
         d.at
    FROM imp_dep d LEFT JOIN imp_member m ON m.code = d.code, ctx c, cs_user u
   WHERE c.k = 'company' AND d.game_name IS NOT NULL;

INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT m.player_id, c.v, 'credit_pull', w.amount, w.game_name, w.withdrawal_id, u.v,
         jsonb_build_object('source', 'import', 'action', 'imported_pull',
                            'game_username', w.game_username, 'sheet_row', w.ref),
         w.at
    FROM imp_wd w JOIN imp_member m USING (code), ctx c, cs_user u WHERE c.k = 'company';

INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT m.player_id, c.v, 'withdrawal', w.amount, w.game_name, w.withdrawal_id, u.v,
         jsonb_build_object('source', 'import', 'action', 'imported_paid',
                            'bank', w.bank_code, 'account_number', w.account_number,
                            'sheet_row', w.ref),
         w.at
    FROM imp_wd w JOIN imp_member m USING (code), ctx c, cs_user u WHERE c.k = 'company';

INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT up.player_id, c.v, 'recommend_bonus', r.bonus, r.game_name, r.bonus_id, u.v,
         jsonb_build_object('source', 'import', 'action', 'referral_bonus_assigned',
                            'downline', r.downline, 'deposit_amount', r.amount,
                            'bonus_percentage', r.pct, 'sheet_row', r.ref),
         r.at
    FROM imp_ref r JOIN imp_member up ON up.code = r.upline, ctx c, cs_user u
   WHERE c.k = 'company';

INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id,
                          user_id, details, created_at)
  SELECT m.player_id, c.v, 'game_transfer', t.amount, t.to_game, t.transfer_id, u.v,
         jsonb_build_object('source', 'import', 'from_game', t.from_game,
                            'from_game_username', t.from_login,
                            'to_game_username', t.to_login, 'sheet_row', t.ref),
         t.at
    FROM imp_tr t JOIN imp_member m USING (code), ctx c, cs_user u WHERE c.k = 'company';

-- Free credit has no table of its own: it is a top-up nobody deposited for.
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, user_id,
                          details, created_at)
  SELECT m.player_id, c.v, 'game_topup', f.amount, f.game_name, u.v,
         jsonb_build_object('source', 'import', 'action', 'free_credit',
                            'kind', 'free_credit', 'remark', f.remark,
                            'game_username', f.game_username, 'sheet_row', f.ref),
         f.at
    FROM imp_fc f JOIN imp_member m USING (code), ctx c, cs_user u WHERE c.k = 'company';

INSERT INTO transactions (entity_id, type, amount, reference_id, user_id, details, created_at)
  SELECT c.v, 'bank_cash_out', o.amount, o.cash_out_id, u.v,
         jsonb_build_object('source', 'import', 'kind', o.kind, 'bank', o.bank_code,
                            'taken_by', o.taken_by, 'sheet_row', o.ref),
         o.at
    FROM imp_co o, ctx c, cs_user u WHERE c.k = 'company';

-- Expenses get a ledger line too, the same one the app writes when CS records
-- one, so the History page shows an imported charge exactly like a typed one.
INSERT INTO transactions (entity_id, type, amount, user_id, details, created_at)
  SELECT c.v, 'expense', e.amount, u.v,
         jsonb_build_object('source', 'import', 'action', 'expense_paid',
                            'category', e.category, 'description', e.description,
                            'bank', e.bank_code),
         e.at
    FROM imp_ex e, ctx c, cs_user u WHERE c.k = 'company';""")

    add("\nCOMMIT;")
    return "\n".join(sql)


# ── psql plumbing ────────────────────────────────────────────────────────────

def psql(dsn, sql=None, path=None, quiet=False):
    cmd = ["psql", dsn, "-X", "-v", "ON_ERROR_STOP=1", "--no-psqlrc"]
    cmd += ["-f", path] if path else ["-A", "-t", "-c", sql]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"psql failed:\n{out.stdout}\n{out.stderr}")
    if not quiet and out.stdout.strip():
        print(out.stdout.rstrip())
    return out.stdout


def bcrypt_hash(password, here):
    """
    Hash with the same library the app verifies against. bcryptjs lives in the
    project's node_modules, so the hash is produced by the exact implementation
    that will check it rather than a Python re-implementation of it.
    """
    node_modules = os.path.join(os.path.dirname(here), "node_modules")
    script = ("const b=require('bcryptjs');"
              "process.stdout.write(b.hashSync(process.argv[1],10))")
    out = subprocess.run(["node", "-e", script, password],
                         capture_output=True, text=True,
                         env={**os.environ, "NODE_PATH": node_modules})
    if out.returncode:
        sys.exit(f"could not hash the password with bcryptjs:\n{out.stderr}")
    return out.stdout.strip()


# ── Reporting ────────────────────────────────────────────────────────────────

def report(data):
    d = data
    print(f"parsed {len(d['deposits']):>6} deposits")
    print(f"       {len(d['bonus_only']):>6} bonus adjustments with no bank credit")
    print(f"       {len(d['referrals']):>6} referral (REKEMEN) bonuses")
    print(f"       {len(d['withdrawals']):>6} withdrawals")
    print(f"       {len(d['cash_outs']):>6} bank cash-outs (clearing, charges, expenses)")
    print(f"       {len(d['transfers']):>6} game transfers, from {len(d['id_to_id'])} ID TO ID rows")
    print(f"       {len(d['free_credits']):>6} free credits")
    print(f"       {len(d['members']):>6} members")
    accounts = sum(len(m["games"]) for m in d["members"].values())
    print(f"       {accounts:>6} game accounts")
    print(f"       {sum(len(m['banks']) for m in d['members'].values()):>6} member bank accounts")
    unnamed = sum(1 for m in d["members"].values() if not m["names"])
    if unnamed:
        print(f"       {unnamed:>6} of those members are never named in the source "
              f"(free credit / referral only)")
    if d["recovered"]:
        print(f"       {d['recovered']:>6} rows had a missing member code recovered from their game login")

    dates = [r["date"] for r in d["deposits"]] or [None]
    if dates[0]:
        print(f"\nperiod: {min(dates)} … {max(dates)}")

    print("\nbanks (closing balance from the dashboard, movement from the rows):")
    dep = collections.Counter()
    dep_n = collections.Counter()
    wd = collections.Counter()
    for r in d["deposits"]:
        dep[r["bank"]] += r["amount"]
        dep_n[r["bank"]] += 1
    for r in d["withdrawals"] + d["cash_outs"]:
        wd[r["bank"]] += r["amount"]
    print(f"  {'bank':12}{'closing':>12}{'deposits':>11}{'n':>7}{'sheet n':>9}{'paid out':>13}")
    for code, fig in sorted(d["dashboard"]["banks"].items()):
        n, sheet_n = dep_n.get(code, 0), int(fig.get("deposits", 0))
        if not (n or sheet_n or fig.get("balance")):
            continue
        flag = "" if n == sheet_n else "   ← count differs"
        print(f"  {code:12}{fig.get('balance', 0):>12}{money(dep.get(code, 0)):>11}"
              f"{n:>7}{sheet_n:>9}{money(wd.get(code, 0)):>13}{flag}")
    known = sum(1 for c in d["dashboard"]["banks"] if c in BANK_ACCOUNTS)
    print(f"  {known} of {len([c for c in dep_n])} accounts in use have their real number; "
          f"the rest are created as {PLACEHOLDER!r}")

    print("\nbonus:")
    b_dep = sum(r["bonus"] for r in d["deposits"])
    b_ref = sum(r["bonus"] for r in d["referrals"])
    b_adj = sum(r["bonus"] for r in d["bonus_only"])
    print(f"  on deposits            {money(b_dep):>12}")
    print(f"  referral (REKEMEN)     {money(b_ref):>12}")
    print(f"  adjustments, no bank   {money(b_adj):>12}")
    print(f"  total                  {money(b_dep + b_ref + b_adj):>12}")

    off = check_bonus_math(d)
    floored = sum(1 for _, amount, pct, got, want in off
                  if got == (want // 1) and want % 1 != 0)
    print(f"\nbonus arithmetic: {len(d['deposits']) + len(d['referrals'])} rows checked, "
          f"{len(off)} where bonus ≠ amount × percentage")
    if off:
        print(f"    {floored} of those are the house rounding a part-ringgit bonus DOWN "
              f"(25.00 × 5% paid as 1.00, not 1.25).")
        print("    The sheet's figure is imported as-is; nothing is recomputed.")
    for row, amount, pct, got, want in off[:10]:
        print(f"    row {row}: {amount} × {pct} = {want}, sheet says {got}")

    problems = reconcile(d)
    print(f"\nreconciliation against the sheet's dashboard: "
          f"{'all totals agree' if not problems else str(len(problems)) + ' MISMATCHES'}")
    for label, expected, got in problems:
        print(f"    {label:36} dashboard={expected:>14}  rows={got:>14}  "
              f"diff={money(got) - money(expected)}")

    if d["warnings"]:
        print(f"\nwarnings ({len(d['warnings'])}):")
        for w in d["warnings"][:25]:
            print(f"    {w}")
        if len(d["warnings"]) > 25:
            print(f"    … and {len(d['warnings']) - 25} more")

    return problems, off


VERIFY_SQL = """
WITH RECURSIVE tree AS (
  SELECT entity_id FROM entities WHERE name = %(main)s AND entity_type = 'company'
  UNION ALL SELECT e.entity_id FROM entities e JOIN tree t ON e.parent_entity_id = t.entity_id),
co AS (SELECT entity_id FROM entities WHERE entity_id IN (SELECT entity_id FROM tree)
         AND entity_type = 'company'),
pl AS (SELECT player_id FROM players WHERE company_entity_id IN (SELECT entity_id FROM co))
SELECT 'members'              AS item, count(*)::text FROM pl
UNION ALL SELECT 'game accounts', count(*)::text FROM member_game_accounts WHERE member_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'member bank accounts', count(*)::text FROM member_bank_accounts WHERE member_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'bank accounts', count(*)::text FROM bank_accounts WHERE entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'kiosks', count(*)::text FROM provider_bo_accounts WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'bonus plans', count(*)::text FROM bonus_plans WHERE company_entity_id IN (SELECT entity_id FROM co) AND type <> 'welcome'
UNION ALL SELECT 'deposits with a plan', count(*)::text FROM deposits WHERE company_entity_id IN (SELECT entity_id FROM co) AND bonus_plan_id IS NOT NULL
UNION ALL SELECT 'planned bonus amount', coalesce(sum(bonus_amount),0)::text FROM deposits WHERE company_entity_id IN (SELECT entity_id FROM co) AND bonus_plan_id IS NOT NULL
UNION ALL SELECT 'deposits', count(*)::text FROM deposits WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'deposit amount', coalesce(sum(deposit_amount),0)::text FROM deposits WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'deposit bonus', coalesce(sum(bonus_amount),0)::text FROM deposits WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'referral bonuses', count(*)::text FROM referral_bonuses WHERE upline_player_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'referral bonus amount', coalesce(sum(bonus_amount),0)::text FROM referral_bonuses WHERE upline_player_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'withdrawals', count(*)::text FROM withdrawals WHERE player_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'withdrawal amount', coalesce(sum(credit_pulled_amount),0)::text FROM withdrawals WHERE player_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'bank cash-outs', count(*)::text FROM bank_cash_outs WHERE entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'bank cash-out amount', coalesce(sum(amount),0)::text FROM bank_cash_outs WHERE entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'expenses', count(*)::text FROM expenses WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'expense amount', coalesce(sum(amount),0)::text FROM expenses WHERE company_entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'game transfers', count(*)::text FROM game_transfers WHERE player_id IN (SELECT player_id FROM pl)
UNION ALL SELECT 'free credit rows', count(*)::text FROM transactions WHERE entity_id IN (SELECT entity_id FROM co) AND details->>'kind' = 'free_credit'
UNION ALL SELECT 'free credit amount', coalesce(sum(amount),0)::text FROM transactions WHERE entity_id IN (SELECT entity_id FROM co) AND details->>'kind' = 'free_credit'
UNION ALL SELECT 'ledger rows', count(*)::text FROM transactions WHERE entity_id IN (SELECT entity_id FROM co)
UNION ALL SELECT 'bank closing total', coalesce(sum(current_balance),0)::text FROM bank_accounts WHERE entity_id IN (SELECT entity_id FROM co)
"""


def verify(dsn, data):
    """Read the totals back out of the database and set them beside the sheet."""
    rows = psql(dsn, VERIFY_SQL.replace("%(main)s", lit(COMPANY)), quiet=True)
    got = dict(line.split("|", 1) for line in rows.strip().splitlines() if "|" in line)

    d = data
    expect = {
        "members": len(d["members"]),
        "game accounts": len({(c, GAME_ALIASES.get(p, p), u)
                              for c, m in d["members"].items() for (p, u) in m["games"] if u}),
        "deposits": len(d["deposits"]) + len(d["bonus_only"]),
        "deposit amount": money(sum(r["amount"] for r in d["deposits"])),
        "deposit bonus": money(sum(r["bonus"] for r in d["deposits"] + d["bonus_only"])),
        "referral bonuses": len(d["referrals"]),
        "referral bonus amount": money(sum(r["bonus"] for r in d["referrals"])),
        "withdrawals": len(d["withdrawals"]),
        "withdrawal amount": money(sum(r["amount"] for r in d["withdrawals"])),
        "bank cash-outs": len([r for r in d["cash_outs"]
                               if r["kind"] not in ("Bank Charge", "Expenses")]),
        "bank cash-out amount": money(sum(r["amount"] for r in d["cash_outs"]
                                          if r["kind"] not in ("Bank Charge", "Expenses"))),
        "expenses": len([r for r in d["cash_outs"]
                         if r["kind"] in ("Bank Charge", "Expenses")]),
        "expense amount": money(sum(r["amount"] for r in d["cash_outs"]
                                    if r["kind"] in ("Bank Charge", "Expenses"))),
        "game transfers": len(d["transfers"]),
        "free credit rows": len(d["free_credits"]),
        "free credit amount": money(sum(r["amount"] for r in d["free_credits"])),
        # This dashboard reports the balance itself rather than a movement to
        # add up, and that balance is what the accounts are created with.
        "bank closing total": money(sum(
            f.get("balance", Decimal(0)) for f in d["dashboard"]["banks"].values())),
        "member bank accounts": len({a for m in d["members"].values() for (a, _) in m["banks"] if a}),
        "bank accounts": len({c for c, f in d["dashboard"]["banks"].items()
                              if f.get("balance") or f.get("deposits")}
                             | {r["bank"] for r in d["deposits"] + d["withdrawals"]
                                + d["cash_outs"] if r["bank"]}),
        "kiosks": len(d["dashboard"]["kiosks"]),
        # Plans are not minted by this import — the everyday rates are typed
        # percentages — so nothing here should carry one. The two welcome
        # plans are seeded by settings.sql and are excluded from the count.
        "bonus plans": 0,
        "deposits with a plan": 0,
        "planned bonus amount": money(Decimal(0)),
        # Two ledger rows per deposit that names a game (the intent and the
        # top-up that settled it), one otherwise; two per withdrawal; one each
        # for a referral, a transfer, a free credit and a cash-out.
        "ledger rows": (len(d["deposits"]) + len(d["bonus_only"])
                        + sum(1 for r in d["deposits"] + d["bonus_only"] if r["product"])
                        + 2 * len(d["withdrawals"]) + len(d["referrals"])
                        + len(d["transfers"]) + len(d["free_credits"]) + len(d["cash_outs"])),
    }

    print(f"\n{'item':24}{'sheet':>16}{'database':>16}")
    bad = 0
    for item, value in got.items():
        want = expect.get(item)
        if want is None:
            print(f"  {item:22}{'—':>16}{value:>16}")
            continue
        ok = money(Decimal(value)) == money(Decimal(want)) if "." in str(want) or "." in value \
            else str(want) == value.strip()
        bad += 0 if ok else 1
        print(f"  {item:22}{str(want):>16}{value.strip():>16}  {'' if ok else '  ← MISMATCH'}")
    print(f"\n{'every imported total matches the sheet' if not bad else f'{bad} MISMATCHES'}")
    return bad


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("xlsx")
    ap.add_argument("--apply", action="store_true", help="write to the database")
    ap.add_argument("--replace", action="store_true",
                    help="delete a previous run of this importer first")
    ap.add_argument("--verify", action="store_true",
                    help="tally what is already in the database against the sheet")
    ap.add_argument("--password", default="123123", help="password for the created logins")
    ap.add_argument("--force", action="store_true",
                    help="write even though a reconciliation check failed")
    ap.add_argument("--sql-out", help="write the generated SQL here instead of a temp file")
    args = ap.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set")

    print(f"reading {args.xlsx}\n")
    data = parse(args.xlsx)
    problems, off = report(data)

    if args.verify:
        sys.exit(1 if verify(dsn, data) else 0)

    if problems and not args.force:
        sys.exit("\nABORT: the transaction rows do not add up to the sheet's own "
                 "dashboard. Nothing has been written. Fix the source, or re-run "
                 "with --force if the dashboard is the thing that is wrong.")

    here = os.path.abspath(os.path.dirname(__file__))

    # Any game or bank this month uses that the CRM catalogue does not know.
    catalogue = json.loads(psql(dsn, "select value from settings where key='games'",
                                quiet=True) or "[]")
    games_used = {GAME_ALIASES.get(p, p) for p in
                  {r["product"] for r in data["deposits"] + data["withdrawals"]
                   + data["free_credits"] if r["product"]}
                  | {n for n, _, _, _ in data["dashboard"]["kiosks"]}}
    new_games = sorted(games_used - set(catalogue))
    banks = json.loads(psql(dsn, "select value from settings where key='banks'",
                            quiet=True) or "[]")
    new_banks = sorted({BANK_NAMES.get(c, c) for c in data["dashboard"]["banks"]} - set(banks))
    used_pcts = sorted({int(r["pct"] * 100) for r in data["deposits"] + data["referrals"]
                        if r["pct"] > 0})
    if new_games:
        print(f"\ngames to add to the catalogue: {', '.join(new_games)}")
    if new_banks:
        print(f"banks to add to the catalogue: {', '.join(new_banks)}")
    print(f"bonus rates in the data: {', '.join(f'{p}%' for p in used_pcts)} "
          f"— imported as typed percentages, not plans (see build_sql)")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    sql = build_sql(data, None,
                    catalogue + new_games if new_games else None,
                    banks + new_banks if new_banks else None,
                    args.replace)
    path = args.sql_out or os.path.join(tempfile.mkdtemp(), "import-pokercity.sql")
    with open(path, "w") as fh:
        fh.write(sql)
    print(f"\nwriting… ({len(sql) // 1024} KB of SQL at {path})")
    psql(dsn, path=path)
    print("done.")
    if verify(dsn, data):
        sys.exit("\nthe write completed but the totals do not match — investigate before use")
    print(f"\nloaded into {COMPANY}. Logins come from seed-tree.ts, not from here.")


if __name__ == "__main__":
    main()

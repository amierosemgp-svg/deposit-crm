"""
Import one month of a live casino's deposits, withdrawals and free credits from
its trading sheet, into members the CRM already has.

RajaClub's and Pokercity's importers built a casino from nothing: entities,
logins, members, banks, kiosks. The casinos here were set up by hand first and
their members imported through the app, so this one only adds the month's money
movements, finding every member by code and refusing to invent one.

The source is either the month's .xlsx export or a JSON dump of the live Google
Sheet (same template, read with the service account; see dump-sheet in the
session notes), so a month still in progress can be loaded up to today.

What lands in the CRM
---------------------
    deposits        completed, linked to the member, the bank account and the game
    withdrawals     paid, from the casino's own bank account
    transactions    the ledger rows the app would have written, tagged import_batch
                    (free credit has no table of its own; its ledger row is it)
    players         total_deposits / total_withdrawals carry the month, so a
                    member with history is no longer offered a first-deposit bonus

Rows are history: bank balances, kiosk credit and players' game balances do not
move. --sync-balances then sets the casino's bank and kiosk figures to the sheet's
own dashboard, the way a leader corrects one in the app: a bank's difference goes
into opening_balance, a kiosk's into a provider_bo_adjustments row and a
bo_adjustment ledger row.

Usage
-----
    python import-sheet-month.py <casino> <xlsx|dump.json> <year> <month>            # parse + report
    python import-sheet-month.py ... --check     # run it in prod inside a transaction, then ROLLBACK
    python import-sheet-month.py ... --apply     # commit
    python import-sheet-month.py ... --sync-balances  # also set bank + kiosk balances from this sheet

DATABASE_URL comes from the environment or deposit-crm/.env.local, and is sent
through the Supabase session pooler (the direct host is IPv6-only).
"""
import argparse
import collections
import datetime
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))

# The RajaClub importer's cell readers: same template, same quirks.
_spec = importlib.util.spec_from_file_location("rc", os.path.join(HERE, "import-rajaclub.py"))
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)
S, digits, D, money, read_time, stamp, is_member_code, lit, copy_block = (
    rc.S, rc.digits, rc.D, rc.money, rc.read_time, rc.stamp, rc.is_member_code,
    rc.lit, rc.copy_block)

# ── The casinos ──────────────────────────────────────────────────────────────
#
# `banks`: the code the sheet writes → the account it is, by id, for a casino
# whose accounts were added by hand. None means the casino has none yet and
# they are created from the sheet's bank block, with the number to be filled in.
#
# `ticked_free_credit`: the Free Credit tab marks each row ✔️ or ❌; ❌ is a
# credit that was not given ("belom join" — hasn't joined yet), so only ✔️ rows
# are imported. A tab that marks nothing imports every row.
CASINOS = {
    "fishingstar": dict(
        entity=33, name="Fishingstar", ref="FS", title="Fishing Star",
        banks={"MBB": 112, "MBB 2": 111, "CIMB": 101, "RHB": 97, "RHB 2": 100,
               "BSN": 98, "BSN 2": 99},
        label_prefix="F",
    ),
    "genting": dict(
        entity=39, name="Genting", ref="GT", title="Genting Casino",
        banks=None,
        label_prefix="G",
    ),
}

# The sheet's product names → the CRM catalogue, as the Robin Hood import read
# them. "Mega 2" is a second Mega888 kiosk, not another game.
GAMES = {
    "MG888": "Mega888", "Mega888": "Mega888", "Mega 2": "Mega888",
    "Scr918Kiss": "918Kiss", "Pussy888": "Pussy888", "Rollex": "Rollex",
    "JK123": "Joker", "Joker123": "Joker", "LuckyPalace": "LuckyPalace",
    "sport": "Sport", "Sport": "Sport", "XE88": "XE88", "3win8": "3win8",
    "Ace333": "Ace333", "918Kaya": "918Kaya", "Sky777": "Sky777", "Suncity": "Suncity",
    "Scr888": "Scr888", "4D": "4D",
}

BANK_NAMES = {"MBB": "Maybank", "CIMB": "CIMB", "RHB": "RHB", "BSN": "BSN",
              "HLBB": "Hong Leong", "PBB": "Public Bank", "AMBANK": "Ambank",
              "Gopay": "GoPayz", "Argo": "Argo"}
PLACEHOLDER = "TO BE CONFIRMED"

# Who a kiosk correction is recorded under (provider_bo_adjustments requires
# one): dev_demo, the super admin the Robin Hood backfill booked under too.
IMPORTER_USER = 1


# ── Reading the sheet ────────────────────────────────────────────────────────

def load_tabs(path):
    if path.endswith(".json"):
        tabs = json.load(open(path, encoding="utf-8"))["tabs"]
        return {k.strip(): v for k, v in tabs.items()}
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    return {name: [list(r) for r in wb[name].iter_rows(values_only=True)]
            for name in ("Deposit", "Withdrawal", "Free Credit")}


class Dater:
    """
    The date column for one month, with its gaps filled from the row above.

    A cell Excel read as a real date has day and month swapped (1/9 became
    9 January); a bare number is the day of this month (Robin Hood types "30");
    a date outside the month is a typo when it sits inside a run of this
    month's rows (Genting's five 27/8 among 27/9). A row with no date at all
    takes the one above it, a day later if the clock has wrapped past midnight —
    Genting stopped dating withdrawals after the 29th. Every such repair is
    listed in the report.
    """

    def __init__(self, year, month, tab, fixes):
        self.year, self.month, self.tab, self.fixes = year, month, tab, fixes
        self.last = None
        self.last_time = None

    def raw(self, v):
        if isinstance(v, datetime.datetime):
            return datetime.date(v.year, v.day, v.month)
        s = S(v)
        if not s:
            return None
        if re.fullmatch(r"\d{1,2}(\.0+)?", s):
            try:
                return datetime.date(self.year, self.month, int(float(s)))
            except ValueError:
                return None
        parts = re.split(r"[/.-]", s.split(" ")[0])
        if len(parts) != 3:
            return None
        try:
            if len(parts[0]) == 4:                  # "2026-01-09", the swap written out
                return datetime.date(int(parts[0]), int(parts[2]), int(parts[1]))
            y = int(parts[2])
            return datetime.date(y + 2000 if y < 100 else y, int(parts[1]), int(parts[0]))
        except ValueError:
            return None

    def __call__(self, n, v, t):
        d = self.raw(v)
        why = None
        if d is not None and (d.year, d.month) != (self.year, self.month):
            why, d = f"date {S(v)!r} outside the month", None
        if d is None and self.last is not None:
            d = self.last
            if t is not None and self.last_time is not None and \
                    t.hour * 60 + t.minute < self.last_time.hour * 60 + self.last_time.minute - 360:
                d = d + datetime.timedelta(days=1)
            self.fixes.append(f"{self.tab} row {n}: {why or 'blank date'} -> {d.isoformat()}")
        if d is not None:
            self.last = d
            if t is not None:
                self.last_time = t
        return d


def table(tabs, name, first_label, width):
    grid = tabs[name]
    for i, row in enumerate(grid[:40]):
        cells = [S(c) for c in row[:6]]
        if first_label in cells and "Date" in cells:
            break
    else:
        sys.exit(f"no header row on the {name} tab")
    for j, row in enumerate(grid[i + 1:]):
        core = list(row[:width]) + [None] * width
        yield i + 2 + j, core[:width]


def parse(path, year, month):
    tabs = load_tabs(path)
    out = collections.defaultdict(list)
    fixes = out["date_fixes"]

    dater = Dater(year, month, "Deposit", fixes)
    for n, row in table(tabs, "Deposit", "Remark", 14):
        remark, contact, date, time, code, login, product, pct, bank, amount, bonus, kwn, kwn_amt, _ = row
        time = read_time(time)
        code, bank, product, login = S(code).upper(), S(bank), S(product), digits(login)
        if not bank and not D(amount) and not D(bonus):
            continue
        date = dater(n, date, time)
        if date is None:
            out["skipped"].append(f"Deposit row {n}: no date")
            continue
        at, timed = stamp(date, time)
        rec = dict(row=n, at=at, timed=timed, day=date.isoformat(), code=code, login=login,
                   product=product, name=S(remark), pct=D(pct), bonus=money(D(bonus)),
                   bank=bank, amount=money(D(amount)))
        if product in rc.NON_GAME_PRODUCTS:
            out["not_imported:bank sweep on the deposit tab"].append(rec)
        elif bank.upper() == "REKEMEN":
            out["not_imported:referral (REKEMEN)"].append(rec)
        elif bank.upper() == "ID TO ID":
            out["not_imported:ID TO ID transfer leg"].append(rec)
        elif not bank:
            out["not_imported:bonus with no bank credit"].append(rec)
        else:
            out["deposits"].append(rec)

    dater = Dater(year, month, "Withdrawal", fixes)
    for n, row in table(tabs, "Withdrawal", "Date", 9):
        date, time, code, login, product, bank, amount, holder, account = row
        time = read_time(time)
        code, product, bank = S(code).upper(), S(product), S(bank)
        if not product:
            continue
        date = dater(n, date, time)
        if date is None:
            out["skipped"].append(f"Withdrawal row {n}: no date")
            continue
        at, timed = stamp(date, time)
        rec = dict(row=n, at=at, timed=timed, day=date.isoformat(), code=code,
                   login=digits(login), product=product, bank=bank, amount=money(D(amount)),
                   holder=S(holder), account=digits(account))
        if product in rc.NON_GAME_PRODUCTS or not is_member_code(code):
            out["not_imported:Clear Bank / charge / expense"].append(rec)
        else:
            out["withdrawals"].append(rec)

    dater = Dater(year, month, "Free Credit", fixes)
    marked = False
    fcs = []
    for n, row in table(tabs, "Free Credit", "Date", 8):
        date, time, code, login, product, amount, r1, r2 = row
        time = read_time(time)
        code, product, login = S(code).upper(), S(product), digits(login)
        if not product and not D(amount):
            continue
        date = dater(n, date, time)
        if date is None:
            out["skipped"].append(f"Free Credit row {n}: no date")
            continue
        at, timed = stamp(date, time)
        remark = " ".join(x for x in (S(r1), S(r2)) if x)
        marked = marked or "✔" in remark or "❌" in remark
        fcs.append(dict(row=n, at=at, timed=timed, day=date.isoformat(), code=code, login=login,
                        product=product, amount=money(D(amount)), remark=remark))
    for r in fcs:
        if marked and "✔" not in r["remark"]:
            out["not_imported:free credit marked ❌ (not given)"].append(r)
        else:
            out["free_credits"].append(r)

    out["dashboard"] = dashboard(tabs["Deposit"])
    return out


def dashboard(grid):
    """
    The block above the Deposit table: each bank's balance (name in B, figure
    in C; the second set in J/K) and each kiosk's credit (game in M, figure in N).
    The name cell carries the holder too — "MBB/YAIKATH", "RHB 2-YAN KOON PENG".
    """
    cell = lambda r, c: grid[r][c] if r < len(grid) and c < len(grid[r]) else None
    banks, kiosks = {}, {}
    # Rows 2-8. Genting lists its banks again from row 9 down, without figures.
    for r in range(1, 8):
        for nc, vc in ((1, 2), (9, 10)):
            name = S(cell(r, nc))
            if not name or re.match(r"\d", name):
                continue
            code, holder = (re.split(r"\s*[/-]\s*", name, maxsplit=1) + [""])[:2]
            code = re.sub(r"\s+", " ", code.strip())
            banks[code] = dict(balance=money(D(str(cell(r, vc) or "0").replace(",", ""))),
                               holder=holder.strip(), label=name)
    for r in range(1, 17):
        game = S(cell(r, 12))
        if game and not re.fullmatch(r"[\d.,]+", game):
            kiosks[game] = money(D(str(cell(r, 13) or "0").replace(",", "")))
    return dict(banks=banks, kiosks=kiosks)


# ── Database plumbing ────────────────────────────────────────────────────────

def dsn():
    url = os.environ.get("DATABASE_URL")
    if not url:
        for line in open(os.path.join(HERE, "..", ".env.local"), encoding="utf-8"):
            if line.startswith("DATABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
    u = urllib.parse.urlsplit(url)
    if u.hostname.startswith("db.") and u.hostname.endswith(".supabase.co"):
        ref = u.hostname.split(".")[1]
        u = u._replace(netloc=f"postgres.{ref}:{u.password}@aws-0-ap-southeast-1.pooler.supabase.com:5432")
    return urllib.parse.urlunsplit(u)


PSQL = os.environ.get("PSQL", "/d/Program Files/PostgreSQL/17/bin/psql")
if not os.path.exists(PSQL):
    PSQL = r"D:\Program Files\PostgreSQL\17\bin\psql.exe"


def psql(sql=None, path=None):
    cmd = [PSQL, dsn(), "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    cmd += ["-f", path] if path else ["-A", "-t", "-F", "\t", "-c", sql]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if out.returncode:
        sys.exit(f"psql failed:\n{out.stdout}\n{out.stderr}")
    return out.stdout


def fetch_state(cfg):
    """Members, their game logins, and the casino's accounts and kiosks — read only."""
    e = cfg["entity"]
    q = lambda s: [l.split("\t") for l in psql("SET TRANSACTION READ ONLY; " + s).strip().splitlines() if l]
    name = q(f"SELECT name FROM entities WHERE entity_id = {e} AND entity_type = 'company'")
    if not name or name[0][0] != cfg["name"]:
        sys.exit(f"entity {e} is {name!r}, expected {cfg['name']!r}")
    members = {c: int(i) for c, i in q(
        f"SELECT upper(trim(username)), player_id FROM players WHERE company_entity_id = {e}")}
    logins = collections.defaultdict(set)
    for c, g, u in q(f"""SELECT upper(trim(p.username)), g.game_name, lower(trim(g.game_username))
                           FROM member_game_accounts g JOIN players p ON p.player_id = g.member_id
                          WHERE p.company_entity_id = {e}"""):
        logins[c].add((g, u))
    accounts = {int(i): dict(label=l, bank=b, balance=Decimal(v)) for i, l, b, v in q(
        f"SELECT account_id, coalesce(label,''), bank_name, current_balance FROM bank_accounts WHERE entity_id = {e}")}
    kiosks = {g: dict(id=int(i), credit=Decimal(v)) for i, g, v in q(
        f"SELECT bo_account_id, game_name, current_credit FROM provider_bo_accounts WHERE company_entity_id = {e}")}
    return dict(members=members, logins=logins, accounts=accounts, kiosks=kiosks)


# ── Deciding what goes in ────────────────────────────────────────────────────

def plan(cfg, data, state):
    out = collections.defaultdict(list)
    members = state["members"]
    for kind in ("deposits", "withdrawals", "free_credits"):
        for r in data[kind]:
            if r["code"] not in members:
                out[f"not_imported:{kind[:-1].replace('_', ' ')} with a code not in the CRM"].append(r)
            elif r["amount"] <= 0 and kind != "deposits":
                out[f"not_imported:{kind[:-1].replace('_', ' ')} of zero or less"].append(r)
            else:
                game = GAMES.get(r["product"])
                if r["product"] and not game:
                    out["unknown_products"].append(r)
                r["game"] = game
                if game and r["login"] and (game, r["login"].lower()) not in state["logins"][r["code"]]:
                    out["login_not_on_member"].append(r)
                out[kind].append(r)
    return out


def bank_map(cfg, data, state):
    """Sheet bank code → (account_id or None to create, bank name)."""
    used = {r["bank"] for r in data["deposits"] + data["withdrawals"]}
    if cfg["banks"] is not None:
        missing = used - set(cfg["banks"])
        if missing:
            sys.exit(f"bank codes on the sheet with no account: {sorted(missing)}")
        for code, aid in cfg["banks"].items():
            if aid not in state["accounts"]:
                sys.exit(f"account {aid} ({code}) is not one of {cfg['name']}'s")
        return {c: (aid, state["accounts"][aid]["bank"]) for c, aid in cfg["banks"].items()}, []
    # Create one per bank the sheet uses or holds money in.
    create = []
    for code, fig in data["dashboard"]["banks"].items():
        if code in used or fig["balance"]:
            base = re.sub(r"\s*\d+$", "", code)
            create.append(dict(code=code, bank=BANK_NAMES.get(base, base),
                               holder=fig["holder"] or PLACEHOLDER,
                               label=f"{cfg['label_prefix']}-{code}-{fig['holder']}".rstrip("-"),
                               balance=fig["balance"]))
    missing = used - {c["code"] for c in create}
    if missing:
        sys.exit(f"bank codes on the sheet that its bank block doesn't list: {sorted(missing)}")
    return {c["code"]: (None, c["bank"]) for c in create}, create


# ── SQL ──────────────────────────────────────────────────────────────────────

def build_sql(cfg, key, sheet_title, p, banks, create, sync, state, finish):
    e = cfg["entity"]
    batch = f"{cfg['key']}-{key}"
    sql = ["BEGIN;", "SET LOCAL client_min_messages = warning;", "SET LOCAL TIME ZONE 'UTC';"]
    add = sql.append

    add(f"""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM deposits WHERE external_id LIKE {lit(cfg['key'] + ':' + key + ':%')})
     OR EXISTS (SELECT 1 FROM transactions WHERE entity_id = {e} AND details->>'import_batch' = {lit(batch)}) THEN
    RAISE EXCEPTION 'batch {batch} is already in the database';
  END IF;
END $$;""")

    # ── bank accounts ──
    add("CREATE TEMP TABLE imp_bank (code text PRIMARY KEY, account_id int, bank_name text) ON COMMIT DROP;")
    if create:
        add("""CREATE TEMP TABLE new_bank (code text, bank_name text, holder text, label text,
                                    balance numeric, account_id int) ON COMMIT DROP;""")
        add(copy_block("new_bank", ["code", "bank_name", "holder", "label", "balance"],
                       [(c["code"], c["bank"], c["holder"], c["label"], c["balance"]) for c in create]))
        add(f"""
UPDATE new_bank SET account_id = nextval('bank_accounts_account_id_seq');
-- The sheet names the bank and the holder, never the number. 'both' because
-- the casino pays out of the same accounts it collects into.
INSERT INTO bank_accounts (account_id, entity_id, role, bank_name, account_number, account_holder,
                           label, current_balance, opening_balance, opening_balance_at, status)
  SELECT account_id, {e}, 'both', bank_name, {lit(PLACEHOLDER)}, holder, label, balance, balance,
         now(), 'active' FROM new_bank;
INSERT INTO imp_bank SELECT code, account_id, bank_name FROM new_bank;""")
    else:
        add(copy_block("imp_bank", ["code", "account_id", "bank_name"],
                       [(c, aid, b) for c, (aid, b) in banks.items()]))

    # ── members ──
    add("""CREATE TEMP TABLE imp_member ON COMMIT DROP AS
  SELECT upper(trim(username)) AS code, player_id FROM players WHERE company_entity_id = """ + str(e) + ";")

    # ── deposits ──
    dep_rows = [(f"{cfg['key']}:{key}:D{r['row']}", f"{cfg['ref']}-{key.replace('-', '')[2:]}-D{r['row']}",
                 r["at"], r["timed"], r["code"], r["amount"], r["bank"],
                 (r["pct"] * 100).quantize(Decimal("0.01")), r["bonus"], money(r["amount"] + r["bonus"]),
                 r["game"], r["login"] or None, r["name"] or None, f"D{r['row']}")
                for r in p["deposits"]]
    add("""CREATE TEMP TABLE imp_dep (external_id text, ref text, at timestamptz, timed boolean, code text,
                           amount numeric, bank_code text, pct numeric, bonus numeric, total numeric,
                           game text, login text, name text, sheet_row text, deposit_id int) ON COMMIT DROP;""")
    add(copy_block("imp_dep", ["external_id", "ref", "at", "timed", "code", "amount", "bank_code", "pct",
                               "bonus", "total", "game", "login", "name", "sheet_row"], dep_rows))
    add(f"""
UPDATE imp_dep SET deposit_id = nextval('deposits_deposit_id_seq');
INSERT INTO deposits (deposit_id, external_id, transaction_ref, deposit_date, deposit_time_known,
                      player_id, player_username, company_entity_id, deposit_amount, bank_name,
                      bank_description, received_into_account_id, bonus_plan_id, bonus_percentage,
                      bonus_amount, total_amount, selected_game, selected_game_username, status,
                      source, skip_bot, matched_at, approved_at, created_at, updated_at)
  SELECT d.deposit_id, d.external_id, d.ref, d.at, d.timed, m.player_id, d.code, {e}, d.amount,
         b.bank_name, d.name, b.account_id, NULL, d.pct, d.bonus, d.total, d.game, d.login,
         'completed', 'manual', true, d.at, d.at, d.at, d.at
    FROM imp_dep d JOIN imp_member m USING (code) JOIN imp_bank b ON b.code = d.bank_code;
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id, details, created_at)
  SELECT m.player_id, {e}, 'deposit', d.amount, d.game, d.deposit_id,
         jsonb_build_object('source', 'import', 'action', 'imported', 'status', 'completed',
                            'bank', b.bank_name, 'bonus_percentage', d.pct, 'bonus_amount', d.bonus,
                            'sheet_row', d.sheet_row, 'import_batch', {lit(batch)}),
         d.at
    FROM imp_dep d JOIN imp_member m USING (code) JOIN imp_bank b ON b.code = d.bank_code;
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id, details, created_at)
  SELECT m.player_id, {e}, 'game_topup', d.total, d.game, d.deposit_id,
         jsonb_build_object('source', 'import', 'action', 'imported_complete',
                            'game_username', d.login, 'bonus_amount', d.bonus,
                            'sheet_row', d.sheet_row, 'import_batch', {lit(batch)}),
         d.at
    FROM imp_dep d JOIN imp_member m USING (code)
   WHERE d.game IS NOT NULL;""")

    # ── withdrawals ──
    note = f"Imported from {sheet_title}"
    wd_rows = [(r["at"], r["code"], r["amount"], r["game"], r["login"] or None, r["account"] or None,
                r["bank"], f"W{r['row']}") for r in p["withdrawals"]]
    add("""CREATE TEMP TABLE imp_wd (at timestamptz, code text, amount numeric, game text, login text,
                          account text, bank_code text, sheet_row text, withdrawal_id int) ON COMMIT DROP;""")
    add(copy_block("imp_wd", ["at", "code", "amount", "game", "login", "account", "bank_code", "sheet_row"],
                   wd_rows))
    add(f"""
UPDATE imp_wd SET withdrawal_id = nextval('withdrawals_withdrawal_id_seq');
-- The member's bank, where the account number the sheet paid to is one the
-- member has on file; the sheet itself never names it.
INSERT INTO withdrawals (withdrawal_id, player_id, requested_amount, game_name, game_username,
                         credit_pulled_amount, status, skip_bot, source, bank_name,
                         bank_account_number, paid_from_account_id, paid_at, created_at, updated_at,
                         withdraw_all, edit_note)
  SELECT w.withdrawal_id, m.player_id, w.amount, w.game, w.login, w.amount, 'paid', true, 'manual',
         (SELECT nullif(mb.bank_name, '') FROM member_bank_accounts mb
           WHERE mb.member_id = m.player_id AND mb.account_number = w.account LIMIT 1),
         w.account, b.account_id, w.at, w.at, w.at, false,
         {lit(note)} || ' row ' || substr(w.sheet_row, 2)
    FROM imp_wd w JOIN imp_member m USING (code) JOIN imp_bank b ON b.code = w.bank_code;
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id, details, created_at)
  SELECT m.player_id, {e}, 'credit_pull', w.amount, w.game, w.withdrawal_id,
         jsonb_build_object('source', 'import', 'action', 'imported_pull', 'game_username', w.login,
                            'sheet_row', w.sheet_row, 'import_batch', {lit(batch)}),
         w.at
    FROM imp_wd w JOIN imp_member m USING (code);
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, reference_id, details, created_at)
  SELECT m.player_id, {e}, 'withdrawal', w.amount, w.game, w.withdrawal_id,
         jsonb_build_object('source', 'import', 'action', 'imported_paid', 'bank', b.bank_name,
                            'account_number', w.account, 'sheet_row', w.sheet_row,
                            'import_batch', {lit(batch)}),
         w.at
    FROM imp_wd w JOIN imp_member m USING (code) JOIN imp_bank b ON b.code = w.bank_code;""")

    # ── free credits: the ledger row is the record ──
    fc_rows = [(r["at"], r["code"], r["amount"], r["game"], r["login"] or None, r["remark"] or None,
                f"F{r['row']}") for r in p["free_credits"]]
    add("""CREATE TEMP TABLE imp_fc (at timestamptz, code text, amount numeric, game text, login text,
                          remark text, sheet_row text) ON COMMIT DROP;""")
    add(copy_block("imp_fc", ["at", "code", "amount", "game", "login", "remark", "sheet_row"], fc_rows))
    add(f"""
INSERT INTO transactions (player_id, entity_id, type, amount, game_name, details, created_at)
  SELECT m.player_id, {e}, 'game_topup', f.amount, f.game,
         jsonb_build_object('source', 'manual', 'action', 'free_credit', 'kind', 'free_credit',
                            'imported', true, 'remark', f.remark, 'game_username', f.login,
                            'sheet_row', f.sheet_row, 'import_batch', {lit(batch)}),
         f.at
    FROM imp_fc f JOIN imp_member m USING (code);""")

    # ── member totals ──
    add(f"""
UPDATE players p SET total_deposits = p.total_deposits + x.amount
  FROM (SELECT m.player_id, sum(d.amount) AS amount FROM imp_dep d JOIN imp_member m USING (code)
         GROUP BY 1) x WHERE p.player_id = x.player_id;
UPDATE players p SET total_withdrawals = p.total_withdrawals + x.amount
  FROM (SELECT m.player_id, sum(w.amount) AS amount FROM imp_wd w JOIN imp_member m USING (code)
         GROUP BY 1) x WHERE p.player_id = x.player_id;""")

    # ── every row landed, or nothing does ──
    n_dep, n_wd, n_fc = len(dep_rows), len(wd_rows), len(fc_rows)
    add(f"""
DO $$ DECLARE d int; w int; f int; BEGIN
  SELECT count(*) INTO d FROM deposits WHERE external_id LIKE {lit(cfg['key'] + ':' + key + ':%')};
  SELECT count(*) INTO w FROM transactions WHERE entity_id = {e} AND type = 'withdrawal'
     AND details->>'import_batch' = {lit(batch)};
  SELECT count(*) INTO f FROM transactions WHERE entity_id = {e} AND details->>'action' = 'free_credit'
     AND details->>'import_batch' = {lit(batch)};
  IF d <> {n_dep} OR w <> {n_wd} OR f <> {n_fc} THEN
    RAISE EXCEPTION 'expected % deposits, % withdrawals, % free credits; wrote %, %, %',
      {n_dep}, {n_wd}, {n_fc}, d, w, f;
  END IF;
END $$;""")

    # ── balances, from the sheet's dashboard ──
    if sync:
        for aid, fig in sync["banks"]:
            add(f"""
-- As a leader's correction in Bank accounts: the difference goes into the
-- opening balance, so opening + in - out = current still holds.
UPDATE bank_accounts SET opening_balance = opening_balance + ({fig} - current_balance),
                         opening_balance_at = coalesce(opening_balance_at, created_at),
                         current_balance = {fig}
 WHERE account_id = {aid} AND entity_id = {e};""")
        for kid, game, delta in sync["kiosks"]:
            add(f"""
WITH adj AS (
  INSERT INTO provider_bo_adjustments (bo_account_id, amount, reason, handled_by_user_id)
  VALUES ({kid}, {delta}, {lit('Set to ' + sheet_title + "'s kiosk balance at import")}, {IMPORTER_USER})
  RETURNING adjustment_id)
INSERT INTO transactions (entity_id, type, amount, game_name, reference_id, user_id, details)
  SELECT {e}, 'bo_adjustment', {delta}, {lit(game)}, adjustment_id, {IMPORTER_USER},
         jsonb_build_object('reason', {lit('Set to ' + sheet_title + "'s kiosk balance at import")},
                            'bo_username', (SELECT bo_username FROM provider_bo_accounts WHERE bo_account_id = {kid}),
                            'import_batch', {lit(batch)})
    FROM adj;
UPDATE provider_bo_accounts SET current_credit = current_credit + {delta}
 WHERE bo_account_id = {kid} AND company_entity_id = {e};""")

    add(f"\n{finish};")
    return "\n".join(sql)


def balance_sync(cfg, data, state, banks):
    """The sheet's figure for each account and kiosk the casino has, where they differ."""
    dash = data["dashboard"]
    bank_out, kiosk_out, notes = [], [], []
    for code, (aid, _) in banks.items():
        fig = dash["banks"].get(code)
        if aid is None or fig is None:
            continue
        have = state["accounts"][aid]["balance"]
        if fig["balance"] != have:
            bank_out.append((aid, fig["balance"]))
            notes.append(f"bank {code:7} #{aid}: {have:>12} -> {fig['balance']:>12}")
    for game, credit in dash["kiosks"].items():
        name = GAMES.get(game, game)
        k = state["kiosks"].get(name)
        if not k:
            notes.append(f"kiosk {game}: {credit} on the sheet, no such kiosk in the CRM — left alone")
            continue
        delta = money(credit - k["credit"])
        if delta:
            kiosk_out.append((k["id"], name, delta))
            notes.append(f"kiosk {name:12}: {k['credit']:>12} -> {credit:>12}  ({delta:+})")
    return dict(banks=bank_out, kiosks=kiosk_out), notes


# ── Report ───────────────────────────────────────────────────────────────────

def report(cfg, key, data, p, create, sync_notes):
    tot = lambda rs, k="amount": money(sum((r[k] for r in rs), Decimal(0)))
    print(f"\n{cfg['title']} {key}")
    print(f"  deposits     {len(p['deposits']):>6}  RM {tot(p['deposits']):>12}   bonus RM {tot(p['deposits'], 'bonus')}")
    print(f"  withdrawals  {len(p['withdrawals']):>6}  RM {tot(p['withdrawals']):>12}")
    print(f"  free credits {len(p['free_credits']):>6}  RM {tot(p['free_credits']):>12}")
    days = sorted({r["day"] for k in ("deposits", "withdrawals", "free_credits") for r in p[k]})
    if days:
        print(f"  dated {days[0]} .. {days[-1]}")
    by_bank = collections.Counter(r["bank"] for r in p["deposits"])
    print(f"  deposits by bank: {dict(sorted(by_bank.items()))}")
    if create:
        print("  bank accounts to create:")
        for c in create:
            print(f"    {c['label']:40} {c['bank']:12} RM {c['balance']}")
    print("  not imported:")
    for k in sorted(k for k in list(data) + list(p) if k.startswith("not_imported:")):
        rs = data.get(k, []) + p.get(k, [])
        if rs:
            ex = ", ".join(f"{r['row']}:{r['code'] or '-'}" for r in rs[:6])
            print(f"    {k[13:]:48} {len(rs):>5}  RM {tot(rs):>10}   e.g. rows {ex}")
    if data["date_fixes"]:
        c = collections.Counter(f.split(" row ")[0] + " — " + f.split(": ", 1)[1].split(" -> ")[0]
                                for f in data["date_fixes"])
        print("  dates repaired:")
        for k, v in c.items():
            print(f"    {k}: {v}")
    for k in ("skipped", "unknown_products"):
        if data.get(k) or p.get(k):
            print(f"  {k}: {(data.get(k) or []) + (p.get(k) or [])}")
    if p["login_not_on_member"]:
        print(f"  {len(p['login_not_on_member'])} rows name a game login the member doesn't have on file "
              f"(kept on the row; the member's accounts are not changed)")
    if sync_notes:
        print("  balance sync:")
        for n in sync_notes:
            print(f"    {n}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("casino", choices=sorted(CASINOS))
    ap.add_argument("source")
    ap.add_argument("year", type=int)
    ap.add_argument("month", type=int)
    ap.add_argument("--title", help="the sheet's name, for notes (default: from the file name)")
    ap.add_argument("--sync-balances", action="store_true")
    ap.add_argument("--check", action="store_true", help="run in prod, then ROLLBACK")
    ap.add_argument("--apply", action="store_true", help="run in prod and COMMIT")
    ap.add_argument("--sql-out")
    args = ap.parse_args()

    cfg = {**CASINOS[args.casino], "key": args.casino}
    key = f"{args.year}-{args.month:02d}"
    title = args.title or os.path.splitext(os.path.basename(args.source))[0]

    data = parse(args.source, args.year, args.month)
    state = fetch_state(cfg)
    p = plan(cfg, data, state)
    banks, create = bank_map(cfg, data, state)
    sync, notes = (balance_sync(cfg, data, state, banks) if args.sync_balances else (None, []))
    report(cfg, key, data, p, create, notes)

    finish = "COMMIT" if args.apply else "ROLLBACK"
    sql = build_sql(cfg, key, title, p, banks, create, sync, state, finish)
    path = args.sql_out or os.path.join(tempfile.mkdtemp(), f"import-{args.casino}-{key}.sql")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(sql)
    print(f"\nSQL: {path} ({len(sql) // 1024} KB, ends in {finish})")
    if args.check or args.apply:
        psql(path=path)
        print("committed." if args.apply else "ran cleanly and rolled back — nothing written.")


if __name__ == "__main__":
    main()

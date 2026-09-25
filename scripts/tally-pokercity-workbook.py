#!/usr/bin/env python3
"""
Compare the client's Sept workbook against what we hold, day by day.

    python3 scripts/tally-pokercity-workbook.py \
        "~/Desktop/Projects/console/Poker City Transaction Sept 2026.xlsx" \
        --db crm_sg

Read-only on both sides. It never writes to the database and never touches the
workbook.

TWO THINGS ABOUT THE WORKBOOK THAT HAVE TO BE HANDLED OR THE COMPARISON IS NOISE
--------------------------------------------------------------------------------
1. The dates are broken, in a repairable way. Whoever typed "1/9" into a sheet
   set to m/d/yyyy got 9 January; days 13 and up could not be read as a month at
   all so they stayed as the text "13/9/2026". Everything in the book is
   September, so: a datetime of 2026-MM-09 means September MM, and the text
   "D/9/2026" means September D.
2. Thousands of rows at the bottom are drag-filled padding — a date and nothing
   else. They are dropped by requiring a product and an amount, which is the
   same test `scripts/import-pokercity.py` applies.

Rows whose Product is Clear Bank, Bank Charge or Expenses are excluded from both
sides. They are bank movements, not a player's deposit or withdrawal, and on our
side they live in bank_cash_outs — counting them here would compare a deposit
against a cash-out.

The comparison stops at the last day we hold. The client keeps typing after we
last imported, and a day they have and we do not is not a discrepancy, it is a
day that has not been imported yet.
"""

from __future__ import annotations

import argparse
import datetime as dt
import subprocess
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

import openpyxl

NON_GAME = {"clear bank", "bank charge", "expenses"}
PSEUDO_BANKS = {"rekemen", "id to id"}
YEAR, MONTH = 2026, 9


def sheet_day(v) -> int | None:
    """September day-of-month, undoing Excel's m/d parse. See the note above."""
    if isinstance(v, dt.datetime):
        # 2026-MM-09 → the month IS the day that was typed.
        if v.year == YEAR and v.day == MONTH:
            return v.month
        # Already correct (someone retyped it properly).
        if v.year == YEAR and v.month == MONTH:
            return v.day
        return None
    if isinstance(v, str):
        head = v.strip().split("/")[0]
        return int(head) if head.isdigit() and 1 <= int(head) <= 31 else None
    return None


def money(v) -> Decimal:
    if v is None or (isinstance(v, str) and not v.strip()):
        return Decimal(0)
    try:
        return Decimal(str(v).replace(",", "").strip())
    except Exception:
        return Decimal(0)


def text(v) -> str:
    return "" if v is None else str(v).strip()


def read_workbook(path: Path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    dep: dict[int, list[Decimal]] = defaultdict(list)
    wdr: dict[int, list[Decimal]] = defaultdict(list)

    # +Deposit — header on row 15, data from 16. Columns:
    # date time code contact remark username product pct bank amount _ bonus …
    for row in wb["+Deposit"].iter_rows(min_row=16, values_only=True):
        day = sheet_day(row[0])
        product, bank, amount = text(row[6]), text(row[8]), money(row[9])
        if day is None or not product or product.lower() in NON_GAME:
            continue
        if not bank or bank.lower() in PSEUDO_BANKS or amount <= 0:
            continue
        dep[day].append(amount)

    # -Withdrawal — date time code login product bank amount holder account
    for row in wb["-Withdrawal"].iter_rows(min_row=2, values_only=True):
        day = sheet_day(row[0])
        product, amount = text(row[4]), money(row[6])
        if day is None or not product or product.lower() in NON_GAME or amount <= 0:
            continue
        wdr[day].append(amount)

    wb.close()
    return dep, wdr


def read_db(db: str, company: int):
    """
    Scoped to one company, and that matters.

    The database holds more than Pokercity. `Demo Casino` (entity 3) carries the
    rows somebody made while trying the CRM out on 18 Sept — player `GA0001`
    ("With Game") and `TEST002` ("sdf"), five deposits of RM 1,371.00 and one
    withdrawal of RM 10.00. Counting those against Pokercity's workbook is what
    put 18 Sept out by RM 1,310 and 23 Sept's withdrawals out by exactly RM 10.
    They are not a discrepancy; they are a different company.
    """
    sql = f"""
      SELECT 'd', extract(day from d.deposit_date)::int, count(*), sum(d.deposit_amount)
        FROM deposits d JOIN players p USING (player_id)
       WHERE d.status = 'completed' AND p.company_entity_id = {company}
       GROUP BY 2
      UNION ALL
      SELECT 'w', extract(day from w.created_at)::int, count(*), sum(w.requested_amount)
        FROM withdrawals w JOIN players p USING (player_id)
       WHERE w.status = 'paid' AND p.company_entity_id = {company}
       GROUP BY 2;
    """
    out = subprocess.run(
        ["psql", "-X", "-A", "-F", "|", "-t", "-d", db, "-c", sql],
        capture_output=True, text=True, check=True,
    ).stdout
    dep: dict[int, tuple[int, Decimal]] = {}
    wdr: dict[int, tuple[int, Decimal]] = {}
    for line in out.strip().splitlines():
        kind, day, n, total = line.split("|")
        (dep if kind == "d" else wdr)[int(day)] = (int(n), Decimal(total))
    return dep, wdr


def report(title: str, theirs: dict[int, list[Decimal]], ours: dict[int, tuple[int, Decimal]], last_day: int):
    print(f"\n=== {title} — to {last_day} Sept, the last day we hold ===")
    print(f"{'Day':>4} {'their rows':>11} {'their amount':>14} {'our rows':>9} {'our amount':>13} {'diff':>12}")
    t_rows = t_amt = o_rows = 0
    o_amt = Decimal(0)
    for day in range(1, last_day + 1):
        th = theirs.get(day, [])
        on, oa = ours.get(day, (0, Decimal(0)))
        ta = sum(th, Decimal(0))
        diff = oa - ta
        flag = "" if diff == 0 else "  <-"
        print(f"{day:>4} {len(th):>11} {ta:>14,.2f} {on:>9} {oa:>13,.2f} {diff:>12,.2f}{flag}")
        t_rows += len(th); t_amt = (t_amt or Decimal(0)) + ta
        o_rows += on; o_amt += oa
    print(f"{'ALL':>4} {t_rows:>11} {t_amt:>14,.2f} {o_rows:>9} {o_amt:>13,.2f} {o_amt - t_amt:>12,.2f}")
    return t_rows, t_amt, o_rows, o_amt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook", type=lambda s: Path(s).expanduser())
    ap.add_argument("--db", default="crm_sg")
    ap.add_argument("--company", type=int, default=30,
                    help="entities.entity_id for Pokercity; the DB holds other companies")
    a = ap.parse_args()

    their_dep, their_wdr = read_workbook(a.workbook)
    our_dep, our_wdr = read_db(a.db, a.company)
    last_day = max([*our_dep, *our_wdr])

    report("DEPOSITS", their_dep, our_dep, last_day)
    report("WITHDRAWALS", their_wdr, our_wdr, last_day)
    print("\nA day that differs is not automatically wrong — read the rows before concluding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

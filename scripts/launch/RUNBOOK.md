# Pokercity launch — runbook

Everything below was rehearsed end to end against a throwaway local database
and reconciles to the workbook's own dashboard. Times are Kuala Lumpur.

## Before 22:00 — on the new Singapore Supabase

Supabase hands out two pooler ports. Use them for different things:

| port | pooler | for |
|------|--------|-----|
| 6543 | transaction | the app — `DATABASE_URL` in Vercel |
| 5432 | session | bootstrap, seeding, imports, psql |

The transaction pooler drops session state between statements, so a schema load
over 6543 creates the tables and then fails on the first unqualified INSERT.

```bash
export NEW="postgres://…pooler.supabase.com:5432/postgres"   # session pooler

./scripts/launch/bootstrap.sh "$NEW"          # schema + settings + bonus plans
npx tsx scripts/launch/seed-tree.ts --db "$NEW" \
    --leaders "/Users/ariuslee/Desktop/console/Leaders .xlsx"
```

That gives: ALL Group, 3 super admins, 24 clubs, 54 leader logins, Pokercity
and its CS desk. Check it with `./scripts/launch/bootstrap.sh "$NEW" --verify`.

Passwords are username + `888` (`jianlun888`, `ttt777888`, `pkcs001888`).

## At 22:00 — when the cutoff workbook arrives

```bash
DATABASE_URL="$NEW" python3 scripts/import-pokercity.py "<cutoff>.xlsx"
```

Dry run first — it writes nothing and prints the reconciliation. It aborts on
its own if the rows disagree with the dashboard. Then:

```bash
DATABASE_URL="$NEW" python3 scripts/import-pokercity.py "<cutoff>.xlsx" --apply
```

It re-reads the totals out of the database afterwards and fails loudly if any
of them moved. To redo it: add `--replace`, which clears **this casino's data
only** and leaves the group tree and the 57 logins alone.

## Then — point the app at it

1. Set `DATABASE_URL` in Vercel to the new project.
2. Rotate `SESSION_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` while you are there.
3. **Redeploy.** An env-var change does not reach the running deployment.

## What the import does and does not do

Imports: members, their game logins and bank accounts, deposits with their
bonuses, withdrawals, free credits, Rekemen referral bonuses, the kiosk credit
per game, and the bank balance per account.

Does not: create entities or logins (seed-tree.ts owns those), mint bonus
plans (the everyday 5/10/15 are typed percentages — a plan is a once-per-period
rule and 339 member-days in this data carry more than one bonus), or replay the
104 bank-movement rows (sweeps, charges, cross-casino backups). The cutoff
balances already account for those.

## Known gaps

- **CIMB 3 and MBB 2** are created with account number `TO BE CONFIRMED`. The
  deposits and balances are right; only the number and holder are missing.
- **Bonus rounding.** This club floors a part-ringgit bonus: RM 25 at 5% is
  paid as RM 1.00, not RM 1.25 — 515 rows in this file. History imports as
  written, but the CRM computes 1.25 on rows entered from tonight.

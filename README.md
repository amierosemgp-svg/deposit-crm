# Players Console

Unified deposit / withdrawal CRM for the MPG group. Next.js 16 (App Router) +
Drizzle + Postgres. The OpenClaw bank bot feeds deposits in through a secured
API; CS agents approve top-ups and process withdrawals; leaders manage the org
hierarchy and treasury transfers.

## Stack

- **Next.js 16** — frontend + API route handlers in one deployable
- **Postgres** (local for dev, Supabase in prod) via **Drizzle ORM**
- **Session auth** — bcrypt + signed JWT cookie; role-based access (super_admin
  / company_leader / cs_agent / viewer)
- **Bot API** — API-key secured, under `/api/bot/*` (see ../API.md)
- **Supabase Storage** — deposit receipts / payout proofs (local disk fallback)

## Org model

```
main_company (MPG)
└── leader          (shareholder of the main company)
    └── company      (a leader owns one or more)
        └── cs        (CS desk; players belong to the company)
```

`entities` is one self-referential table; `bank_accounts` belong to entities and
have a `role` of `deposit` (player collection, watched by the bot) or
`withdrawal` (payouts). Treasury transfers are allowed company→company under the
same leader, or leader→own company, and require recipient confirmation
(auto-confirmed after a configurable window; default 24h).

## Bonuses

A bonus is a rule, not a percentage. `bonus_plans` holds the catalogue
(the **Bonuses** page; super admin owns the house-wide ones, a leader can pin
a plan to a company they own) and every deposit records which plan it used, so
eligibility is answerable instead of remembered:

| Type | Who qualifies | What the % applies to |
|------|---------------|-----------------------|
| `welcome` | Their first deposit, once ever | The deposit |
| `recurring` | Once per calendar day / week / month | The deposit |
| `rebate` | Once per period, and only if they're down over it | The **net loss** (completed deposits − paid withdrawals) |

Every type can set a minimum deposit; a rebate can also set a minimum loss.
Periods are calendar-based in business time (UTC+8, Malaysia): a week starts
Monday, a month on the 1st. A deposit holds its claim on a plan unless it
fails, so an in-flight deposit can't be double-bonused.

CS picks from the dropdown on the deposits screen, which shows each bonus with
a yes/no and the reason for a no. The API re-checks on write and rejects an
ineligible bonus with 422; a leader or the super admin can force one through by
supplying `bonus_override_reason`, which is stored on the deposit and written
to the audit log. Editing a plan only affects future deposits — each deposit
snapshots the percentage and amount it was given.

An existing database needs `migrations/2026-08-16-bonus-plans.sql`; a fresh
`pnpm db:push` creates it all.

## Local development

```bash
pnpm install
# Postgres must be running; DATABASE_URL is in .env.local
pnpm db:push      # create/refresh schema
pnpm db:seed      # seed the role accounts + bot key + settings
pnpm dev          # http://localhost:3060
pnpm bot:replay   # fire sources/transaction_queue.json at the bot API
```

### Environment (`.env.local`)

```
DATABASE_URL=postgres://user@localhost:5432/deposit_crm
SESSION_SECRET=<openssl rand -hex 32>
BOT_API_KEY=dbk_<openssl rand -hex 24>
SEED_PASSWORD=Mpg@2026            # optional; password for seeded accounts
# Production only:
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>   # for receipt uploads
CRON_SECRET=<random>              # protects /api/cron/auto-confirm
```

## Seeded accounts

`pnpm db:seed` creates exactly one login per role (password = `SEED_PASSWORD`,
default `Mpg@2026`) and nothing else — no dummy players or transactions:

| Username | Role | Scope |
|----------|------|-------|
| `admin` | Super Admin | Everything |
| `leader1` | Company Leader | Leader One's companies |
| `cs1` | CS Agent | Company One |
| `viewer` | Viewer | Read-only |

All real data enters through the UI or the bot API.

## Deploy (Vercel + Supabase)

1. Create a Supabase project; copy its connection string (use the **pooled**
   `6543` connection string for serverless).
2. In Vercel, import this repo (root = `crm/`). Set env vars: `DATABASE_URL`
   (Supabase pooled), `SESSION_SECRET`, `BOT_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`.
3. Point `DATABASE_URL` locally at Supabase and run `pnpm db:push && pnpm db:seed`
   once to provision the prod schema + accounts.
4. In Supabase Storage, create a **private** bucket named `receipts`.
5. Deploy. `vercel.json` registers the `/api/cron/auto-confirm` cron (every 15m).
6. Smoke test: `BASE_URL=https://<app> pnpm bot:replay`.

Give the bot developer `../API.md` and the `BOT_API_KEY` value.

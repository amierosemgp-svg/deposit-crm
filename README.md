# Player Deposit CRM

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

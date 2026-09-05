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

**Rebates** (`/rebates`) are paid from a generated list, not on a deposit: the
page snapshots each player's loss (completed deposits − paid withdrawals)
over the latest closed window into `rebate_payouts`, and each row is paid as a
free credit. Window boundaries are the `rebate_cutoffs` setting (daily time,
weekly weekday + time, monthly day + time, business time), edited on the page
by the super admin. An existing database needs
`migrations/2026-09-05-rebate-payouts.sql`.

## Crawl banks (on-demand agent commands)

The agent sweeps the banks on its own cycle. When that is too slow — a player
says they've paid and CS is watching the Deposits page — the **Crawl banks**
button queues a one-off job in `bot_commands` for the agent to pick up.

The CRM never calls into the agent; this is still a pull. CS queues, the agent
polls `GET /api/bot/commands?status=pending`, claims it with
`PATCH /api/bot/commands/:id/status`, and reports counts back in `result` —
which is what the button's tooltip shows ("2 new deposits").

| Status | Means |
|---|---|
| `pending` | queued, no agent has taken it |
| `running` | an agent claimed it (`bot_id` says which) |
| `completed` / `failed` | the agent reported back |
| `expired` | nobody claimed it inside 10 minutes |

**The 10-minute TTL is the point.** A crawl requested while the agent is down
must not fire hours later: by then the scheduled sweep has covered it and nobody
is waiting on it. The sweep in `src/lib/bot-commands.ts` runs lazily on the
CRM's state poll and on every agent poll — no cron needed. A command claimed and
then abandoned for 10 minutes is failed rather than expired: that one is a fault
worth seeing, and leaving it `running` would block the next crawl of the same
target.

Pressing the button twice does not queue two crawls — the second request returns
the open one. Nothing on a command moves money, so a failure reverses nothing.

An existing database needs `migrations/2026-08-21-bot-commands.sql`.

## System log

Three tables hold "what happened", and the **System Log** page (leaders and the
super admin) unions them at read time — each action is written to exactly one
of them, never mirrored:

| Table | Holds | Written by |
|-------|-------|------------|
| `activity_log` | administration: staff, entities, settings, bonuses, bank accounts, kiosks, API keys, sign-ins | `logActivity()` in `src/lib/activity-log.ts` |
| `transactions` | money and credit movement | the deposit/withdrawal/transfer routes |
| `bot_events` | what the agent did | the agent, via `/api/bot/events` |

`logActivity()` never throws — a failed audit write must not fail the action it
records — and edits carry a field-level diff (`changes: [{field, from, to}]`)
so the log answers *what* changed, not just *that* something did. Passwords,
PINs and API keys are recorded as `•••`; bank account numbers are masked to the
last four.

Scope: the super admin sees everything. A leader sees actions touching their own
companies plus anything their own staff did — system-wide rows (settings, API
keys, leader accounts) are the admin's alone. CS agents and viewers get a 403.

Sign-ins are logged including rejected attempts, with the username tried and the
originating IP.

An existing database needs `migrations/2026-08-16b-activity-log.sql`.

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

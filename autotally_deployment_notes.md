# Autotally: deployment notes

Merged to `main` in PR #2 (`autotally`, commit `3a274ef`), with a follow-up commit on `main` that fixes month boundaries and late fixes (see **Changes since PR #2**).

## What it does

A new Vercel cron runs every day at **06:00 Malaysian time**. It reads Pokercity's Google Sheet for the current month and checks yesterday's deposits and withdrawals against the CRM, row by row. The result goes to a Telegram chat:

- rows on the sheet that aren't in the CRM, and CRM entries that aren't on the sheet
- the same entry with a different amount, or under a different member code
- the same deposit with a different bonus (exact to the cent, no rounding), plus the day's bonus total
- deposits the sheet shows as received that the CRM still has at `processing` or another unfinished status
- anything from earlier in the month that's still open
- missing rows keyed in days later, counted once as "keyed in late, now matched"

An item drops off once it's fixed on either side. Nothing is written anywhere: the job reads the sheet and reads the DB.

## Files changed

| File | Change |
|---|---|
| `src/app/api/cron/tally-pokercity/route.ts` | New. The cron route |
| `src/lib/pokercity-tally.ts` | New. One run: finds the month's file (and last month's on the 1st and 2nd), reads it, loads the CRM, builds the report |
| `src/lib/sheet-tally.ts` | New. Parses the sheet, loads CRM rows, matches them, writes the report |
| `src/lib/google-sheets.ts` | New. Service-account sign-in and read-only Sheets/Drive calls, using `jose`, which is already a dependency |
| `vercel.json` | Adds the cron `/api/cron/tally-pokercity` at `0 22 * * *` (22:00 UTC = 06:00 MYT) |
| `.gitignore` | Ignores `mycrm-*.json` (the Google key file). It also includes two `supabase/.temp` / `.branches` lines that were already pending |

There are no new packages, no schema changes and no migrations.

## Before deploying

### 1. Environment variables (Vercel → Settings → Environment Variables, Production)

| Name | Value | Required |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full contents of the service-account key JSON, pasted as is. Ask Mervyn: it's in their local `.env.local`. **Don't commit it.** | Yes |
| `TALLY_TELEGRAM_CHAT_ID` | The Telegram chat or group ID the report goes to | Not yet. Without it the job runs and returns the report but sends nothing |
| `CRON_SECRET` | Probably already set for the existing crons. The new route checks it the same way | Already present? |

The route also uses the existing `DATABASE_URL` and `TELEGRAM_BOT_TOKEN`.

### 2. Google Cloud (project `mycrm-510114`)

- The Google Sheets API and Google Drive API are both enabled. The job uses Drive to find each month's file by name.
- The service account is `sheet-reader@mycrm-510114.iam.gserviceaccount.com`. It has Viewer access only, to the sheets shared with it.

### 3. Telegram

The report is sent by the CRM's existing bot (`TELEGRAM_BOT_TOKEN`). Add the bot to the chat or group that should get the report, then set `TALLY_TELEGRAM_CHAT_ID` to that chat's ID. Group IDs start with `-100…`.

## After deploying: check it

Run it by hand for a past day without sending to Telegram:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<crm-domain>/api/cron/tally-pokercity?date=2026-09-28&send=0"
```

It returns JSON with `ok`, `toCheck` (items for that day), `stillOpen` (older items that still need action) and `text` (the message). As of 1 Oct 2026, `date=2026-09-30` should return `toCheck: 5` and `stillOpen: 1`, all bonus differences. The text should also say "7 keyed in late, now matched". Those 7 are the reconciliation PDF's missing rows, which staff keyed in on 30 Sept. The full message looks like this:

```
Pokercity tally · Wed 30 Sep — ⚠️ 5 to check
Deposits: sheet RM 14,872 (213) · CRM RM 15,132 (219)
Bonus: sheet RM 652 · CRM RM 665.25
Withdrawals: sheet RM 11,259 (30) · CRM RM 11,759 (31)
7 keyed in late, now matched. No action.

Bonus differs (5)
• Dep GA1269 30 22:11 sheet 1, CRM 1.50 #12209
• Dep G5109 25 23:20 sheet 1, CRM 1.25 #12228
• Dep G9612 50 23:29 sheet 2, CRM 2.50 #12232
• Dep GA1108 50 23:39 sheet 2, CRM 2.50 #12234
• Dep GA1330 50 23:46 sheet 2, CRM 2.50 #12236

Still open from earlier: 1
Bonus differs (1)
• 27 Sep Dep G8359 25 19:35 sheet 2, CRM 0 #11626
```

A day with items lists them under a heading per problem, e.g. `On sheet, not in CRM (2)` followed by lines like `• Dep G3911 350 08:27`. CRM entries carry their `#id`.

Query parameters:

| Param | Effect |
|---|---|
| `date=YYYY-MM-DD` | Check that day instead of yesterday |
| `send=0` | Return the report without posting to Telegram |
| `sheet=<spreadsheetId>` | Use this sheet instead of looking it up by name |

After that, the Vercel dashboard's Cron Jobs tab shows the run history and has a "Run" button.

## Monthly upkeep

Each month's sheet is a new file. For the job to find it:

1. The file name must contain **"Poker"**, **"Transaction"**, the **month name** and the **year**, e.g. `Poker City Transaction October 2026`.
2. The file must be a Google Sheet, not an uploaded `.xlsx`.
3. Share it with `sheet-reader@mycrm-510114.iam.gserviceaccount.com` as **Viewer**.

If the file isn't shared, the morning message says it couldn't find the sheet and which email to share it with.

The job expects tabs named `+Deposit` and `-Withdrawal`. Within each tab it finds the header row by its labels (Date, Time, Member Code, Product, Bank, Amount, and Bonus on the deposit tab), so moving rows around above the header is fine. Renaming those headers or tabs isn't.

## How matching works (for when a result looks odd)

- **Scope:** only Pokercity, entity 30. Deposits count if `completed`; withdrawals count if `paid`, using `paid_at` (or `created_at` if that's empty). Failed entries are ignored.
- **Rows left out, as in the original reconciliation script:**
  - sheet rows whose product is Clear Bank, Bank Charge or Expenses
  - deposit rows whose bank is REKEMEN or ID TO ID
  - padding rows with no product or amount
- **Pairing:** each sheet row is paired with the CRM entry for the same member code and amount that's nearest in time, up to 36 hours apart. This handles entries across midnight and batches keyed in late, so those don't raise false items.
- **Bonus:** the sheet's `Bonus` column (the RM figure, not `Bonus %`) is compared with the CRM's `bonus_amount`, exactly, with no rounding. When a member has two deposits of the same amount close together, pairing prefers the CRM entry with the same bonus, so the two don't get crossed. Rows only get a bonus check once they pair up: an entry still stuck or with a wrong amount or member is reported for that first. Since 30 Sept the CRM keeps bonus cents (RM 50 at 5% is 2.50). Until the sheet records cents too, every such bonus shows as "Bonus differs".
- **Near misses:** if nothing matches exactly, the job looks for close entries:
  - same member within 60 minutes but a different amount: reported as "amounts differ"
  - same amount within 10 minutes but a different member: reported as "member code differs"
- **Late fixes:** a row that's still unpaired after that, but has the same member and amount somewhere else in the month, is treated as a missing row keyed in later. The CRM dates a manual entry with the time it was keyed, not the day it happened. It's counted once, the morning after it was keyed, as "keyed in late, now matched", and then counts as resolved. The CRM's day totals stay off by those amounts, which is expected.
- **Month boundary:** CRM entries from the last 2 days of the previous month are loaded only to pair with entries near midnight; they're never reported. When checking the 1st or 2nd, the job also reads the last 2 days of the previous month's sheet for the same reason.
- **Sheet dates:** read as displayed (day/month). The sheet's locale turns "1/9/2026" into a January date that still displays as `1/9/2026`.

## Known limitations

- On the 1st and 2nd, if the previous month's sheet can't be found, the report says so, and an entry just after midnight on the 1st may show as an item.
- A late fix pairs by member and amount alone. If the same member has two missing rows of the same amount, they can pair up the wrong way round. Either way the result is the same: both are resolved.
- Vercel runs crons on UTC. If the Vercel plan is Hobby, daily crons can fire any time within the hour. The existing 5-minute cron suggests the plan is Pro, where timing is exact.

## Changes since PR #2

- **Fixed:** without this fix, every run in October onwards would have reported all CRM entries from the last 2 days of the previous month as "in the CRM, not on the sheet". Findings are now limited to the month being checked.
- **Added:** on the 1st and 2nd, the job reads the end of the previous month's sheet, so rows around midnight pair up.
- **Added:** late fixes are paired and mentioned once, instead of showing twice (once as missing on the real date and once as extra on the day they were keyed).
- **Moved:** the run logic went from the route into `src/lib/pokercity-tally.ts`. The route now only handles auth, parameters and Telegram.
- **Shorter report, at finance's request:**
  - a one-line status in the header
  - day totals as one figure when the sheet and CRM agree
  - items grouped under a heading per problem
  - amounts without "RM" or ".00"
  - bank, product and sheet name dropped
  - late fixes shown as a count only
- **Added:** a bonus check: a day bonus total, and a "Bonus differs" item for each deposit whose bonus differs, exact to the cent. A late fix keyed with the wrong bonus shows as "Bonus differs", not as resolved.

## Rollback

Remove the `tally-pokercity` entry from `vercel.json` and redeploy, or just unset `TALLY_TELEGRAM_CHAT_ID` to stop the messages. Nothing else depends on the new files.

# FlyPay: deployment notes

Branch `feature/flypay`, commit `ad05715`: "Take deposits through FlyPay for leaders who don't bank".

The branch starts from `main`, not `autotally`. The two don't touch the same files and can be merged in either order.

## What it does

A leader joining the system takes deposits through the FlyPay payment gateway instead of a bank account. FlyPay's API has no list of transactions to crawl, so the CRM becomes the merchant and asks FlyPay for each payment itself:

1. CS presses **FlyPay deposit** on the Deposits page, picks the player, amount and payment method (DuitNow QR, Online Banking or Touch 'n Go), and gets a payment link to send the player.
2. The deposit waits under **Awaiting Match** until the player pays.
3. FlyPay calls the CRM back. A paid deposit moves to **Matched**, and CS approves and completes it like any other deposit. Completing it credits the FlyPay account's balance. A failed payment moves the deposit to **Failed**.
4. If a callback never arrives, **Check** on the row asks FlyPay directly. **Reject** cancels a link nobody paid. If the money arrives after a reject, the deposit reopens by itself.

Companies without a FlyPay account see no change: the button only appears once one is set up.

## Files changed

| File | Change |
|---|---|
| `migrations/2026-09-30-payment-gateways.sql` | New. Two tables, `payment_gateways` and `gateway_payments`. Additive; nothing existing is changed |
| `src/db/schema.ts` | The same two tables for Drizzle |
| `src/lib/flypay.ts` | New. FlyPay client: AES-256-CBC encryption and RSA SHA-1 signatures as in the guide, plus SubmitDeposit, GetDepositDetail and CheckBalance |
| `src/lib/gateway-deposits.ts` | New. Applies FlyPay's answer to a deposit. The callback and the Check button both use it |
| `src/app/api/flypay/notify/route.ts` | New. FlyPay's callback. Public, trusted only if FlyPay's signature verifies |
| `src/app/api/payment-gateways/route.ts` | New. List gateways (no secrets); set one up (leaders and admins) |
| `src/app/api/payment-gateways/[id]/deposits/route.ts` | New. Creates the deposit and asks FlyPay for the payment link |
| `src/app/api/deposits/[id]/gateway/route.ts` | New. GET returns the payment link again; POST is the Check button |
| `src/app/api/deposits/[id]/reject/route.ts` | Can now reject a FlyPay deposit that's still waiting for payment |
| `src/app/api/deposits/[id]/reprocess/route.ts` | Refuses to reopen a FlyPay deposit FlyPay never confirmed as paid |
| `src/proxy.ts` | Lets `/api/flypay/notify` and `/payment-done.html` through without a login |
| `public/payment-done.html` | New. The page FlyPay sends the player to after paying |
| `src/components/gateway-deposit-dialog.tsx` | New. The FlyPay deposit dialog |
| `src/components/payment-gateway-modal.tsx` | New. FlyPay setup on Bank Accounts |
| `src/app/(crm)/deposits/page.tsx` | FlyPay deposit button; Link / Check / Reject on waiting rows |
| `src/app/(crm)/bank-accounts/page.tsx` | FlyPay button and label on the FlyPay account's row |
| `src/lib/store.ts`, `src/lib/types.ts` | Client actions and types for the above |
| `README.md` | New "FlyPay" section |

There are no new packages. The crypto uses Node's built-in `crypto`.

## Before deploying

### 1. Run the migration first

Run `migrations/2026-09-30-payment-gateways.sql` on the production database **before** the new code goes live. The reject and reprocess routes now read `gateway_payments`, so without the table, rejecting or reprocessing **any** deposit fails with a server error, not just FlyPay ones.

The migration only creates two tables. Afterwards, check that both exist:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('payment_gateways', 'gateway_payments');
```

### 2. A fixed outgoing IP for FlyPay (blocker)

FlyPay only accepts API calls from server IPs it has whitelisted (guide section "Overview", item 1). Vercel functions don't have a fixed outgoing IP by default, so until this is sorted **every call to FlyPay is refused**. The CRM then shows the refusal when CS tries to make a link.

Options:

- **Vercel's static outbound IP option.** Check that the team's plan includes it, turn it on for this project, and give FlyPay the IP(s) it shows.
- **A fixed-IP forwarding proxy** in front of `https://mapi.flypay.site`. Point `FLYPAY_API_BASE` at it (see below). The proxy must pass paths and bodies through unchanged.

This only affects calls **from** the CRM to FlyPay. FlyPay's callbacks **to** the CRM (from `43.208.13.198`) need no firewall change.

### 3. Environment variables (optional)

| Name | Value | Required |
|---|---|---|
| `APP_URL` | The CRM's public address, e.g. `https://crm.example.com`. It's used in the callback and return URLs sent to FlyPay. Without it, the address of the request is used, which is correct on Vercel | No |
| `FLYPAY_API_BASE` | Only if calls go through a proxy (step 2). Default: `https://mapi.flypay.site` | No |

The existing `DATABASE_URL` is the only other one used.

### 4. From the leader and FlyPay

Get from FlyPay, for the leader's merchant account:

- the **merchant code**
- the **AES key**
- **FlyPay's RSA public key**

In return, FlyPay needs **our** public key, which the CRM generates during setup (below). FlyPay's tech team uploads it to their back office.

## After deploying: set it up

1. Sign in as the leader or a super admin and open **Bank Accounts**.
2. Add a bank account for the leader's casino (the company its players belong to). For the bank, choose "Other" and type `FlyPay`, and set the role to Deposit. Put the merchant code in the account number.
3. Press the card button on that row. Enter the merchant code, the AES key and FlyPay's public key, then press **Connect**.
4. The CRM makes our key pair. Reopen the same dialog, copy **Our public key** and send it to FlyPay's tech team.
5. Wait for FlyPay to confirm that the key is uploaded and the outgoing IP is whitelisted.

The key pair is only made on first setup. Tick "Issue a new key pair" later only if the private key has leaked. FlyPay refuses every call until they've uploaded the new public key.

## After deploying: check it

**The callback route is reachable without a login.** A request with an empty body should get `400 bad request`, not a 401 or a redirect to the login page:

```bash
curl -i -X POST -H "Content-Type: application/json" -d '{}' \
  "https://<crm-domain>/api/flypay/notify"
```

**One real deposit, end to end.** Use a small amount and a test player:

1. **Deposits → FlyPay deposit.** A link should come back. If it doesn't, the error message says why: a refusal by FlyPay (with its `PMT…` code), or no answer at all (usually the IP whitelist).
2. Open the link and pay it.
3. Within a minute the row should move from Awaiting Match to **Matched**. If it doesn't, press **Check** on the row.
4. Approve and complete it as usual, then confirm the FlyPay account's balance on Bank Accounts went up by the deposit.

To see what FlyPay reported:

```sql
SELECT merchant_txn_id, provider_txn_id, status, provider_status_id,
       amount, net_amount, error, last_response, updated_at
FROM gateway_payments ORDER BY payment_id DESC LIMIT 5;
```

`status` is `submitted` (waiting), `success`, `failed`, or `error` (FlyPay refused the request or had no record of it).

### Confirm these on the first live payment

The guide is inconsistent in a few places, so the code follows its worked examples. Watch these on the first payment:

- **Amount format.** The amount is sent as the text `"100.00"`, as in the guide's encryption example. If FlyPay rejects it with PMT10005 (Invalid Transaction Amount), it needs to be sent as a number instead.
- **Client IP.** FlyPay asks for the paying player's IP. The player never touches the CRM, so the IP of the CS staff member who made the link is sent.
- **Amount in the callback.** The callback's `Amount` is taken as the deposit amount. If it differs from what CS typed (FlyPay can add a few cents to make each amount unique), the deposit is corrected and a percentage bonus is recalculated. The ledger entry keeps both figures.

## How the security works (for review)

- **Callback:** the body is decrypted with the merchant's AES key, and its signature must verify against FlyPay's public key for that merchant. The signed body must name the same payment and merchant code as the request, so a genuine callback can't be replayed against another payment. Anything that fails these checks gets a non-200, and FlyPay retries.
- **Idempotent:** FlyPay repeats a callback until it gets `success`. A deposit already past the step doesn't move again, and a deposit CS rejected after it was paid isn't reopened by a retry.
- **Secrets:** the AES key and our private key are stored in the database in plain text, as bank login passwords already are. The API never returns them to the browser.
- **Who can do what:** only leaders and super admins can set up a gateway, for accounts in their own scope. CS can make links for players in their own company, using that company's gateway only.

## Known limitations

- **FlyPay's fee isn't booked.** Completing a deposit credits the FlyPay account with the full amount, but FlyPay keeps a fee (`net_amount` in `gateway_payments`). The CRM's FlyPay balance will run ahead of FlyPay's real balance by the fees until that's decided (book the fee as an expense, or reconcile against FlyPay's CheckBalance, which the client already supports).
- **Deposits only.** Paying withdrawals out through FlyPay isn't built.
- **No automatic retry.** If a callback is lost, the deposit waits until someone presses Check. There's no cron for it.
- **Deposit time is when it was paid.** The deposit's date is reset to the moment FlyPay confirms payment, not when the link was made. The link time stays in `created_at`.
- **Committing on this branch:** `main`'s `.gitignore` doesn't have the `mycrm-*.json` line from `autotally`, so the Google key file appears untracked here. Don't use `git add -A` on this branch until `autotally` is merged.

## Rollback

- **Code:** redeploy the previous build. Nothing outside the files above depends on the new code.
- **Data:** the two tables can stay; nothing reads them once the code is gone. FlyPay deposits already made remain as ordinary rows in `deposits`.
- **To drop the tables completely**, only after the code is rolled back:

```sql
DROP TABLE gateway_payments;
DROP TABLE payment_gateways;
```

- **To turn FlyPay off without a deploy**, set the FlyPay bank account to Inactive on Bank Accounts. The button stays, but making a new link is refused with "This payment gateway is switched off". Waiting deposits can still be checked, and callbacks are still accepted.

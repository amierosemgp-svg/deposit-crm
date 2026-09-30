-- FlyPay: deposits a player pays through a payment gateway instead of a bank.
--
-- A leader joining the system takes deposits through FlyPay, not a bank account.
-- FlyPay's API has nothing to crawl — there is no list of transactions, only a
-- lookup by an id the merchant chose — so the CRM becomes the merchant: CS asks
-- FlyPay for a payment, the player pays on FlyPay's cashier page, and FlyPay
-- calls the CRM back with the result.
--
-- `payment_gateways` holds the merchant keys, hung off the bank account that
-- represents the FlyPay balance (bank_name 'FlyPay'). `gateway_payments` is one
-- row per payment asked for, tied to the deposit it pays.
--
-- Additive: two tables, nothing existing is touched.

CREATE TABLE payment_gateways (
  gateway_id           serial PRIMARY KEY,
  account_id           integer NOT NULL UNIQUE REFERENCES bank_accounts(account_id),
  provider             varchar(20) NOT NULL DEFAULT 'flypay',
  merchant_code        varchar(60) NOT NULL,
  currency             varchar(3) NOT NULL DEFAULT 'MYR',
  aes_key              text NOT NULL,
  provider_public_key  text NOT NULL,
  merchant_private_key text NOT NULL,
  merchant_public_key  text NOT NULL,
  status               active_status NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gateway_payments (
  payment_id         serial PRIMARY KEY,
  gateway_id         integer NOT NULL REFERENCES payment_gateways(gateway_id),
  deposit_id         integer NOT NULL UNIQUE REFERENCES deposits(deposit_id),
  merchant_txn_id    varchar(60) NOT NULL UNIQUE,
  provider_txn_id    varchar(60),
  payment_method     varchar(10) NOT NULL,
  amount             numeric(12,2) NOT NULL,
  net_amount         numeric(12,2),
  status             varchar(12) NOT NULL DEFAULT 'submitted',
  provider_status_id integer,
  cashier_url        text,
  error              text,
  last_response      jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

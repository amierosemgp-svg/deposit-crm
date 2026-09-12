-- Two-factor sign-in, device binding and per-user IP allowlists.
--
-- Three checks are added between the password and the session cookie. All
-- three are inert on arrival — this file changes no behaviour on its own:
--
--   1. Telegram 2FA. Off per user until they enrol a chat from Settings.
--   2. Device binding. Every browser that signs in is recorded from now on,
--      but a device is only *refused* once an admin turns the policy to
--      "enforce" (settings key `device_policy`, absent = off). Recording
--      first, enforcing later, is deliberate: switching it on before the
--      team's real machines are on the list would lock out the whole desk.
--   3. IP allowlist. Per user, empty by default = sign in from anywhere.
--
-- On "MAC address": a web page cannot read one — the browser does not expose
-- it at any privilege level — so `user_devices.fingerprint` is a random id
-- minted on first sign-in and kept in a signed, long-lived cookie. It
-- identifies a browser profile, not hardware. A cleared cookie or a second
-- browser reads as a new device and comes back round for approval, which is
-- the behaviour that was actually wanted.

-- Everything here logs through activity_log's existing "auth" and "user"
-- categories, so no enum on the money side changes.

DO $$ BEGIN
  CREATE TYPE device_status AS ENUM ('pending', 'approved', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE auth_challenge_purpose AS ENUM ('login', 'telegram_link');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- users: the second factor and the IP rule ----------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS telegram_chat_id    varchar(40),
  ADD COLUMN IF NOT EXISTS telegram_username   varchar(80),
  ADD COLUMN IF NOT EXISTS two_factor_enabled  boolean NOT NULL DEFAULT false,
  -- IPs / CIDR ranges this user may sign in from. '[]' = anywhere.
  ADD COLUMN IF NOT EXISTS ip_allowlist        jsonb   NOT NULL DEFAULT '[]'::jsonb;

-- One Telegram account drives one CRM login: a shared chat would mean two
-- people receiving each other's codes.
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_chat_id_key
  ON users (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- ---------- devices ----------

CREATE TABLE IF NOT EXISTS user_devices (
  device_id            serial PRIMARY KEY,
  user_id              integer NOT NULL REFERENCES users(user_id),
  -- The opaque id carried in the device cookie. Not a MAC address; see above.
  fingerprint          varchar(64) NOT NULL,
  -- What the user calls it ("Front desk PC"); defaults to the browser/OS.
  label                varchar(80),
  user_agent           varchar(300),
  last_ip              varchar(60),
  status               device_status NOT NULL DEFAULT 'pending',
  approved_by_user_id  integer REFERENCES users(user_id),
  approved_at          timestamptz,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_devices_user_fingerprint UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS user_devices_user_idx ON user_devices (user_id);

-- ---------- one-time codes in flight ----------

CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge_id        serial PRIMARY KEY,
  user_id             integer NOT NULL REFERENCES users(user_id),
  purpose             auth_challenge_purpose NOT NULL,
  -- sha256 of the code, never the code — a leaked table shouldn't hand over
  -- live second factors. Null on an enrolment, whose secret is link_token.
  code_hash           varchar(64),
  link_token          varchar(64),
  attempts            integer NOT NULL DEFAULT 0,
  -- Which browser asked, so the session lands on the device that logged in.
  device_fingerprint  varchar(64),
  ip                  varchar(60),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_challenges_user_idx ON auth_challenges (user_id, purpose);
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_link_token_key
  ON auth_challenges (link_token)
  WHERE link_token IS NOT NULL;

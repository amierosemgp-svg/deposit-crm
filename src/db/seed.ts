/* Seed the deposit_crm database with the minimum production skeleton:
 *   - entity hierarchy: MPG → Leader One → Company One → CS desk
 *   - one login per role (super admin, leader, CS agent, viewer)
 *   - bot API key + system settings
 * No players, transactions, or balances — all real data enters through
 * the app UI or the bot API.
 *
 * Run: pnpm db:seed   (wipes all rows, keeps schema)
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { db } from "./index";
import { apiKeys, entities, settings, users } from "./schema";

const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "Mpg@2026";

async function main() {
  console.log("Clearing existing data…");
  await db.execute(sql`
    TRUNCATE TABLE
      transactions, provider_bo_adjustments, provider_bo_accounts,
      game_transfers, game_credits, withdrawals, deposits, bank_transfers,
      bank_accounts, players, users, entities, api_keys, settings
    RESTART IDENTITY CASCADE
  `);

  console.log("Seeding entity skeleton…");
  const [mpg] = await db
    .insert(entities)
    .values({ entity_type: "main_company", name: "MPG" })
    .returning();
  const [leader] = await db
    .insert(entities)
    .values({
      parent_entity_id: mpg.entity_id,
      entity_type: "leader",
      name: "Leader One",
    })
    .returning();
  const [company] = await db
    .insert(entities)
    .values({
      parent_entity_id: leader.entity_id,
      entity_type: "company",
      name: "Company One",
    })
    .returning();
  const [csDesk] = await db
    .insert(entities)
    .values({
      parent_entity_id: company.entity_id,
      entity_type: "cs",
      name: "CS Desk 1",
    })
    .returning();

  console.log("Seeding one account per role…");
  const password_hash = await bcrypt.hash(SEED_PASSWORD, 10);
  await db.insert(users).values([
    {
      username: "admin",
      email: "admin@mpg.local",
      full_name: "MPG Super Admin",
      password_hash,
      role: "super_admin",
      entity_id: mpg.entity_id,
    },
    {
      username: "leader1",
      email: "leader1@mpg.local",
      full_name: "Leader One",
      password_hash,
      role: "company_leader",
      entity_id: leader.entity_id,
    },
    {
      username: "cs1",
      email: "cs1@mpg.local",
      full_name: "CS Agent One",
      password_hash,
      role: "cs_agent",
      entity_id: csDesk.entity_id,
    },
    {
      username: "viewer",
      email: "viewer@mpg.local",
      full_name: "Read-only Viewer",
      password_hash,
      role: "viewer",
      entity_id: mpg.entity_id,
    },
  ]);

  const botKey = process.env.BOT_API_KEY;
  if (!botKey) throw new Error("BOT_API_KEY missing from env");
  await db.insert(apiKeys).values({
    key_hash: createHash("sha256").update(botKey).digest("hex"),
    label: "OpenClaw deposit bot",
  });

  await db.insert(settings).values([
    { key: "transfer_auto_confirm_hours", value: 24 },
    { key: "bonus_options", value: [0, 5, 10, 20, 30, 50, 100] },
    { key: "games", value: ["Mega888", "Pussy888", "918Kiss", "XE88"] },
    { key: "banks", value: ["Maybank", "CIMB", "Hong Leong", "Public Bank", "RHB", "BSN", "Ambank"] },
  ]);

  console.log("✔ Seed complete.");
  console.log("  Accounts (password from SEED_PASSWORD env, default Mpg@2026):");
  console.log("    admin    — super_admin  (MPG)");
  console.log("    leader1  — company_leader (Leader One)");
  console.log("    cs1      — cs_agent (Company One / CS Desk 1)");
  console.log("    viewer   — viewer (read-only)");
  console.log(`  Bot API key: ${botKey.slice(0, 12)}… (full value in .env.local)`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

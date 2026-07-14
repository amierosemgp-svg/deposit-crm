/* Replay the OpenClaw bot's recorded queue against the CRM bot API.
 * Simulates exactly what the real bot will send.
 *
 * Usage:
 *   pnpm bot:replay                          # against http://localhost:3060
 *   BASE_URL=https://your.app pnpm bot:replay
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3060";
const API_KEY = process.env.BOT_API_KEY;
if (!API_KEY) throw new Error("BOT_API_KEY missing from env");

const queuePath = resolve(__dirname, "../../sources/transaction_queue.json");
const lines = readFileSync(queuePath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

async function main() {
  console.log(`Replaying ${lines.length} bot queue items → ${BASE_URL}\n`);
  for (const item of lines) {
    const res = await fetch(`${BASE_URL}/api/bot/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY! },
      body: JSON.stringify(item),
    });
    const body = await res.json();
    const tag = body.duplicate ? "DUPLICATE" : res.status;
    console.log(
      `[${tag}] ${item.id}`,
      body.transaction
        ? `→ crm_id=${body.transaction.id} status=${body.transaction.status} player=${body.transaction.player_username ?? "unmatched"}`
        : JSON.stringify(body),
    );
  }

  const pending = await fetch(
    `${BASE_URL}/api/bot/transactions?status=pending`,
    { headers: { "X-API-Key": API_KEY! } },
  ).then((r) => r.json());
  console.log(`\nPending transactions in CRM: ${pending.count}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

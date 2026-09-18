/**
 * Turn a loaded tree into a demo tenant, so the real one can be built beside it.
 *
 *   tsx scripts/launch/make-demo.ts --db "<session pooler url>" \
 *       [--from "ALL Group"] [--to "Demo Group"] [--prefix demo_]
 *
 * Renames the main company and prefixes every login under it, keeping the
 * house rule that a password is its username + "888" — so demo_ttt777 signs in
 * with demo_ttt777888. Members, deposits and balances are untouched: it is the
 * same data, now unmistakably labelled as practice.
 *
 * Only the named tree is touched, and the old name is freed, so seed-tree.ts
 * can then build the real "ALL Group" alongside it with --allow-existing.
 */
import bcrypt from "bcryptjs";
import { Client } from "pg";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

async function main() {
  const db = arg("db") ?? process.env.DATABASE_URL;
  const from = arg("from", "ALL Group")!;
  const to = arg("to", "Demo Group")!;
  const prefix = arg("prefix", "demo_")!;
  if (!db) {
    console.error('usage: make-demo.ts --db <url> [--from "ALL Group"] [--to "Demo Group"]');
    process.exit(2);
  }

  const client = new Client({ connectionString: db });
  await client.connect();
  try {
    const { rows: root } = await client.query(
      "SELECT entity_id FROM entities WHERE name = $1 AND entity_type = 'main_company'",
      [from],
    );
    if (!root.length) {
      console.error(`No main company named "${from}".`);
      process.exit(1);
    }
    const rootId = root[0].entity_id;

    // Everything under that root, however deep.
    const { rows: users } = await client.query(
      `WITH RECURSIVE tree AS (
         SELECT entity_id FROM entities WHERE entity_id = $1
         UNION ALL
         SELECT e.entity_id FROM entities e JOIN tree t ON e.parent_entity_id = t.entity_id)
       SELECT u.user_id, u.username, u.entity_id FROM users u
        WHERE u.entity_id IN (SELECT entity_id FROM tree)
        ORDER BY u.user_id`,
      [rootId],
    );

    const already = users.filter((u) => u.username.startsWith(prefix));
    if (already.length === users.length && users.length > 0) {
      console.error(`Already a demo tenant — every login starts with "${prefix}".`);
      process.exit(1);
    }

    await client.query("BEGIN");
    await client.query("UPDATE entities SET name = $1 WHERE entity_id = $2", [to, rootId]);

    for (const u of users) {
      const username = `${prefix}${u.username}`;
      await client.query(
        `UPDATE users
            SET username = $1,
                email = $2,
                password_hash = $3
          WHERE user_id = $4`,
        [
          username,
          // Derived like every other login here: no real address, scoped by
          // entity so the unique index cannot collide with the real tree's.
          `${username}@e${u.entity_id}.local`,
          await bcrypt.hash(`${username}888`, 10),
          u.user_id,
        ],
      );
    }
    await client.query("COMMIT");

    console.log(`"${from}" → "${to}"`);
    console.log(`${users.length} logins renamed with "${prefix}", passwords re-set to username + 888`);
    console.log(`  e.g. ${prefix}ttt777 / ${prefix}ttt777888`);
    console.log(`\n"${from}" is free again — seed the real tree with --allow-existing.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

/**
 * Create the first main company and its super admin, on a database that has
 * the schema but nothing in it.
 *
 * Every launch needs this and only this to become usable: the tree's root and
 * one login that can build the rest from the UI. Leaders, companies and CS
 * desks come after, either by hand or from the import script.
 *
 *   tsx scripts/launch/seed-admin.ts --db "postgres://…" \
 *       --company "Pokercity Group" --username pc_admin --password '…'
 *
 * Refuses to run against a database that already has users, so it can't
 * quietly add a second admin to a live system.
 */
import bcrypt from "bcryptjs";
import { Client } from "pg";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const db = arg("db") ?? process.env.DATABASE_URL;
  const company = arg("company");
  const username = arg("username");
  const password = arg("password");
  if (!db || !company || !username || !password) {
    console.error(
      "usage: seed-admin.ts --db <url> --company <name> --username <name> --password <pw>",
    );
    process.exit(2);
  }
  if (password.length < 8) {
    // The launch follows a suspected compromise; a short password here is the
    // one that ends up in production forever.
    console.error("Password must be at least 8 characters.");
    process.exit(2);
  }

  const client = new Client({ connectionString: db });
  await client.connect();
  try {
    const { rows: existing } = await client.query("SELECT count(*)::int AS n FROM users");
    if (existing[0].n > 0) {
      console.error(`Refusing: this database already has ${existing[0].n} user(s).`);
      process.exit(1);
    }

    await client.query("BEGIN");
    const { rows: ent } = await client.query(
      `INSERT INTO entities (name, entity_type, status)
       VALUES ($1, 'main_company', 'active') RETURNING entity_id`,
      [company],
    );
    const entityId = ent[0].entity_id;
    // email is NOT NULL and unique. A main-company login has no real address —
    // nobody emails them — so it is derived exactly as POST /api/users does,
    // scoped by entity so two organisations can both have an "admin".
    const user = username.toLowerCase();
    const { rows: usr } = await client.query(
      `INSERT INTO users (username, email, password_hash, role, entity_id, status, full_name)
       VALUES ($1, $2, $3, 'super_admin', $4, 'active', $5) RETURNING user_id`,
      [
        user,
        `${user}@e${entityId}.local`,
        await bcrypt.hash(password, 10),
        entityId,
        `${company} Admin`,
      ],
    );
    await client.query("COMMIT");

    console.log(`main company  #${entityId}  ${company}`);
    console.log(`super admin   #${usr[0].user_id}  ${username.toLowerCase()}`);
    console.log("\nSign in, then build leaders and companies from the Hierarchy page.");
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

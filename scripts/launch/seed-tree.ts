/**
 * Build the ALL Group tree on an empty database: the main company, its super
 * admins, every leader from the leaders sheet, and the Pokercity company with
 * its CS desk.
 *
 *   tsx scripts/launch/seed-tree.ts --db "postgres://…" \
 *       --leaders "/path/Leaders .xlsx" [--dry-run]
 *
 * Naming, from the operator's rules:
 *   display   the name title-cased, the club shortname (last word) uppercased
 *             — "herng jun KK" → "Herng Jun KK", "Ah keong 918k" → "Ah Keong 918K"
 *   username  name without spaces, an underscore, then the club, all lowercase
 *             — "Apple Lee sa" → "applelee_sa". Three Pokercity leaders were
 *             given their own, and keep them.
 *   password  username + "888", which clears the app's 8-character minimum
 *             for every name in the sheet.
 *
 * Refuses to touch a database that already holds entities, so re-running it
 * against a live system can't fork the tree.
 */
import { execFileSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { Client } from "pg";

const MAIN_COMPANY = "ALL Group";
/**
 * Club shortname → the company's name. A club is the company that owns
 * casinos; its people are logins on it, not entities of their own. Only AB's
 * full name is known so far, so the rest carry their shortname until someone
 * renames them in the UI.
 */
const COMPANY_NAMES: Record<string, string> = { ab: "Abdullah Club" };
const SUPER_ADMINS = ["jianlun", "tiang", "wesly"];
const COMPANY = { club: "ab", name: "Pokercity" };
/** Pokercity's leaders keep the logins they were issued. */
const GIVEN_USERNAMES: Record<string, string> = {
  "tiong ab": "ttt777",
  "kc ab": "kc7778",
  "eddie ab": "eddy0726",
};
/** The tree hangs the company off this one; the others are joint leaders. */
const PRIMARY_LEADER = "tiong ab";
const CS_USERNAMES = ["pkcs001", "pkcs002", "pkcs003"];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

function readLeaders(xlsx: string): string[] {
  // openpyxl rather than a JS xlsx dependency: the importer already relies on
  // it, and this runs once.
  const out = execFileSync("python3", [
    "-c",
    `import openpyxl,sys,json
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
ws = wb[wb.sheetnames[0]]
print(json.dumps([str(r[0]).strip() for r in ws.iter_rows(values_only=True) if r[0] and str(r[0]).strip()]))`,
    xlsx,
  ]);
  return JSON.parse(out.toString());
}

const parts = (raw: string) => {
  const w = raw.split(/\s+/);
  return { name: w.slice(0, -1).join(" "), club: w[w.length - 1] };
};

const displayName = (raw: string): string => {
  const { name, club } = parts(raw);
  const titled = name
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return `${titled} ${club.toUpperCase()}`;
};

const usernameFor = (raw: string): string => {
  const given = GIVEN_USERNAMES[raw.toLowerCase()];
  if (given) return given;
  const { name, club } = parts(raw);
  return `${name.toLowerCase().replace(/[^a-z0-9]/g, "")}_${club.toLowerCase()}`;
};

const password = (username: string) => `${username}888`;

async function main() {
  const db = arg("db") ?? process.env.DATABASE_URL;
  const xlsx = arg("leaders");
  const dryRun = process.argv.includes("--dry-run");
  if (!db || !xlsx) {
    console.error('usage: seed-tree.ts --db <url> --leaders <xlsx> [--dry-run]');
    process.exit(2);
  }

  const raw = readLeaders(xlsx);
  const leaders = raw.map((r) => ({
    raw: r,
    club: parts(r).club.toLowerCase(),
    display: displayName(r),
    username: usernameFor(r),
  }));

  const dupes = leaders
    .map((l) => l.username)
    .filter((u, i, all) => all.indexOf(u) !== i);
  if (dupes.length) {
    console.error(`Duplicate usernames: ${[...new Set(dupes)].join(", ")}`);
    process.exit(1);
  }
  const tooShort = leaders.filter((l) => password(l.username).length < 8);
  if (tooShort.length) {
    console.error(`Passwords under 8 characters: ${tooShort.map((l) => l.username).join(", ")}`);
    process.exit(1);
  }

  const pokercity = leaders.filter((l) => l.club === COMPANY.club);
  const primary = leaders.find((l) => l.raw.toLowerCase() === PRIMARY_LEADER);
  if (!primary) {
    console.error(`Primary leader "${PRIMARY_LEADER}" is not in the sheet`);
    process.exit(1);
  }

  console.log(`main company   ${MAIN_COMPANY}`);
  console.log(`super admins   ${SUPER_ADMINS.join(", ")}`);
  const clubs = [...new Set(leaders.map((l) => l.club))];
  console.log(`companies      ${clubs.length} clubs — ${clubs.map((c) => COMPANY_NAMES[c] ?? c.toUpperCase()).join(", ")}`);
  console.log(`leader logins  ${leaders.length}`);
  console.log(`casino         ${COMPANY.name} under ${COMPANY_NAMES[COMPANY.club] ?? COMPANY.club.toUpperCase()} — partners ${pokercity.map((l) => l.display).join(", ")}`);
  console.log(`  primary      ${primary.display} (${primary.username})`);
  console.log(`cs desk        ${CS_USERNAMES.join(", ")}`);
  if (dryRun) {
    console.log("\n--dry-run: nothing written.\n");
    for (const l of leaders) {
      console.log(`  ${l.raw.padEnd(20)} → ${l.display.padEnd(20)} ${l.username.padEnd(16)} ${password(l.username)}`);
    }
    return;
  }

  const client = new Client({ connectionString: db });
  await client.connect();
  try {
    /**
     * An empty database is the launch case. --allow-existing is for a local
     * copy that already holds other operators: the tree is multi-tenant, so
     * ALL Group can sit beside them, and a super admin sees only their own
     * root. What is never allowed is a second ALL Group, which would split the
     * clubs across two trees.
     */
    const allowExisting = process.argv.includes("--allow-existing");
    const { rows: dup } = await client.query(
      "SELECT count(*)::int AS n FROM entities WHERE name = $1 AND entity_type = 'main_company'",
      [MAIN_COMPANY],
    );
    if (dup[0].n > 0) {
      console.error(`\nRefusing: "${MAIN_COMPANY}" already exists.`);
      process.exit(1);
    }
    const { rows: has } = await client.query("SELECT count(*)::int AS n FROM entities");
    if (has[0].n > 0 && !allowExisting) {
      console.error(
        `\nRefusing: this database already has ${has[0].n} entities. ` +
          `Pass --allow-existing to add ${MAIN_COMPANY} alongside them.`,
      );
      process.exit(1);
    }

    await client.query("BEGIN");

    const entity = async (name: string, type: string, parent: number | null) => {
      const { rows } = await client.query(
        `INSERT INTO entities (name, entity_type, parent_entity_id, status)
         VALUES ($1, $2::entity_type, $3, 'active') RETURNING entity_id`,
        [name, type, parent],
      );
      return rows[0].entity_id as number;
    };

    const user = async (
      username: string,
      role: string,
      entityId: number,
      fullName: string,
    ) => {
      await client.query(
        `INSERT INTO users (username, email, password_hash, role, entity_id, status, full_name)
         VALUES ($1, $2, $3, $4::user_role, $5, 'active', $6)`,
        [
          username,
          // No real addresses: derived and scoped by entity, exactly as
          // POST /api/users does when the main company leaves them out.
          `${username}@e${entityId}.local`,
          await bcrypt.hash(password(username), 10),
          role,
          entityId,
          fullName,
        ],
      );
    };

    const mainId = await entity(MAIN_COMPANY, "main_company", null);
    for (const admin of SUPER_ADMINS) {
      await user(admin, "super_admin", mainId, admin.charAt(0).toUpperCase() + admin.slice(1));
    }

    /**
     * One entity per club, not per person.
     *
     * "tiong ab", "kc ab" and "eddie ab" are three partners in one company —
     * AB — so they become three logins on a single entity. Leader scope reads
     * company_leaders by the signed-in user's entity, so all three then see
     * every casino under AB without anything else being wired up.
     */
    const clubEntity = new Map<string, number>();
    for (const club of [...new Set(leaders.map((l) => l.club))]) {
      const name = COMPANY_NAMES[club] ?? club.toUpperCase();
      clubEntity.set(club, await entity(name, "leader", mainId));
    }
    for (const l of leaders) {
      await user(l.username, "company_leader", clubEntity.get(l.club)!, l.display);
    }

    const primaryId = clubEntity.get(parts(PRIMARY_LEADER).club.toLowerCase())!;
    const companyId = await entity(COMPANY.name, "company", primaryId);
    // One row: the casino belongs to the company, and every partner logged in
    // on that company inherits it. A row per partner would be the old shape,
    // where each person was an entity.
    await client.query(
      `INSERT INTO company_leaders (company_entity_id, leader_entity_id, is_primary, note)
       VALUES ($1, $2, true, $3)`,
      [companyId, primaryId, "Seeded at launch"],
    );

    const csId = await entity(`${COMPANY.name} CS`, "cs", companyId);
    for (const cs of CS_USERNAMES) {
      await user(cs, "cs_agent", csId, `${COMPANY.name} ${cs.toUpperCase()}`);
    }

    await client.query("COMMIT");
    console.log(`\nWritten. main #${mainId} · ${COMPANY.name} #${companyId} · CS desk #${csId}`);
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

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
  console.log(`leaders        ${leaders.length} across ${new Set(leaders.map((l) => l.club)).size} clubs`);
  console.log(`company        ${COMPANY.name} — ${pokercity.map((l) => l.display).join(", ")}`);
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
    const { rows: has } = await client.query("SELECT count(*)::int AS n FROM entities");
    if (has[0].n > 0) {
      console.error(`\nRefusing: this database already has ${has[0].n} entities.`);
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

    const leaderEntity = new Map<string, number>();
    for (const l of leaders) {
      const id = await entity(l.display, "leader", mainId);
      leaderEntity.set(l.raw.toLowerCase(), id);
      await user(l.username, "company_leader", id, l.display);
    }

    const primaryId = leaderEntity.get(PRIMARY_LEADER)!;
    const companyId = await entity(COMPANY.name, "company", primaryId);
    for (const l of pokercity) {
      await client.query(
        `INSERT INTO company_leaders (company_entity_id, leader_entity_id, is_primary, note)
         VALUES ($1, $2, $3, $4)`,
        [
          companyId,
          leaderEntity.get(l.raw.toLowerCase()),
          l.raw.toLowerCase() === PRIMARY_LEADER,
          "Seeded at launch",
        ],
      );
    }

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

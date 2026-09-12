import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  // Supabase's transaction pooler (port 6543) hands node-postgres an EMPTY
  // search_path, so every unqualified table (`from "settings"`) fails with
  // "relation does not exist". Pin it at connect time via a startup option
  // (survives the pooler; a per-session `SET` would be reset between txns).
  options: "-c search_path=public,extensions",
});

export const db = drizzle(pool, { schema });
export * as tables from "./schema";

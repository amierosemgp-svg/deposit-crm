import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { people } from "@/db/schema";

type Txn = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Resolve a person by phone number, creating one if new.
 *
 * One phone = one person for the whole database. A blank phone can't identify
 * anyone, so it always creates a fresh person flagged for review — never merged
 * with another blank. Returns the person row and whether it already existed.
 */
export async function findOrCreatePerson(
  txn: Txn,
  input: {
    contact_number?: string | null;
    full_name: string;
    telegram_username?: string | null;
    wechat_id?: string | null;
  },
): Promise<{ person: typeof people.$inferSelect; existed: boolean }> {
  const phone = input.contact_number?.trim() || null;

  if (phone) {
    const [existing] = await txn
      .select()
      .from(people)
      .where(sql`lower(${people.contact_number}) = lower(${phone})`);
    if (existing) return { person: existing, existed: true };
  }

  const [created] = await txn
    .insert(people)
    .values({
      contact_number: phone,
      full_name: input.full_name.trim(),
      telegram_username: input.telegram_username ?? null,
      wechat_id: input.wechat_id ?? null,
      // A person with no phone can't be identified later — mark it for review.
      needs_review: !phone,
    })
    .returning();
  return { person: created, existed: false };
}

/** Look up a person by id. */
export async function getPerson(txn: Txn, personId: number) {
  const [row] = await txn.select().from(people).where(eq(people.person_id, personId));
  return row ?? null;
}

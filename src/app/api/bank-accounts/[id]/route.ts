import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bankAccounts } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { companyOfEntity, describeChanges, diffFields, logActivity } from "@/lib/activity-log";

const patchSchema = z.object({
  role: z.enum(["deposit", "withdrawal"]).optional(),
  bank_name: z.string().min(1).optional(),
  account_number: z.string().min(4).optional(),
  account_holder: z.string().min(1).optional(),
  label: z.string().nullable().optional(),
  login_company_id: z.string().max(80).nullable().optional(),
  login_id: z.string().nullable().optional(),
  login_password: z.string().nullable().optional(),
  login_pin: z.string().nullable().optional(),
  device_id: z.string().max(120).nullable().optional(),
  current_balance: z.number().min(0).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

async function loadScoped(user: Awaited<ReturnType<typeof requireWriteUser>>, id: number) {
  const [row] = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.account_id, id));
  if (!row) throw new AuthError(404, "Account not found");
  if (user.role === "cs_agent") {
    throw new AuthError(403, "Only leaders and admins manage bank accounts");
  }
  if (user.ownedEntityIds !== null && !user.ownedEntityIds.includes(row.entity_id)) {
    throw new AuthError(403, "Account is outside your scope");
  }
  return row;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const before = await loadScoped(user, Number(id));

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");

    const [updated] = await db
      .update(bankAccounts)
      .set(parsed.data)
      .where(eq(bankAccounts.account_id, Number(id)))
      .returning();

    const label = `${updated.bank_name} ••••${updated.account_number.slice(-4)}`;
    const changes = diffFields(before, parsed.data);
    if (changes.length) {
      await logActivity({
        category: "bank_account",
        action:
          parsed.data.status && parsed.data.status !== before.status
            ? `bank_account.${parsed.data.status === "active" ? "reactivated" : "deactivated"}`
            : "bank_account.updated",
        summary: `Bank account ${label} — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: await companyOfEntity(updated.entity_id),
        targetType: "bank_account",
        targetId: updated.account_id,
        targetLabel: label,
        changes,
      });
    }

    return Response.json({ account: updated });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireWriteUser();
    const { id } = await params;
    const row = await loadScoped(user, Number(id));
    if (row.current_balance > 0) {
      return jsonError("Transfer the balance out before deleting this account", 422);
    }
    await db.delete(bankAccounts).where(eq(bankAccounts.account_id, Number(id)));

    await logActivity({
      category: "bank_account",
      action: "bank_account.deleted",
      summary: `Bank account ${row.bank_name} ••••${row.account_number.slice(-4)} (${row.account_holder}) deleted`,
      actor: user,
      companyEntityId: await companyOfEntity(row.entity_id),
      targetType: "bank_account",
      targetId: row.account_id,
      targetLabel: `${row.bank_name} ••••${row.account_number.slice(-4)}`,
      context: { role: row.role },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

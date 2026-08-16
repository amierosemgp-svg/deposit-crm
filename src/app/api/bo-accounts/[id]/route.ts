import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { providerBoAccounts, providerBoAdjustments, transactions } from "@/db/schema";
import { AuthError, authErrorResponse, requireWriteUser } from "@/lib/auth";
import { jsonError } from "@/lib/api-helpers";
import { describeChanges, diffFields, logActivity } from "@/lib/activity-log";

const patchSchema = z.object({
  bo_username: z.string().min(1).optional(),
  bo_url: z.string().trim().max(300).nullable().optional(),
  bo_password: z.string().min(1).optional(),
  bo_pin: z.string().nullable().optional(),
  bo_label: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  notes: z.string().nullable().optional(),
  // credit adjustment (signed) with mandatory reason
  adjust_amount: z.number().optional(),
  adjust_reason: z.string().optional(),
});

async function loadScoped(
  user: Awaited<ReturnType<typeof requireWriteUser>>,
  id: number,
) {
  const [row] = await db
    .select()
    .from(providerBoAccounts)
    .where(eq(providerBoAccounts.bo_account_id, id));
  if (!row) throw new AuthError(404, "BO account not found");
  if (user.role === "cs_agent") {
    throw new AuthError(403, "Only leaders and admins manage BO accounts");
  }
  if (
    user.companyIds !== null &&
    !user.companyIds.includes(row.company_entity_id)
  ) {
    throw new AuthError(403, "BO account is outside your scope");
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
    const row = await loadScoped(user, Number(id));

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid payload");
    const { adjust_amount, adjust_reason, ...fields } = parsed.data;

    if (adjust_amount !== undefined && adjust_amount !== 0) {
      if (!adjust_reason?.trim()) {
        return jsonError("A reason is required for credit adjustments");
      }
      const newCredit = +(row.current_credit + adjust_amount).toFixed(2);
      if (newCredit < 0) return jsonError("Credit cannot go negative", 422);

      await db.transaction(async (txn) => {
        await txn
          .update(providerBoAccounts)
          .set({ current_credit: newCredit, ...fields })
          .where(eq(providerBoAccounts.bo_account_id, row.bo_account_id));
        const [adj] = await txn
          .insert(providerBoAdjustments)
          .values({
            bo_account_id: row.bo_account_id,
            amount: adjust_amount,
            reason: adjust_reason.trim(),
            handled_by_user_id: user.user_id,
          })
          .returning();
        await txn.insert(transactions).values({
          entity_id: row.company_entity_id,
          type: "bo_adjustment",
          amount: adjust_amount,
          game_name: row.game_name,
          reference_id: adj.adjustment_id,
          user_id: user.user_id,
          details: { reason: adjust_reason.trim(), bo_username: row.bo_username },
        });
      });
    } else if (Object.keys(fields).length) {
      await db
        .update(providerBoAccounts)
        .set(fields)
        .where(eq(providerBoAccounts.bo_account_id, row.bo_account_id));
    }

    const [updated] = await db
      .select()
      .from(providerBoAccounts)
      .where(eq(providerBoAccounts.bo_account_id, row.bo_account_id));

    // The credit adjustment itself is money and already lands in the ledger as
    // a bo_adjustment — only the login/config edit belongs here.
    const changes = diffFields(row, fields);
    if (changes.length) {
      await logActivity({
        category: "kiosk",
        action:
          fields.status && fields.status !== row.status
            ? `kiosk.${fields.status === "active" ? "reactivated" : "deactivated"}`
            : "kiosk.updated",
        summary: `Kiosk ${row.game_name} / ${row.bo_username} — ${describeChanges(changes)}`,
        actor: user,
        companyEntityId: row.company_entity_id,
        targetType: "kiosk",
        targetId: row.bo_account_id,
        targetLabel: `${row.game_name} / ${row.bo_username}`,
        changes,
      });
    }

    return Response.json({ boAccount: updated });
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
    await db.transaction(async (txn) => {
      await txn
        .delete(providerBoAdjustments)
        .where(eq(providerBoAdjustments.bo_account_id, row.bo_account_id));
      await txn
        .delete(providerBoAccounts)
        .where(eq(providerBoAccounts.bo_account_id, row.bo_account_id));
    });

    await logActivity({
      category: "kiosk",
      action: "kiosk.deleted",
      summary: `Kiosk ${row.game_name} / ${row.bo_username} deleted (held ${row.current_credit.toFixed(2)} credit)`,
      actor: user,
      companyEntityId: row.company_entity_id,
      targetType: "kiosk",
      targetId: row.bo_account_id,
      targetLabel: `${row.game_name} / ${row.bo_username}`,
      context: { credit_at_deletion: row.current_credit },
    });

    return Response.json({ ok: true });
  } catch (e) {
    return (
      authErrorResponse(e) ?? (console.error(e), jsonError("Server error", 500))
    );
  }
}

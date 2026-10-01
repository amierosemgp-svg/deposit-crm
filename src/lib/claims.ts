/**
 * Who may act on a claimed row — shared by the API and the sheet so the
 * buttons offer exactly what the server will accept.
 *
 * The claim is the lock: approve, pull, reject and delete go to whoever holds
 * the row. A company leader overrides it — they run the desk, and a CS agent
 * who went home holding twenty deposits should not stall the queue until they
 * come back. An unheld row still has to be claimed first, by anyone, so the
 * log always says who owned it when it moved.
 */
export function canActOnClaim(
  user: { user_id: number; role: string } | null | undefined,
  assignee: number | null | undefined,
): boolean {
  if (!user || assignee == null) return false;
  return assignee === user.user_id || user.role === "company_leader";
}

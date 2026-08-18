"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

type Kind = "deposit" | "withdrawal" | "game_transfer";

/**
 * Who is handling a transaction, and a one-click way to claim it.
 *
 * For deposits the claim gates the Approve button, so this is also where you
 * pick a deposit up before dispatching it. `locked` hides the release link once
 * the row has moved past the point where it can be handed back (an approved
 * deposit stays with whoever sent it to the agent); the server enforces the
 * same rule.
 */
export function AssigneeCell({
  kind,
  id,
  assignedToUserId,
  locked = false,
  lockedTitle,
  showLabel = false,
}: {
  kind: Kind;
  id: number;
  assignedToUserId?: number | null;
  locked?: boolean;
  lockedTitle?: string;
  /** Prefix with "Handled by:" — for tables with no Handled-by column of their own. */
  showLabel?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const me = useStore((s) => s.me);
  const userName = useStore((s) => s.userName);
  const setAssignment = useStore((s) => s.setAssignment);

  const isViewer = me?.role === "viewer";
  const isMine = !!me && assignedToUserId === me.user_id;

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const res = await setAssignment({ kind, id, assign: !isMine });
    setBusy(false);
    if (!res.ok) toast.error(res.error ?? "Could not update assignment");
  }

  if (assignedToUserId) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className="text-[12px]"
          title={isMine && locked ? lockedTitle : undefined}
        >
          {showLabel && (
            <span className="text-muted-foreground">Handled by: </span>
          )}
          <span className={isMine ? "font-medium" : ""}>
            {isMine ? "You" : userName(assignedToUserId)}
          </span>
        </span>
        {isMine && !isViewer && !locked && (
          <button
            onClick={toggle}
            disabled={busy}
            title="Release this transaction"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline cursor-pointer disabled:cursor-not-allowed"
          >
            release
          </button>
        )}
      </div>
    );
  }

  if (isViewer) {
    return <span className="text-[12px] text-muted-foreground">—</span>;
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <UserPlus className="h-3 w-3" />
      )}
      Assign to me
    </button>
  );
}

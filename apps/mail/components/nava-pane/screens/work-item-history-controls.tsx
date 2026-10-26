import { SecondaryButton } from '../pane-ui';

/** A refreshed J1 server snapshot. Callers pass null while history is loading or stale. */
export type WorkItemHistoryCursor = {
  cursor: number;
  latestCursor: number;
};

/**
 * Per-item controls. Callbacks bind J1 server mutations.
 * This component keeps no local history stack.
 */
export function WorkItemHistoryControls({
  workItemId,
  serverCursor,
  onUndo,
  onRedo,
  pending = false,
}: {
  workItemId: string;
  serverCursor: WorkItemHistoryCursor | null;
  onUndo: (workItemId: string) => void;
  onRedo: (workItemId: string) => void;
  /** Keep controls disabled through the mutation and cursor refresh. */
  pending?: boolean;
}) {
  if (
    !workItemId.trim()
    || !serverCursor
    || !Number.isSafeInteger(serverCursor.cursor)
    || !Number.isSafeInteger(serverCursor.latestCursor)
    || serverCursor.cursor < 0
    || serverCursor.latestCursor < serverCursor.cursor
  ) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label="Work item history controls"
      className="flex flex-wrap items-center gap-1.5"
    >
      <SecondaryButton
        onClick={() => onUndo(workItemId)}
        disabled={pending || serverCursor.cursor === 0}
      >
        Undo
      </SecondaryButton>
      <SecondaryButton
        onClick={() => onRedo(workItemId)}
        disabled={pending || serverCursor.cursor === serverCursor.latestCursor}
      >
        Redo
      </SecondaryButton>
    </div>
  );
}

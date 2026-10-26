import { SecondaryButton } from '../pane-ui';

/** A refreshed J1 server snapshot. Callers pass null while history is loading or stale. */
export type WorkItemHistoryCursor = {
  revision: number;
  revisionHead: number;
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
  onUndo: (workItemId: string, expectedRevision: number) => void;
  onRedo: (workItemId: string, expectedRevision: number) => void;
  /** Keep controls disabled through the mutation and cursor refresh. */
  pending?: boolean;
}) {
  if (
    !workItemId.trim()
    || !serverCursor
    || !Number.isSafeInteger(serverCursor.revision)
    || !Number.isSafeInteger(serverCursor.revisionHead)
    || serverCursor.revision < 0
    || serverCursor.revisionHead < serverCursor.revision
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
        onClick={() => onUndo(workItemId, serverCursor.revision)}
        disabled={pending || serverCursor.revision === 0}
      >
        Undo
      </SecondaryButton>
      <SecondaryButton
        onClick={() => onRedo(workItemId, serverCursor.revision)}
        disabled={pending || serverCursor.revision === serverCursor.revisionHead}
      >
        Redo
      </SecondaryButton>
    </div>
  );
}

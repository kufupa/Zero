export const CONNECTED_RUN_BASE_DEADLINE_MS = 120_000;
export const CONNECTED_RUN_VARIANTS_DEADLINE_MS = 8 * 60_000;

export function connectedRunDeadlineMs(input: {
  allTools: boolean;
  notesVariants: boolean;
  folioVariants: boolean;
}): number {
  return input.allTools && (input.notesVariants || input.folioVariants)
    ? CONNECTED_RUN_VARIANTS_DEADLINE_MS
    : CONNECTED_RUN_BASE_DEADLINE_MS;
}

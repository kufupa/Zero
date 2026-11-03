/** Dedicated queue: generic hms_write runners must never pick up this action. */
export const HMS_LABTEST_AMEND_PROMPT_VERSION = 'hms-write/lab-amend/1';

// Safety ceilings, not ETAs: leave time for the bounded writer, a fresh
// independent read and evidence/cleanup after the first native effect.
export const HMS_LABTEST_AMEND_RUN_DEADLINE_MS = 25 * 60_000;
export const HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS = 14 * 60_000;
export const HMS_LABTEST_AMEND_CLEANUP_RESERVE_MS = 2 * 60_000;

export function labtestAmendWorkerEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PANE_HMS_LAB_AMEND_WORKER === 'on' && env.PANE_WRITE_AMEND === 'lab';
}

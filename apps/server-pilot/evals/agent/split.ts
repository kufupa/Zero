/** Locked test-split guard. Never retain test rows; ids-only set is enough. */
export const LOCKED_TEST_SPLIT = 'LOCKED_TEST_SPLIT';

export type SplitTaggedRow = {
  split?: unknown;
  inbound?: { id?: unknown };
};

export function evalTestSplitUnlocked(): boolean {
  return process.env.EVAL_UNLOCK_TEST === '1';
}

export function warnUnlockedTestSplit(): void {
  console.warn('EVAL_UNLOCK_TEST=1: generating locked test split');
}

export function rowMessageId(row: SplitTaggedRow): string {
  return typeof row.inbound?.id === 'string' ? row.inbound.id : '';
}

export function isLockedTestSplit(row: SplitTaggedRow, testIds?: ReadonlySet<string>): boolean {
  if (row.split === 'test') return true;
  const id = rowMessageId(row);
  return Boolean(id && testIds?.has(id));
}

export function assertNotTestSplit(row: SplitTaggedRow, testIds?: ReadonlySet<string>): void {
  if (evalTestSplitUnlocked()) return;
  if (isLockedTestSplit(row, testIds)) throw new Error(LOCKED_TEST_SPLIT);
}

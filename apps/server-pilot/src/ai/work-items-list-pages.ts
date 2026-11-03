/** Keep paging bounded, and fail closed rather than return a misleading incomplete task list. */
export const NEEDS_YOU_MAX_CANDIDATES = 4_000;
const MIN_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type NeedsYouCursor = { rank: number; age: string; id: string };
type Candidate = { chipRank: number; sortAge: string; id: string };

export async function collectNeedsYouPages<Row extends Candidate, Result>(input: {
  limit: number;
  fetchPage: (cursor: NeedsYouCursor | null, size: number) => Promise<Row[]>;
  validate: (row: Row) => Result | null;
}): Promise<Result[]> {
  if (!Number.isInteger(input.limit) || input.limit > MAX_PAGE_SIZE) {
    throw new RangeError('Invalid Needs You limit');
  }
  if (input.limit <= 0) return [];
  const pageSize = Math.max(MIN_PAGE_SIZE, input.limit);
  const results: Result[] = [];
  let cursor: NeedsYouCursor | null = null;
  let scanned = 0;
  while (scanned < NEEDS_YOU_MAX_CANDIDATES) {
    const size = Math.min(pageSize, NEEDS_YOU_MAX_CANDIDATES - scanned);
    const rows = await input.fetchPage(cursor, size);
    scanned += rows.length;
    for (const row of rows) {
      const item = input.validate(row);
      if (item !== null) results.push(item);
      if (results.length === input.limit) return results;
    }
    if (rows.length < size) return results;
    const last = rows[rows.length - 1]!;
    cursor = { rank: last.chipRank, age: last.sortAge, id: last.id };
  }
  // A full last page may still be the final page, so probe once without returning partial results.
  if ((await input.fetchPage(cursor, 1)).length > 0) {
    throw new Error('Could not load the complete Needs You list');
  }
  return results;
}

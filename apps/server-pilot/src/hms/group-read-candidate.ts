/**
 * Group block read candidate: exact group reference + bounded date window.
 * Authored-segment only — never walks thread history.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GROUP_BLOCK_READ_MAX_DAYS } from './group-block-read-contract.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const groupRefToken = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'expected group reference');

export const groupReadCandidateSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: z.literal('group_block'),
    exactGroupReference: groupRefToken,
    exactGroupReferenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict()
  .superRefine((candidate, context) => {
    const start = Date.parse(`${candidate.startDate}T00:00:00.000Z`);
    const end = Date.parse(`${candidate.endDate}T00:00:00.000Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      context.addIssue({ code: 'custom', message: 'invalid calendar date' });
      return;
    }
    const days = (end - start) / 86_400_000;
    if (!Number.isInteger(days) || days < 0 || days > GROUP_BLOCK_READ_MAX_DAYS) {
      context.addIssue({ code: 'custom', message: 'date window out of bounds' });
    }
  });

export type GroupReadCandidate = z.infer<typeof groupReadCandidateSchema>;

function captureAll(
  segment: string,
  pattern: RegExp,
  indexes: readonly number[],
): string[][] {
  pattern.lastIndex = 0;
  const captures: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment)) !== null) {
    captures.push(indexes.map((index) => match![index]!));
  }
  return captures;
}

/**
 * Parse one sender-authored, already dequoted segment.
 * Requires exactly one group reference and one start/end date pair.
 */
export function parseGroupReadCandidateFromAuthoredSegment(
  authoredSegment: string,
): GroupReadCandidate | null {
  if (Buffer.byteLength(authoredSegment, 'utf8') > 16 * 1024) return null;

  const refTuples = captureAll(
    authoredSegment,
    /\b(?:group(?:\s*(?:block|booking|ref(?:erence)?|code|id|number))?|allotment)\s*[:=#-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,63})\b/gi,
    [1],
  );
  const dateTuples = captureAll(
    authoredSegment,
    /\b(?:start|from|arrival|begin)\s*(?:date)?\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})\b[\s\S]{0,120}?\b(?:end|to|departure|until)\s*(?:date)?\s*[:=-]?\s*(\d{4}-\d{2}-\d{2})\b/gi,
    [1, 2],
  );
  if (refTuples.length !== 1 || dateTuples.length !== 1) return null;

  const [exactGroupReferenceRaw] = refTuples[0]!;
  const [startDate, endDate] = dateTuples[0]!;
  const exactGroupReference = exactGroupReferenceRaw.toUpperCase();
  const exactGroupReferenceHash = createHash('sha256')
    .update(`group_ref:${exactGroupReference}`)
    .digest('hex');
  const canonical = [exactGroupReference, startDate, endDate].join('|');
  return (
    groupReadCandidateSchema.safeParse({
      id: createHash('sha256')
        .update(`group_block:${canonical}`)
        .digest('hex')
        .slice(0, 32),
      kind: 'group_block',
      exactGroupReference,
      exactGroupReferenceHash,
      startDate,
      endDate,
    }).data ?? null
  );
}

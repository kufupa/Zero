/**
 * Event read candidate: exact event confirmation/reference only.
 * Authored-segment only — never walks thread history.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const eventRefToken = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/, 'expected event reference');

export const eventReadCandidateSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    kind: z.literal('event_summary'),
    exactEventReference: eventRefToken,
    exactEventReferenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type EventReadCandidate = z.infer<typeof eventReadCandidateSchema>;

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
 * Requires exactly one event confirmation/reference token.
 */
export function parseEventReadCandidateFromAuthoredSegment(
  authoredSegment: string,
): EventReadCandidate | null {
  if (Buffer.byteLength(authoredSegment, 'utf8') > 16 * 1024) return null;

  const refTuples = captureAll(
    authoredSegment,
    /\b(?:event(?:\s*(?:reservation|ref(?:erence)?|code|id|number|confirmation))?|confirmation)\s*[:=#-]?\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,63})\b/gi,
    [1],
  );
  if (refTuples.length !== 1) return null;

  const [exactEventReferenceRaw] = refTuples[0]!;
  const exactEventReference = exactEventReferenceRaw.toUpperCase();
  const exactEventReferenceHash = createHash('sha256')
    .update(`event_ref:${exactEventReference}`)
    .digest('hex');
  return (
    eventReadCandidateSchema.safeParse({
      id: createHash('sha256')
        .update(`event_summary:${exactEventReference}`)
        .digest('hex')
        .slice(0, 32),
      kind: 'event_summary',
      exactEventReference,
      exactEventReferenceHash,
    }).data ?? null
  );
}

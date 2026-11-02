import { z } from 'zod';
import { batchChildId, batchDigest, batchRoomDigest, type BatchManifest } from './hms-batch-manifest.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().min(1).refine((value) => value.trim() === value);
export const batchEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claimed'), childId: hex, runId: ref, digest: hex, childDigest: hex }).strict(),
  z.object({ kind: z.literal('outcome'), childId: hex, runId: ref, digest: hex,
    status: z.enum(['confirmed', 'not_dispatched', 'failed', 'uncertain']),
    confirmation: ref.optional(), recordDigest: hex.optional(),
    screenshotRef: ref.optional(), readbackRef: ref.optional() }).strict(),
  z.object({ kind: z.literal('reconciled'), childId: hex, runId: ref, digest: hex,
    status: z.enum(['confirmed', 'not_booked']), readbackRef: ref,
    confirmation: ref.optional(), recordDigest: hex.optional(), screenshotRef: ref.optional() }).strict(),
]);
export type BatchEvent = z.infer<typeof batchEventSchema>;
export type BatchChildOutcome = Extract<BatchEvent, { kind: 'outcome' }>;
export type BatchChildState = {
  childId: string; status: 'unattempted' | 'uncertain' | 'confirmed' | 'not_dispatched' | 'failed' | 'reconciled_not_booked';
  claimRunIds?: string[]; manifestDigest?: string; confirmation?: string; recordDigest?: string; screenshotRef?: string; readbackRef?: string;
};

/** Sequence must come from an authenticated, durable, work-item-wide event log, never client JSON. */
export type BatchEventRow = { sequence: number; value: unknown };
export function parseBatchEvents(rows: BatchEventRow[]): BatchEvent[] {
  let previous = 0;
  return rows.map(({ sequence, value }) => {
    if (!Number.isSafeInteger(sequence) || sequence !== previous + 1) throw new Error('batch_event_order_unverified');
    previous = sequence;
    return batchEventSchema.parse(value);
  });
}

/** A claimed child is never retried until independently reconciled. */
export function batchStates(manifest: BatchManifest, rows: BatchEventRow[]): BatchChildState[] {
  const history = parseBatchEvents(rows);
  const manifestDigest = batchDigest(manifest);
  const childIds = new Set(manifest.rooms.map((room) => batchChildId(manifest, room)));
  // Ignoring other children can hide a prior potentially dispatched write on this work item.
  if (history.some((event) => !childIds.has(event.childId))) {
    return manifest.rooms.map((room) => ({ childId: batchChildId(manifest, room), status: 'uncertain' }));
  }
  const states = manifest.rooms.map((room): BatchChildState => {
    const childId = batchChildId(manifest, room);
    const events = history.filter((event) => event.childId === childId);
    const claims = events.filter((event) => event.kind === 'claimed');
    const claimRunIds = claims.map((claim) => claim.runId);
    const uncertain = (): BatchChildState => ({ childId, claimRunIds, status: 'uncertain' });
    if (!events.length) return { childId, status: 'unattempted' };
    // Until a durable ordering adapter is integrated, multiple claim attempts remain held.
    if (claims.length !== 1 || new Set(claimRunIds).size !== claims.length || events.some((event) =>
      event.kind !== 'claimed' && claims.filter((claim) => claim.runId === event.runId && claim.digest === event.digest).length !== 1)) return uncertain();
    const claim = claims[0]!;
    if (claim.digest !== manifestDigest || claim.childDigest !== batchRoomDigest(room)) return uncertain();
    const claimAt = events.indexOf(claim);
    const outcomeAt = events.findIndex((event) => event.kind === 'outcome');
    const reconciliationAt = events.findIndex((event) => event.kind === 'reconciled');
    if ((outcomeAt !== -1 && outcomeAt <= claimAt) || (reconciliationAt !== -1 && reconciliationAt <= claimAt) ||
        (outcomeAt !== -1 && reconciliationAt !== -1 && reconciliationAt <= outcomeAt)) return uncertain();
    const resolved = claims.map((claim) => {
      const matching = events.filter((event) => event.runId === claim.runId && event.digest === claim.digest);
      const outcomes = matching.filter((event) => event.kind === 'outcome');
      const reconciled = matching.filter((event) => event.kind === 'reconciled');
      // Array.at keeps absence explicit under the server's TypeScript settings.
      const prior = outcomes.at(0), final = reconciled.at(0);
      // A later readback cannot silently erase native evidence captured during an
      // uncertain attempt. Conflicts stay held for independent investigation.
      if (prior && final && ((final.status === 'not_booked' && (prior.confirmation || prior.recordDigest)) ||
          (final.status === 'confirmed' && ((prior.confirmation && prior.confirmation !== final.confirmation) ||
            (prior.recordDigest && prior.recordDigest !== final.recordDigest))) ||
          (prior.screenshotRef && prior.screenshotRef === prior.readbackRef) ||
          final.readbackRef === prior.screenshotRef || final.readbackRef === prior.readbackRef ||
          (final.status === 'confirmed' && prior.readbackRef && final.screenshotRef === prior.readbackRef))) return null;
      if (outcomes.length > 1 || reconciled.length > 1 || (outcomes[0]?.status === 'confirmed' && reconciled.length) ||
          (outcomes[0]?.status === 'not_dispatched' && reconciled[0]?.status === 'confirmed') ||
          (outcomes[0]?.status === 'not_dispatched' && (outcomes[0].confirmation || outcomes[0].recordDigest ||
            outcomes[0].screenshotRef || outcomes[0].readbackRef)) ||
          (reconciled[0]?.status === 'not_booked' && (reconciled[0].confirmation || reconciled[0].recordDigest ||
            reconciled[0].screenshotRef))) return null;
      return final ?? prior ?? null;
    });
    if (resolved.some((result) => !result)) return uncertain();
    const confirmations = resolved.filter((result) => result?.status === 'confirmed');
    if (confirmations.length > 1) return uncertain();
    if (confirmations.length === 1) {
      const result = confirmations[0]!;
      const claim = claims[resolved.indexOf(result)];
      if (!claim || claim.digest !== manifestDigest || claim.childDigest !== batchRoomDigest(room) ||
          !result.confirmation || !result.recordDigest || !result.screenshotRef || !result.readbackRef ||
          result.screenshotRef === result.readbackRef ||
          resolved.some((other) => other !== result && other?.status !== 'not_booked')) return uncertain();
      return { childId, claimRunIds, status: 'confirmed', manifestDigest: claim.digest,
        confirmation: result.confirmation, recordDigest: result.recordDigest, screenshotRef: result.screenshotRef, readbackRef: result.readbackRef };
    }
    if (resolved.length === 1 && resolved[0]?.kind === 'reconciled' && resolved[0].status === 'not_booked') {
      return { childId, claimRunIds, status: 'reconciled_not_booked', readbackRef: resolved[0].readbackRef };
    }
    // A generic failure does not prove whether the native request was sent.
    if (resolved.length === 1 && resolved[0]?.kind === 'outcome' && resolved[0].status === 'not_dispatched') {
      return { childId, claimRunIds, status: 'not_dispatched' };
    }
    return uncertain();
  });
  // Readback and screenshot evidence must not be reused for different children,
  // including a negative reconciliation, and confirmations must be distinct.
  return states.map((state) => {
    if (state.status !== 'confirmed' && state.status !== 'reconciled_not_booked') return state;
    const evidence = new Set(history.filter((event) => event.childId === state.childId && event.kind !== 'claimed')
      .flatMap((event) => event.kind === 'claimed' ? [] : [event.screenshotRef, event.readbackRef])
      .filter((value): value is string => Boolean(value)));
    const conflict = states.some((other) => other !== state &&
      ((state.confirmation && other.confirmation === state.confirmation) ||
        history.some((event) => event.childId === other.childId && event.kind !== 'claimed' &&
          [event.screenshotRef, event.readbackRef].some((value) => value && evidence.has(value)))));
    return conflict ? { childId: state.childId, claimRunIds: state.claimRunIds, status: 'uncertain' as const } : state;
  });
}

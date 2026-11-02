import { z } from 'zod';
import { batchChildId, batchDigest, batchManifestSchema, type BatchManifest } from './hms-batch-manifest.js';
import { batchEventSchema, batchStates, parseBatchEvents, type BatchChildState, type BatchEvent, type BatchEventRow } from './hms-batch-state.js';
import { validateBatchTransition } from './hms-batch-transition.js';

const identifier = z.string().min(1).max(200).refine((value) => value === value.trim() &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const cursor = z.object({ extractionId: z.string().uuid(), revision: z.number().int().nonnegative().safe(),
  revisionHead: z.number().int().nonnegative().safe(), seq: z.number().int().nonnegative().safe() }).strict()
  .refine((value) => value.revision <= value.revisionHead);
const scopeSchema = z.object({ actorUserId: identifier, accessId: identifier, propertyCode: identifier,
  transportId: identifier, threadId: identifier, messageId: identifier, workItemId: z.string().uuid() }).strict();
const historyRow = z.object({ eventId: z.string().uuid(), sequence: z.number().int().positive().safe(), value: z.unknown() }).strict();
const candidateSchema = z.object({ manifestId: identifier, manifestRevision: z.number().int().nonnegative().safe(),
  manifestDigest: digest, sourceDigest: digest, cursor, parentRunId: identifier, parentGrantId: identifier,
  grantActorUserId: identifier, manifest: batchManifestSchema, history: z.array(historyRow).max(512) }).strict();
const discoverySchema = z.object({ complete: z.literal(true), candidates: z.array(candidateSchema).max(2) }).strict();

type Scope = z.infer<typeof scopeSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type HistoryRow = z.infer<typeof historyRow>;

/**
 * Adapter-only contract. These functions do not exist in production yet. The adapter
 * must authenticate the viewer and lock current mailbox access, property, source and
 * work item in a proven global order. Its discovery must cover all source-related
 * work items, manifests and fences, including reclassification and incomplete writes.
 * Unresolved foreign work items must hold. The candidate history is the complete,
 * gapless batch log for its work item across all manifests; never combine independent
 * work-item sequences. Read it in the same transaction. No pane input, client assertion,
 * timestamp, UUID order or revisionSeq establishes completeness or ordering.
 *
 * Parent verification checks the persisted grant, original actor, run, manifest,
 * source cursor/digest and relevant fence. Each event verifier checks its own grant,
 * actor, run, claim and fence, including earlier grants; current viewing access does
 * not transfer approval authority. Evidence verification checks exact child/attempt,
 * artifact provenance, independent fresh readback, and settlement where required.
 * Negative reconciliation requires trusted request settlement and complete census.
 * Every verifier is transaction-bound, DB-only, and awaited; external HMS or object
 * storage access cannot safely be assumed protected by these row locks.
 */
export type BatchRecoveryReader = {
  discover: () => Promise<unknown>;
  verifyParent: (input: Readonly<{ scope: Readonly<Scope>; candidate: Readonly<Candidate> }>) => Promise<boolean>;
  verifyEvent: (input: Readonly<{ scope: Readonly<Scope>; candidate: Readonly<Candidate>; row: Readonly<HistoryRow>; event: Readonly<BatchEvent> }>) => Promise<boolean>;
  verifyEvidence: (input: Readonly<{ scope: Readonly<Scope>; candidate: Readonly<Candidate>; row: Readonly<HistoryRow>; event: Readonly<BatchEvent>;
    kind: 'screenshot' | 'readback'; ref: string }>) => Promise<boolean>;
};
export type BatchRecoveryDependencies = {
  withAuthenticatedSnapshot: (scope: Readonly<Scope>, run: (reader: BatchRecoveryReader) => Promise<void>) => Promise<void>;
};
export type BatchRecoveryResult =
  | { status: 'held'; canApprove: false }
  | { status: 'recovered'; canApprove: false; manifestId: string; manifestRevision: number; manifestDigest: string;
      parentRunId: string; manifest: BatchManifest;
      children: Array<{ allocationId: string; childId: string; status: BatchChildState['status']; attemptRunId?: string;
        confirmation?: string; screenshotRecorded: boolean; readbackRecorded: boolean }> };

const held = (): BatchRecoveryResult => Object.freeze({ status: 'held', canApprove: false });
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

/**
 * Display-only recovery projection. It cannot establish authentication, database
 * isolation, source-wide exclusion, request settlement or permission to dispatch.
 * An empty scan is held, not interpreted as proof that a new Go is safe. Native
 * writes and route mounting remain forbidden until every adapter obligation is proven.
 */
export async function recoverBatchForDisplay(rawScope: unknown, deps: BatchRecoveryDependencies): Promise<BatchRecoveryResult> {
  let closed = false;
  try {
    const scope = scopeSchema.parse(structuredClone(rawScope));
    freeze(scope);
    let result: BatchRecoveryResult | undefined;
    let called = false, invalid = false;
    await deps.withAuthenticatedSnapshot(scope, async (reader) => {
      try {
        if (called || closed) { invalid = true; return; }
        called = true;
        const rawDiscovery = await reader.discover();
        if (closed || invalid) return;
        const discovery = discoverySchema.parse(structuredClone(rawDiscovery));
        if (discovery.candidates.length !== 1) { result = held(); return; }
        const candidate = discovery.candidates[0]!;
        freeze(candidate);
        const manifest = candidate.manifest, source = manifest.source;
        if (manifest.propertyCode !== scope.propertyCode || source.transportId !== scope.transportId ||
            source.threadId !== scope.threadId || source.messageId !== scope.messageId || source.workItemId !== scope.workItemId ||
            batchDigest(manifest) !== candidate.manifestDigest) { result = held(); return; }
        const parentVerified = await reader.verifyParent(Object.freeze({ scope, candidate }));
        if (closed || invalid) return;
        if (parentVerified !== true) { result = held(); return; }
        const rows: BatchEventRow[] = candidate.history.map(({ sequence, value }) => ({ sequence, value }));
        const events = parseBatchEvents(rows);
        if (new Set(candidate.history.map((row) => row.eventId)).size !== rows.length) { result = held(); return; }
        for (let index = 0; index < events.length; index += 1) {
          const event = batchEventSchema.parse(events[index]), row = candidate.history[index]!;
          freeze(event);
          validateBatchTransition(manifest, rows.slice(0, index), event);
          const eventVerified = await reader.verifyEvent(Object.freeze({ scope, candidate, row, event }));
          if (closed || invalid) return;
          if (eventVerified !== true) { result = held(); return; }
          if (event.kind !== 'claimed') {
            for (const [kind, ref] of [['screenshot', event.screenshotRef], ['readback', event.readbackRef]] as const) {
              if (!ref) continue;
              const evidenceVerified = await reader.verifyEvidence(Object.freeze({ scope, candidate, row, event, kind, ref }));
              if (closed || invalid) return;
              if (evidenceVerified !== true) { result = held(); return; }
            }
          }
        }
        const states = batchStates(manifest, rows);
        const children = manifest.rooms.map((room, index) => {
          const state = states[index]!, childEvents = events.filter((event) => event.childId === state.childId);
          return { allocationId: room.allocationId, childId: batchChildId(manifest, room), status: state.status,
            ...(state.claimRunIds?.length === 1 ? { attemptRunId: state.claimRunIds[0] } : {}),
            ...(state.status === 'confirmed' && state.confirmation ? { confirmation: state.confirmation } : {}),
            screenshotRecorded: childEvents.some((event) => event.kind !== 'claimed' && Boolean(event.screenshotRef)),
            readbackRecorded: childEvents.some((event) => event.kind !== 'claimed' && Boolean(event.readbackRef)) };
        });
        if (closed || invalid) return;
        result = { status: 'recovered', canApprove: false, manifestId: candidate.manifestId,
          manifestRevision: candidate.manifestRevision, manifestDigest: candidate.manifestDigest,
          parentRunId: candidate.parentRunId, manifest, children };
        freeze(result);
      } catch { invalid = true; result = held(); }
    });
    closed = true;
    return invalid ? held() : result ?? held();
  } catch { return held(); }
  finally { closed = true; }
}

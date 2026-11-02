import { isDeepStrictEqual } from 'node:util';
import { validateBatchTransition } from './hms-batch-transition.js';
import { batchChildId, batchDigest, batchRoomDigest, parseLabBatch, verifyBatchRoomProfile,
  type BatchManifest, type BatchProfileLookup, type BatchRoom } from './hms-batch-manifest.js';
import { checkBatchPreimage, type BatchPreimage, type ConfirmedBatchSibling } from './hms-batch-preimage.js';
import { batchEventSchema, batchStates, parseBatchEvents, type BatchEvent, type BatchEventRow, type BatchChildState } from './hms-batch-state.js';

type Context = { manifest: BatchManifest; manifestDigest: string; childId: string; childDigest: string; runId: string };
type DispatchResult = { status: 'confirmed' | 'not_dispatched' | 'failed' | 'uncertain'; confirmation?: string;
  recordDigest?: string; screenshotRef?: string; readbackRef?: string };

/**
 * Integration contract only. Every callback is trusted server infrastructure, not
 * pane input. No route, grant consumer, HMS adapter, lock implementation or write
 * capability is provided here. Do not mount until each boundary is implemented,
 * independently verified and bound to the same consumed approval and source fence.
 */
export type LabBatchSerialDependencies = {
  manifest: unknown; manifestDigest: string; capability: 'off' | 'lab' | 'on'; runId: string;
  deadline: Date; now?: () => Date; lookupProfile: BatchProfileLookup;
  // Lock must cover the entire operation, including all siblings and readbacks.
  withPropertyLock: <T>(property: string, run: () => Promise<T>) => Promise<T>;
  // Both callbacks must use the complete, ordered, authenticated work-item log,
  // including confirmed siblings from an earlier grant for this exact manifest.
  // The adapter must verify every record's actor, scope and grant provenance.
  // append must commit its event and release its transaction before it resolves.
  readHistory: () => Promise<BatchEventRow[]>;
  append: (event: BatchEvent) => Promise<void>;
  // These check the same source, grant, expiry, actor and durable fence. The
  // Save-boundary check must not access the paused page and must honor signal.
  checkAuthority: (context: Context) => Promise<boolean>;
  checkSaveAuthority: (context: Context & { signal: AbortSignal }) => Promise<boolean>;
  // The trusted native proof is page-bound, fresh and single-use. Siblings must
  // be independently reopened and verified, not merely echoed from their claims.
  readPreimage: (room: BatchRoom, siblings: ConfirmedBatchSibling[]) => Promise<BatchPreimage>;
  // The adapter must await beforeSave at the matched native Save request and
  // return confirmed only with a fresh independent readback and screenshot.
  dispatch: (input: { context: Context; room: BatchRoom; preimage: BatchPreimage; cmsSend: false;
    beforeSave: (input: { signal: AbortSignal }) => Promise<true> }) => Promise<DispatchResult>;
};

/**
 * Resume only previously unattempted children after a new trusted approval. A claimed
 * or possibly dispatched child never retries here. This is Labtest-only and disconnected.
 */
export async function executeLabBatchSerial(deps: LabBatchSerialDependencies): Promise<BatchChildState[]> {
  const manifest = parseLabBatch(deps.manifest, deps.capability);
  const digest = batchDigest(manifest);
  const deadline = deps.deadline.getTime(), runId = deps.runId;
  if (digest !== deps.manifestDigest || !runId || runId.trim() !== runId ||
      !Number.isFinite(deadline)) throw new Error('batch_serial_binding_invalid');
  const current = () => {
    const time = (deps.now?.() ?? new Date()).getTime();
    return Number.isFinite(time) && time < deadline;
  };
  const history = async (): Promise<BatchEventRow[]> => {
    const rows = structuredClone(await deps.readHistory());
    const events = parseBatchEvents(rows);
    events.forEach((event, i) => validateBatchTransition(manifest, rows.slice(0, i), event));
    return rows;
  };
  const append = async (prefix: BatchEventRow[], event: BatchEvent): Promise<BatchEventRow[]> => {
    validateBatchTransition(manifest, prefix, event);
    await deps.append(event);
    const after = await history();
    const tail = after.at(-1);
    if (after.length !== prefix.length + 1 || !isDeepStrictEqual(after.slice(0, -1), prefix) ||
        !tail || !isDeepStrictEqual(batchEventSchema.parse(tail.value), event)) {
      throw new Error('batch_serial_commit_unverified');
    }
    return after;
  };
  return deps.withPropertyLock(manifest.propertyCode, async () => {
    let rows = await history();
    const proofIds = new Set<string>();
    for (let i = 0; i < manifest.rooms.length; i += 1) {
      const room = manifest.rooms[i]!;
      const context: Context = Object.freeze({ manifest, manifestDigest: digest, childId: batchChildId(manifest, room),
        childDigest: batchRoomDigest(room), runId });
      const before = batchStates(manifest, rows);
      if (before[i]?.status === 'confirmed') continue;
      if (!current() || before[i]?.status !== 'unattempted' || before.slice(0, i).some((state) => state.status !== 'confirmed')) break;
      // A fresh grant must authorize continuation before even recording the claim.
      if (!(await deps.checkAuthority(context)) || !current()) break;
      const siblings: ConfirmedBatchSibling[] = before.slice(0, i).map((state) => Object.freeze({
        manifestDigest: state.manifestDigest!, childId: state.childId, status: state.status,
        confirmation: state.confirmation, recordDigest: state.recordDigest,
      }));
      Object.freeze(siblings);
      rows = await append(rows, { kind: 'claimed', childId: context.childId, runId: context.runId,
        digest, childDigest: context.childDigest });
      let outcome: DispatchResult = { status: 'not_dispatched' };
      let enteredDispatch = false;
      try {
        if (!(await deps.checkAuthority(context)) || !current()) throw new Error('batch_authority_refused');
        await verifyBatchRoomProfile(manifest, room, deps.lookupProfile);
        const preimage = structuredClone(await deps.readPreimage(room, siblings));
        const valid = () => current() && checkBatchPreimage(preimage, room, siblings, manifest, i, deps.now?.() ?? new Date());
        if (!valid() || proofIds.has(preimage.proofId)) throw new Error('batch_preimage_refused');
        proofIds.add(preimage.proofId);
        for (const match of preimage.matches) Object.freeze(match);
        Object.freeze(preimage.matches); Object.freeze(preimage);
        if (!(await deps.checkAuthority(context)) || !valid()) throw new Error('batch_authority_refused');
        let started = false, checked = false, invalidated = false, finished = false;
        enteredDispatch = true;
        let result: DispatchResult;
        try {
          result = await deps.dispatch({ context, room, preimage, cmsSend: false,
            beforeSave: async ({ signal }) => {
              if (started || finished) { invalidated = true; throw new Error('batch_pre_save_refused'); }
              started = true;
              const acceptable = () => !finished && !invalidated && signal && !signal.aborted && valid();
              if (!acceptable()) throw new Error('batch_pre_save_refused');
              const allowed = await deps.checkSaveAuthority(Object.freeze({ ...context, signal }));
              if (allowed !== true || !acceptable()) throw new Error('batch_pre_save_refused');
              checked = true;
              return true;
            },
          });
        } finally {
          // Reject any authority check that outlives dispatch, including rejection paths.
          finished = true;
        }
        // Once the adapter is entered, any non-confirmed outcome is ambiguous.
        outcome = result.status === 'confirmed' && checked && !invalidated ? result : { ...result, status: 'uncertain' };
      } catch {
        outcome = { status: enteredDispatch ? 'uncertain' : 'not_dispatched' };
      }
      const candidate = batchEventSchema.parse({ kind: 'outcome', childId: context.childId,
        runId: context.runId, digest, ...outcome });
      try { validateBatchTransition(manifest, rows, candidate); }
      catch {
        // Retain valid observations even if they conflict with another child. A
        // shared confirmation must also invalidate the earlier sibling's state.
        outcome = { ...outcome, status: 'uncertain' };
      }
      rows = await append(rows, batchEventSchema.parse({ kind: 'outcome', childId: context.childId,
        runId: context.runId, digest, ...outcome }));
      if (outcome.status !== 'confirmed') break;
    }
    return batchStates(manifest, rows);
  });
}

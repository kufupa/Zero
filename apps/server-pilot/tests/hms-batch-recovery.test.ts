import { describe, expect, it, vi } from 'vitest';
import { batchChildId, batchDigest, batchRoomDigest, type BatchManifest } from '../src/ai/hms-batch-manifest.js';
import { recoverBatchForDisplay, type BatchRecoveryDependencies, type BatchRecoveryReader } from '../src/ai/hms-batch-recovery.js';

function fixture() {
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
    guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
    roomType: 'STQN', ratePlan: 'BAR', amount: { status: 'unknown' }, agency: null, organization: null,
    guaranteeType: 'NGI', sourceOfBusiness: null, note: null, track: null, marketSegment: null,
    guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  const manifest: BatchManifest = { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'transport', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
  const scope = { ...manifest.source, propertyCode: manifest.propertyCode, actorUserId: 'viewer', accessId: 'access' };
  const claim = { kind: 'claimed', childId: batchChildId(manifest, room), runId: 'run-1',
    digest: batchDigest(manifest), childDigest: batchRoomDigest(room) };
  const outcome = { kind: 'outcome', childId: claim.childId, runId: claim.runId, digest: claim.digest, status: 'confirmed',
    confirmation: 'C1', recordDigest: 'a'.repeat(64), screenshotRef: 'shot-1', readbackRef: 'read-1' };
  const second = manifest.rooms[1]!;
  const secondClaim = { ...claim, childId: batchChildId(manifest, second), childDigest: batchRoomDigest(second), runId: 'run-2' };
  const rows = (...events: unknown[]) => events.map((value, index) => ({ sequence: index + 1,
    eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, value }));
  const candidate = { manifestId: 'manifest-1', manifestRevision: 7, manifestDigest: batchDigest(manifest),
    sourceDigest: 'b'.repeat(64), cursor: { extractionId: '22222222-2222-4222-8222-222222222222', revision: 2, revisionHead: 3, seq: 4 },
    parentRunId: 'run-2', parentGrantId: 'grant-2', grantActorUserId: 'approver', manifest,
    history: rows(claim, outcome, secondClaim) };
  const discovery = { complete: true, candidates: [candidate] };
  const reader = { discover: vi.fn<BatchRecoveryReader['discover']>(async () => discovery),
    verifyParent: vi.fn<BatchRecoveryReader['verifyParent']>(async () => true),
    verifyEvent: vi.fn<BatchRecoveryReader['verifyEvent']>(async () => true),
    verifyEvidence: vi.fn<BatchRecoveryReader['verifyEvidence']>(async () => true) } satisfies BatchRecoveryReader;
  const deps: BatchRecoveryDependencies = { withAuthenticatedSnapshot: async (_scope, run) => { await run(reader); } };
  return { manifest, scope, claim, outcome, secondClaim, rows, candidate, discovery, reader, deps };
}
const held = { status: 'held', canApprove: false };

describe('disconnected batch recovery projection', () => {
  it('preserves confirmed and uncertain siblings without granting another Go', async () => {
    const f = fixture(), result = await recoverBatchForDisplay(f.scope, f.deps);
    expect(result).toMatchObject({ status: 'recovered', canApprove: false, parentRunId: 'run-2',
      manifestId: 'manifest-1', manifestRevision: 7, manifestDigest: batchDigest(f.manifest), children: [
        { allocationId: 'a', status: 'confirmed', attemptRunId: 'run-1', confirmation: 'C1', screenshotRecorded: true, readbackRecorded: true },
        { allocationId: 'b', status: 'uncertain', attemptRunId: 'run-2', screenshotRecorded: false, readbackRecorded: false },
      ] });
    expect(Reflect.set(result, 'canApprove', true)).toBe(false);
    if (result.status === 'recovered') expect(Reflect.set(result.children[0]!, 'status', 'unattempted')).toBe(false);
    expect(f.reader.verifyParent).toHaveBeenCalledTimes(1);
    expect(f.reader.verifyEvent).toHaveBeenCalledTimes(3);
    expect(f.reader.verifyEvidence).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('shot-1');
    expect(JSON.stringify(result)).not.toContain('read-1');
  });
  it('holds an empty or ambiguous discovery rather than proving a new Go safe', async () => {
    const empty = fixture(); empty.discovery.candidates = [];
    expect(await recoverBatchForDisplay(empty.scope, empty.deps)).toEqual(held);
    const multiple = fixture(); multiple.discovery.candidates.push(structuredClone(multiple.candidate));
    expect(await recoverBatchForDisplay(multiple.scope, multiple.deps)).toEqual(held);
    const incomplete = fixture(); incomplete.discovery.complete = false;
    expect(await recoverBatchForDisplay(incomplete.scope, incomplete.deps)).toEqual(held);
  });
  it('holds an unauthorized snapshot or a callback that never supplies one', async () => {
    const f = fixture(); f.reader.verifyParent.mockResolvedValue(false);
    expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    expect(await recoverBatchForDisplay(f.scope, { withAuthenticatedSnapshot: async () => {} })).toEqual(held);
    expect(await recoverBatchForDisplay(f.scope, { withAuthenticatedSnapshot: async () => { throw new Error('denied'); } })).toEqual(held);
  });
  it('binds property, source, work item, immutable manifest and approval cursor', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.scope.transportId = 'other'; },
      (f: ReturnType<typeof fixture>) => { f.scope.messageId = 'other'; },
      (f: ReturnType<typeof fixture>) => { f.scope.workItemId = '33333333-3333-4333-8333-333333333333'; },
      (f: ReturnType<typeof fixture>) => { f.scope.propertyCode = 'OTHER'; },
      (f: ReturnType<typeof fixture>) => { f.candidate.manifestDigest = 'c'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.candidate.cursor.revision = 4; },
    ]) {
      const f = fixture(); mutate(f);
      expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    }
  });
  it('rejects gaps, duplicates, foreign children, wrong manifests and out-of-order claims', async () => {
    const cases = [
      (f: ReturnType<typeof fixture>) => { f.candidate.history[1]!.sequence = 3; },
      (f: ReturnType<typeof fixture>) => { f.candidate.history[1]!.eventId = f.candidate.history[0]!.eventId; },
      (f: ReturnType<typeof fixture>) => { f.candidate.history = f.rows({ ...f.claim, childId: 'f'.repeat(64) }); },
      (f: ReturnType<typeof fixture>) => { f.candidate.history = f.rows({ ...f.claim, digest: 'f'.repeat(64) }); },
      (f: ReturnType<typeof fixture>) => { f.candidate.history = f.rows(f.secondClaim); },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f);
      expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    }
  });
  it('holds any event or evidence whose original authority cannot be proven', async () => {
    const event = fixture(); event.reader.verifyEvent.mockResolvedValueOnce(false);
    expect(await recoverBatchForDisplay(event.scope, event.deps)).toEqual(held);
    const evidence = fixture(); evidence.reader.verifyEvidence.mockResolvedValueOnce(false);
    expect(await recoverBatchForDisplay(evidence.scope, evidence.deps)).toEqual(held);
    const failed = fixture(); failed.reader.verifyEvidence.mockRejectedValueOnce(new Error('missing'));
    expect(await recoverBatchForDisplay(failed.scope, failed.deps)).toEqual(held);
  });
  it('does not accept a negative reconciliation without trusted settlement', async () => {
    const f = fixture();
    const uncertain = { kind: 'outcome', childId: f.claim.childId, runId: f.claim.runId,
      digest: f.claim.digest, status: 'uncertain' };
    const negative = { kind: 'reconciled', childId: f.claim.childId, runId: f.claim.runId,
      digest: f.claim.digest, status: 'not_booked', readbackRef: 'negative-read' };
    f.candidate.history = f.rows(f.claim, uncertain, negative);
    f.reader.verifyEvent.mockImplementation(async ({ event }) => event.kind !== 'reconciled');
    expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    expect(f.reader.verifyEvidence).not.toHaveBeenCalled();
  });
  it('returns held if an adapter invokes the snapshot callback twice', async () => {
    const f = fixture();
    const deps: BatchRecoveryDependencies = { withAuthenticatedSnapshot: async (_scope, run) => { await run(f.reader); await run(f.reader); } };
    expect(await recoverBatchForDisplay(f.scope, deps)).toEqual(held);
  });
  it('holds a detached callback and never verifies after the snapshot closes', async () => {
    const f = fixture();
    let release!: () => void;
    let detached: Promise<void> | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    f.reader.discover.mockImplementation(async () => { await waiting; return f.discovery; });
    f.deps.withAuthenticatedSnapshot = async (_scope, run) => { detached = run(f.reader); };
    expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    release(); await detached;
    expect(f.reader.verifyParent).not.toHaveBeenCalled();
    expect(f.reader.verifyEvent).not.toHaveBeenCalled();
  });
  it('closes a detached callback when the snapshot transaction throws', async () => {
    const f = fixture();
    let release!: () => void;
    let detached: Promise<void> | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    f.reader.discover.mockImplementation(async () => { await waiting; return f.discovery; });
    f.deps.withAuthenticatedSnapshot = async (_scope, run) => { detached = run(f.reader); throw new Error('transaction_failed'); };
    expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    release(); await detached;
    expect(f.reader.verifyParent).not.toHaveBeenCalled();
    expect(f.reader.verifyEvent).not.toHaveBeenCalled();
  });
  it('absorbs a detached reader failure after the snapshot has closed', async () => {
    const f = fixture();
    let reject!: (reason: Error) => void;
    let detached: Promise<void> | undefined;
    const waiting = new Promise<unknown>((_resolve, fail) => { reject = fail; });
    f.reader.discover.mockImplementation(() => waiting);
    f.deps.withAuthenticatedSnapshot = async (_scope, run) => { detached = run(f.reader); };
    expect(await recoverBatchForDisplay(f.scope, f.deps)).toEqual(held);
    reject(new Error('late_failure'));
    await expect(detached).resolves.toBeUndefined();
    expect(f.reader.verifyParent).not.toHaveBeenCalled();
  });
  it('freezes the bound scope, manifest, history and event across callbacks', async () => {
    const f = fixture();
    f.deps.withAuthenticatedSnapshot = async (scope, run) => {
      expect(Reflect.set(scope, 'workItemId', 'other')).toBe(false);
      await run(f.reader);
    };
    f.reader.verifyParent.mockImplementation(async ({ scope, candidate }) => {
      expect(scope.actorUserId).toBe('viewer');
      expect(Reflect.set(candidate.manifest.rooms[0]!.stay, 'adults', 9)).toBe(false);
      expect(Reflect.set(candidate.history[0]!, 'sequence', 9)).toBe(false);
      return true;
    });
    f.reader.verifyEvent.mockImplementation(async ({ event }) => {
      expect(Reflect.set(event, 'runId', 'other')).toBe(false);
      return true;
    });
    expect((await recoverBatchForDisplay(f.scope, f.deps)).status).toBe('recovered');
  });
  it('keeps even an entirely unattempted approved manifest blocked from reapproval', async () => {
    const f = fixture(); f.candidate.history = [];
    const result = await recoverBatchForDisplay(f.scope, f.deps);
    expect(result).toMatchObject({ status: 'recovered', canApprove: false,
      children: [{ status: 'unattempted' }, { status: 'unattempted' }] });
  });
});

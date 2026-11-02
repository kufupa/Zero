import { describe, expect, it, vi } from 'vitest';
import { batchChildId, batchDigest, batchRoomDigest, type BatchManifest } from '../src/ai/hms-batch-manifest.js';
import { batchStates, type BatchEventRow } from '../src/ai/hms-batch-state.js';
import { executeLabBatchSerial, type LabBatchSerialDependencies } from '../src/ai/hms-batch-serial.js';

function fixture() {
  const room: BatchManifest['rooms'][number] = { allocationId: 'a', identity: { stayId: 's1', rowId: 'r1', roomIndex: 1 },
    guest: { firstName: 'Proof', lastName: 'Labtest', profileId: '123' },
    stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
    roomType: 'STQN', ratePlan: 'BAR', amount: { status: 'unknown' }, agency: null, organization: null,
    guaranteeType: 'NGI', sourceOfBusiness: null, note: null, track: null, marketSegment: null,
    guestOptIn: false, booker: null, cmsSend: false, cmsMessageId: null, cmsRecipient: null };
  const manifest: BatchManifest = { version: 'hms-batch/1', propertyCode: 'HRCEN',
    source: { transportId: 'mailbox', threadId: 'thread', messageId: 'message', workItemId: '11111111-1111-4111-8111-111111111111' },
    rooms: [room, { ...structuredClone(room), allocationId: 'b', identity: { stayId: 's1', rowId: 'r2', roomIndex: 1 }, roomType: 'STWN' }] };
  const rows: BatchEventRow[] = [];
  let now = new Date('2026-11-02T12:00:00Z');
  const readHistory = vi.fn(async () => structuredClone(rows));
  const append: LabBatchSerialDependencies['append'] = vi.fn(async (event) => { rows.push({ sequence: rows.length + 1, value: structuredClone(event) }); });
  const checkAuthority = vi.fn(async () => true);
  const checkSaveAuthority = vi.fn(async () => true);
  const readPreimage: LabBatchSerialDependencies['readPreimage'] = vi.fn(async (currentRoom, siblings) => ({
    proofId: `proof-${rows.length}`, arrival: currentRoom.stay.arrival, departure: currentRoom.stay.departure,
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 120_000).toISOString(), complete: true,
    matches: siblings.map((sibling) => ({ confirmation: sibling.confirmation!, recordDigest: sibling.recordDigest! })),
  }));
  const dispatch = vi.fn<LabBatchSerialDependencies['dispatch']>(async ({ context, beforeSave, cmsSend }) => {
    expect(cmsSend).toBe(false);
    await beforeSave({ signal: new AbortController().signal });
    const room = context.childId;
    return { status: 'confirmed', confirmation: `CONF-${room}`, recordDigest: 'a'.repeat(64),
      screenshotRef: `shot-${room}`, readbackRef: `read-${room}` };
  });
  const deps: LabBatchSerialDependencies = { manifest, manifestDigest: batchDigest(manifest), capability: 'lab', runId: 'run-1',
    deadline: new Date(now.getTime() + 30_000), now: () => new Date(now.getTime()), readHistory, append, checkAuthority, checkSaveAuthority,
    lookupProfile: vi.fn(async (propertyCode, profileId) => ({ propertyCode, profileId, firstName: 'Proof', lastName: 'Labtest' })),
    withPropertyLock: async (_property, run) => run(), readPreimage, dispatch };
  return { manifest, rows, deps, dispatch, checkAuthority, checkSaveAuthority, readPreimage,
    setNow: (value: Date) => { now = value; } };
}

describe('disconnected Labtest serial executor contract', () => {
  it('dispatches children serially with distinct claims and verified sibling preimage', async () => {
    const f = fixture(), states = await executeLabBatchSerial(f.deps);
    expect(states.map((state) => state.status)).toEqual(['confirmed', 'confirmed']);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.readPreimage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.readPreimage).mock.calls[0]![1]).toEqual([]);
    expect(vi.mocked(f.readPreimage).mock.calls[1]![1]).toHaveLength(1);
    expect(f.rows.map(({ value }) => (value as { kind: string }).kind)).toEqual(['claimed', 'outcome', 'claimed', 'outcome']);
  });
  it('records evidence while ignoring adapter metadata and binding event identity server-side', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (input) => ({ ...await original(input), durationMs: 42,
      kind: 'claimed', childId: 'f'.repeat(64), runId: 'other-run', digest: 'e'.repeat(64) }));
    const states = await executeLabBatchSerial(f.deps);
    expect(states.map((state) => state.status)).toEqual(['confirmed', 'confirmed']);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) {
      const event = f.rows[index * 2 + 1]!.value;
      expect(event).toMatchObject({ kind: 'outcome', childId: batchChildId(f.manifest, f.manifest.rooms[index]!),
        runId: 'run-1', digest: batchDigest(f.manifest), status: 'confirmed' });
      expect(event).not.toHaveProperty('durationMs');
    }
  });
  it('holds unapproved Save evidence and ignores adapter metadata', async () => {
    const f = fixture();
    f.dispatch.mockImplementationOnce(async () => ({ status: 'confirmed', confirmation: 'C1',
      recordDigest: 'a'.repeat(64), screenshotRef: 'shot-1', readbackRef: 'read-1',
      childId: 'f'.repeat(64), runId: 'other-run', durationMs: 42 }));
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.rows[1]!.value).toMatchObject({ kind: 'outcome', status: 'uncertain', confirmation: 'C1',
      childId: batchChildId(f.manifest, f.manifest.rooms[0]!), runId: 'run-1', screenshotRef: 'shot-1', readbackRef: 'read-1' });
    expect(f.rows[1]!.value).not.toHaveProperty('durationMs');
  });
  it('omits undefined evidence so outcome verification survives a JSON round trip', async () => {
    const f = fixture();
    f.deps.append = async (event) => { f.rows.push({ sequence: f.rows.length + 1, value: JSON.parse(JSON.stringify(event)) }); };
    f.dispatch.mockImplementationOnce(async ({ beforeSave }) => {
      await beforeSave({ signal: new AbortController().signal });
      return { status: 'uncertain', confirmation: 'C1', durationMs: 42 };
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(f.rows[1]!.value).toMatchObject({ status: 'uncertain', confirmation: 'C1' });
    expect(f.rows[1]!.value).not.toHaveProperty('screenshotRef');
  });
  it('stops at the first uncertain result and never dispatches later rooms', async () => {
    const f = fixture();
    f.dispatch.mockImplementationOnce(async ({ beforeSave }) => { await beforeSave({ signal: new AbortController().signal }); return { status: 'uncertain' }; });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('stops before a later child at expiry and continues only unattempted children after a fresh grant', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementationOnce(async (input) => {
      const result = await original(input);
      f.setNow(new Date('2026-11-02T12:00:31Z'));
      return result;
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    f.deps.runId = 'run-2'; f.deps.deadline = new Date('2026-11-02T12:01:00Z');
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'confirmed']);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[1]![0].context.runId).toBe('run-2');
  });
  it('does not allow a callback to extend the captured grant expiry', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementationOnce(async (input) => {
      const result = await original(input);
      f.deps.deadline.setTime(Date.parse('2026-11-02T13:00:00Z'));
      f.setNow(new Date('2026-11-02T12:00:31Z'));
      return result;
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('keeps the original run identity even if a callback mutates the dependency object', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementationOnce(async (input) => { const result = await original(input); f.deps.runId = 'changed'; return result; });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'confirmed']);
    expect(f.dispatch.mock.calls[1]![0].context.runId).toBe('run-1');
  });
  it('keeps callback context and prior-sibling snapshots immutable', async () => {
    const f = fixture(), originalRead = f.deps.readPreimage, originalDispatch = f.dispatch.getMockImplementation()!;
    f.deps.checkAuthority = async (context) => {
      expect(Reflect.set(context, 'childId', 'f'.repeat(64))).toBe(false);
      expect(Reflect.set(context.manifest.rooms[0]!.stay, 'adults', 7)).toBe(false);
      return true;
    };
    f.deps.checkSaveAuthority = async (context) => {
      expect(Reflect.set(context, 'childId', 'f'.repeat(64))).toBe(false);
      expect(Reflect.set(context, 'runId', 'OTHER')).toBe(false);
      expect(Reflect.set(context, 'signal', new AbortController().signal)).toBe(false);
      return true;
    };
    f.deps.readPreimage = async (room, siblings) => {
      if (siblings.length) {
        expect(Reflect.set(siblings[0]!, 'confirmation', 'OTHER')).toBe(false);
        expect(Reflect.set(siblings, 'length', 0)).toBe(false);
      }
      return originalRead(room, siblings);
    };
    f.dispatch.mockImplementation(async (input) => {
      expect(Reflect.set(input.context, 'runId', 'OTHER')).toBe(false);
      return originalDispatch(input);
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'confirmed']);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('holds before claiming if the new approval or revision is invalid', async () => {
    const f = fixture(); f.checkAuthority.mockResolvedValue(false);
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['unattempted', 'unattempted']);
    expect(f.rows).toHaveLength(0); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('stops after a confirmed child if source authority changes before the next claim', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    let allowed = true;
    f.checkAuthority.mockImplementation(async () => allowed);
    f.dispatch.mockImplementationOnce(async (input) => { const result = await original(input); allowed = false; return result; });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.rows).toHaveLength(2);
  });
  it('marks an entered dispatch uncertain when the Save-boundary authority refuses', async () => {
    const f = fixture(); f.checkSaveAuthority.mockResolvedValue(false);
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('refuses a delayed Save check after dispatch rejects and the lock is released', async () => {
    const f = fixture();
    let release!: () => void;
    let late: Promise<'allowed' | 'refused'> | undefined;
    f.checkSaveAuthority.mockImplementation(() => new Promise((resolve) => { release = () => resolve(true); }));
    f.dispatch.mockImplementationOnce(async ({ beforeSave }) => {
      late = beforeSave({ signal: new AbortController().signal }).then(() => 'allowed' as const, () => 'refused' as const);
      throw new Error('adapter_failed');
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
    expect(late).toBeDefined();
    release();
    expect(await late).toBe('refused');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch when the independent sibling census is incomplete', async () => {
    const f = fixture();
    f.deps.readPreimage = vi.fn(async (room) => ({ proofId: 'p', arrival: room.stay.arrival, departure: room.stay.departure,
      observedAt: '2026-11-02T12:00:00Z', expiresAt: '2026-11-02T12:02:00Z', complete: false, matches: [] }));
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['not_dispatched', 'unattempted']);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('retains an uncertain sibling confirmation collision and invalidates both results', async () => {
    const f = fixture(), original = f.dispatch.getMockImplementation()!;
    let confirmation = '';
    f.dispatch.mockImplementationOnce(async (input) => { const result = await original(input); confirmation = result.confirmation!; return result; });
    f.dispatch.mockImplementationOnce(async ({ beforeSave }) => { await beforeSave({ signal: new AbortController().signal });
      return { status: 'uncertain', confirmation, screenshotRef: 'second-shot', readbackRef: 'second-read' }; });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['uncertain', 'uncertain']);
    expect(f.rows.at(-1)?.value).toMatchObject({ status: 'uncertain', confirmation });
  });
  it('does not dispatch when a claim append resolves without a durable event', async () => {
    const f = fixture(); f.deps.append = async () => {};
    await expect(executeLabBatchSerial(f.deps)).rejects.toThrow('batch_serial_commit_unverified');
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('does not dispatch when the prior durable prefix changes after a new claim', async () => {
    const f = fixture(), originalDispatch = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementationOnce(async (input) => {
      const result = await originalDispatch(input); f.setNow(new Date('2026-11-02T12:00:31Z')); return result;
    });
    expect((await executeLabBatchSerial(f.deps)).map((state) => state.status)).toEqual(['confirmed', 'unattempted']);
    f.deps.runId = 'run-2'; f.deps.deadline = new Date('2026-11-02T12:01:00Z');
    const read = f.deps.readHistory; let calls = 0;
    f.deps.readHistory = async () => {
      const rows = await read();
      if (++calls === 2) (rows[1]!.value as { confirmation: string }).confirmation = 'CHANGED';
      return rows;
    };
    await expect(executeLabBatchSerial(f.deps)).rejects.toThrow('batch_serial_commit_unverified');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong-run and out-of-order history before dispatch', async () => {
    const wrongRun = fixture(), first = wrongRun.manifest.rooms[0]!;
    const claim = { kind: 'claimed', childId: batchChildId(wrongRun.manifest, first), runId: 'r1',
      digest: batchDigest(wrongRun.manifest), childDigest: batchRoomDigest(first) };
    wrongRun.rows.push({ sequence: 1, value: claim }, { sequence: 2, value: { kind: 'outcome', childId: claim.childId,
      runId: 'r2', digest: claim.digest, status: 'uncertain' } });
    await expect(executeLabBatchSerial(wrongRun.deps)).rejects.toThrow('batch_transition_invalid');
    expect(wrongRun.dispatch).not.toHaveBeenCalled();
    const outOfOrder = fixture(), second = outOfOrder.manifest.rooms[1]!;
    outOfOrder.rows.push({ sequence: 1, value: { ...claim, childId: batchChildId(outOfOrder.manifest, second),
      childDigest: batchRoomDigest(second) } });
    await expect(executeLabBatchSerial(outOfOrder.deps)).rejects.toThrow('batch_transition_invalid');
    expect(outOfOrder.dispatch).not.toHaveBeenCalled();
  });
  it('leaves a claim uncertain if recording an outcome fails after possible dispatch', async () => {
    const f = fixture(), append = f.deps.append;
    f.deps.append = async (event) => { if (event.kind === 'outcome') throw new Error('db_unavailable'); await append(event); };
    await expect(executeLabBatchSerial(f.deps)).rejects.toThrow('db_unavailable');
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(batchStates(f.manifest, f.rows).map((state) => state.status)).toEqual(['uncertain', 'unattempted']);
  });
  it('refuses real-guest capability before any callback or dispatch', async () => {
    const f = fixture(); f.deps.capability = 'on';
    await expect(executeLabBatchSerial(f.deps)).rejects.toThrow('batch_capability_not_lab');
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

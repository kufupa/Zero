import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch as claimWithEpoch, nativeCreateSaveDigest,
  resolveHmsLabtestDispatch, resolveNeverDispatchedCreate } from '../src/ai/hms-labtest-dispatch.js';
import { digestCloudCreateRequest } from '../tooling/hms-cloud/create-request-binding.mjs';
import { installLabtestSaveRouteChain } from '../tooling/hms-cloud/saved-stay-save-route-chain.mjs';
import { canonicalJson } from '../src/ai/draft-approval.js';

const binding = digestCloudCreateRequest({ propertyCode: 'HRCEN',
  guest: { nativeId: '12345', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
  room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI', sendHmsConfirmation: { kind: 'never' } });
if (binding.outcome !== 'ok') throw new Error('invalid fixture');

function input() {
  return { workItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', transportId: 'fake-mailbox', actorUserId: 'staff',
    grantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', propertyCode: 'HRCEN' as const, firstName: 'Proof' as const,
    lastName: 'Labtest' as const, nativeGuestId: '12345', operation: 'create' as const, stayId: 's1_1',
    target: { propertyCode: 'HRCEN' as const, kind: 'create' as const, firstName: 'Proof', lastName: 'Labtest', arrival: '2027-03-01' },
    sourceDigest: 'a'.repeat(64), approvedDigest: binding.normalizedRequestDigest, requestDigest: 'b'.repeat(64),
    recovery: { request: structuredClone(binding.request),
      previewShot: { runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sha256: 'c'.repeat(64) },
      beforeShot: { runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sha256: 'd'.repeat(64) },
      preimage: { arrival: '2027-03-01', departure: '2027-03-03',
        searchedDateRange: { from: '2027-02-01', to: '2027-04-01' },
        coverage: { displayed: 0, total: 0, complete: true as const } } } };
}

function fakeDb(beforeInsert: () => void = () => {}) {
  let inserted: any;
  const tx = { execute: async () => undefined,
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async (event: unknown) => { beforeInsert(); inserted = structuredClone(event); } }) };
  return { db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB,
    inserted: () => inserted };
}

function historyDb() {
  const rows: any[] = [];
  const tx = { execute: async () => undefined,
    select: () => ({ from: () => ({ where: async () => rows.map((row) => ({
      id: row.id, itemId: row.workItemId, type: row.type, actorKind: row.actorKind, value: structuredClone(row.value),
    })) }) }),
    insert: () => ({ values: async (event: any) => { rows.push(structuredClone({ id: randomUUID(), ...event })); } }) };
  return { rows, db: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB };
}

function savedClaim(confirmation: string, grantId = randomUUID()) {
  const { stayId: _stayId, ...common } = input();
  const nativeStayId = confirmation.replace('-', '');
  return { ...common, workItemId: randomUUID(), grantId, operation: 'attach_document' as const,
    target: { propertyCode: 'HRCEN' as const, kind: 'saved' as const, confirmation, nativeStayId },
    recovery: { confirmation, nativeStayId, documentName: 'proof.pdf' } };
}

function nativeOnlyClaim(nativeStayId: string) {
  const common = savedClaim('123456-1');
  return { ...common, target: { propertyCode: 'HRCEN' as const, kind: 'saved' as const, nativeStayId },
    recovery: { nativeStayId, documentName: 'proof.pdf' } };
}

function verifiedReadback(confirmation: string, nativeStayId: string) {
  const nativeReadback = { confirmation, nativeStayId, source: 'fresh_native_readback' };
  return { nativeReadback, readbackDigest: createHash('sha256').update(canonicalJson(nativeReadback)).digest('hex') };
}

// Model transaction-scoped advisory locks so cross-target replay has a real interleaving.
function concurrentDb() {
  const rows: any[] = [], locks = new Map<string, Promise<void>>();
  let grantAttempts = 0, secondGrantAttempt!: () => void, targetWaitAttempt!: () => void;
  const secondGrantWaiting = new Promise<void>((resolve) => { secondGrantAttempt = resolve; });
  const targetWaiting = new Promise<void>((resolve) => { targetWaitAttempt = resolve; });
  const db = { transaction: async (fn: (tx: any) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const tx = {
      execute: async (query: any) => {
        const namespace = query.queryChunks[0].value.join('');
        const key = `${namespace}:${query.queryChunks[1]}`;
        if (namespace.includes('nava-hms-write-grant-v1') && ++grantAttempts === 2) secondGrantAttempt();
        const previous = locks.get(key);
        if (previous && !namespace.includes('nava-hms-write-grant-v1')) targetWaitAttempt();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        locks.set(key, held);
        if (previous) await previous;
        releases.push(() => { if (locks.get(key) === held) locks.delete(key); release(); });
      },
      select: () => ({ from: () => ({ where: async () => rows.map((row) => ({
        id: row.id, itemId: row.workItemId, type: row.type, actorKind: row.actorKind, value: structuredClone(row.value),
      })) }) }),
      insert: () => ({ values: async (event: any) => { rows.push(structuredClone({ id: randomUUID(), ...event })); } }),
    };
    try { return await fn(tx); } finally { for (const release of releases.reverse()) release(); }
  } } as unknown as DB;
  return { db, secondGrantWaiting, targetWaiting };
}

async function claimHmsLabtestDispatch(db: DB, claim: Parameters<typeof claimWithEpoch>[1], authorize: Parameters<typeof claimWithEpoch>[2]) {
  return claimWithEpoch(db, claim, authorize, await captureHmsLabtestDispatchEpoch(db, claim.target, claim.workItemId));
}

async function neverDispatchedRequest() {
  const frame = {};
  const request = { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
    headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }), postDataBuffer: () => Buffer.from('approved=1'), frame: () => frame };
  let pageHandler!: (route: unknown) => Promise<unknown>, contextHandler!: (route: unknown) => Promise<unknown>;
  let release!: () => void, entered!: () => void, proof: unknown;
  const locked = new Promise<void>((resolve) => { release = resolve; });
  const claiming = new Promise<void>((resolve) => { entered = resolve; });
  const context = { route: async (_pattern: string, handler: typeof contextHandler) => { contextHandler = handler; } };
  const page = { context: () => context, route: async (_pattern: string, handler: typeof pageHandler) => { pageHandler = handler; } };
  const chain = await installLabtestSaveRouteChain(page, { frame, fence: { isQuarantined: () => false },
    scope: { allow: () => true }, isArmed: () => true, matches: () => true,
    dispatchCandidate: async (_request: unknown, next: (() => Promise<unknown>) & { proveNeverDispatched: () => unknown }) => {
      entered(); await locked;
      try { await next(); } catch { proof = next.proveNeverDispatched(); }
    } });
  const route = { request: () => request, fallback: async () => undefined, abort: async () => undefined,
    continue: async () => { throw new Error('native request must remain blocked'); } };
  await pageHandler(route);
  const pending = contextHandler(route);
  await claiming;
  expect(await chain.drain({ timeoutMs: 5 })).toBe(false);
  release(); await pending;
  return { request, proof };
}

describe('shared Labtest dispatch intent', () => {
  it('resolves only a route-proven never-dispatched create and keeps its grant spent', async () => {
    const { request, proof } = await neverDispatchedRequest();
    const fake = historyDb(), first = { ...input(), stayId: `room_${'a'.repeat(36)}_1`,
      requestDigest: nativeCreateSaveDigest(request) };
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    await expect(resolveNeverDispatchedCreate(fake.db, handle, {}, request, async () => {}))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(resolveNeverDispatchedCreate(fake.db, handle, proof, { ...request }, async () => {}))
      .rejects.toMatchObject({ reason: 'invalid' });
    let recorded = false;
    await resolveNeverDispatchedCreate(fake.db, handle, proof, request, async () => { recorded = true; });
    expect(recorded).toBe(true);
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent', 'not_dispatched']);
    await expect(resolveNeverDispatchedCreate(fake.db, handle, proof, request, async () => {}))
      .rejects.toMatchObject({ reason: 'invalid' });
    await expect(claimHmsLabtestDispatch(fake.db, first, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(fake.db, { ...first, grantId: randomUUID() }, async () => {});
  });

  it('keeps the hold if a genuine no-dispatch proof refers to a different request digest', async () => {
    const { request, proof } = await neverDispatchedRequest();
    const fake = historyDb(), handle = await claimHmsLabtestDispatch(fake.db, input(), async () => {});
    await expect(resolveNeverDispatchedCreate(fake.db, handle, proof, request, async () => {}))
      .rejects.toMatchObject({ reason: 'owner' });
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent']);
    await expect(claimHmsLabtestDispatch(fake.db, { ...input(), grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
  });

  it('rejects an intervening completed writer even when the preimage lock is lost', async () => {
    const fake = historyDb(), staleEpoch = await captureHmsLabtestDispatchEpoch(fake.db, input().target);
    const handle = await claimWithEpoch(fake.db, input(), async () => {}, staleEpoch);
    await resolveHmsLabtestDispatch(fake.db, handle, { operation: 'create', confirmation: '123456-1',
      readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    let continued = false;
    await expect(claimWithEpoch(fake.db, { ...input(), grantId: randomUUID() }, async () => { continued = true; }, staleEpoch))
      .rejects.toMatchObject({ reason: 'occupied' });
    expect(continued).toBe(false);
    const nextEpoch = await captureHmsLabtestDispatchEpoch(fake.db, input().target);
    expect(nextEpoch).not.toBe(staleEpoch);
    await claimWithEpoch(fake.db, { ...input(), grantId: randomUUID() }, async () => { continued = true; }, nextEpoch);
    expect(continued).toBe(true);
  });

  it('rejects nested recovery changes during authorization', async () => {
    const fake = fakeDb();
    await expect(claimHmsLabtestDispatch(fake.db, input(), async (_tx, claim) => {
      const recovery = claim.recovery as ReturnType<typeof input>['recovery'];
      recovery.preimage.coverage.displayed = 1;
    })).rejects.toMatchObject({ reason: 'invalid' });
    expect(fake.inserted()).toBeUndefined();
  });

  it('persists the validated evidence even if a retained callback reference changes later', async () => {
    let retained: any;
    const fake = fakeDb(() => { retained.recovery.request.guest.nativeId = '99999'; });
    await claimHmsLabtestDispatch(fake.db, input(), async (_tx, claim) => { retained = claim; });
    expect(fake.inserted().value).toMatchObject({ nativeGuestId: '12345',
      recovery: { request: { guest: { nativeId: '12345' } } } });
  });

  it('releases only an owned confirmed create and never reuses its grant', async () => {
    const fake = historyDb(), first = input();
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    const second = { ...input(), grantId: randomUUID() };
    const proof = { operation: 'create' as const, confirmation: '123456-1', readbackDigest: 'e'.repeat(64),
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } };
    await expect(claimHmsLabtestDispatch(fake.db, second, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await expect(resolveHmsLabtestDispatch(fake.db, { ...handle, ownerToken: '0'.repeat(64) }, proof, async () => {}))
      .rejects.toMatchObject({ reason: 'owner' });
    await expect(resolveHmsLabtestDispatch(fake.db, handle, proof, async () => { throw new Error('receipt failed'); }))
      .rejects.toThrow('receipt failed');
    await expect(resolveHmsLabtestDispatch(fake.db, handle, proof, async (_tx, intent) => {
      (intent.recovery as ReturnType<typeof input>['recovery']).preimage.coverage.displayed = 1;
    })).rejects.toMatchObject({ reason: 'invalid' });
    await expect(claimHmsLabtestDispatch(fake.db, second, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {});
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent', 'resolved']);
    await expect(claimHmsLabtestDispatch(fake.db, first, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(fake.db, second, async () => {});
    await expect(resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {})).rejects.toMatchObject({ reason: 'owner' });
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent', 'resolved', 'intent']);
  });

  it('admits an unrelated saved stay and refuses a resolution for the wrong operation', async () => {
    const fake = historyDb(), first = input();
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    const { stayId: _stayId, ...shared } = input();
    const filing = { ...shared, workItemId: randomUUID(), grantId: randomUUID(), nativeGuestId: '99999',
      operation: 'attach_document' as const, target: { propertyCode: 'HRCEN' as const, kind: 'saved' as const,
        confirmation: '123456-1', nativeStayId: '42' }, recovery: { confirmation: '123456-1', nativeStayId: '42', documentName: 'proof.pdf' } };
    const filingHandle = await claimHmsLabtestDispatch(fake.db, filing, async () => {});
    const proof = { operation: 'attach_document' as const, confirmation: '123456-1', nativeStayId: '42', readbackDigest: 'e'.repeat(64),
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } };
    await expect(resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {})).rejects.toMatchObject({ reason: 'phase' });
    await expect(resolveHmsLabtestDispatch(fake.db, filingHandle, { ...proof, confirmation: '999999-1' }, async () => {}))
      .rejects.toMatchObject({ reason: 'phase' });
    await resolveHmsLabtestDispatch(fake.db, filingHandle, proof, async () => {});
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent', 'intent', 'resolved']);
    await expect(claimHmsLabtestDispatch(fake.db, { ...first, grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
  });

  it('treats an orphaned or duplicate resolution as corrupt and fails closed', async () => {
    const fake = historyDb(), handle = await claimHmsLabtestDispatch(fake.db, input(), async () => {});
    const proof = { operation: 'create' as const, confirmation: '123456-1', readbackDigest: 'e'.repeat(64),
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } };
    await resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {});
    fake.rows.push({ ...fake.rows[1], id: randomUUID() });
    await expect(claimHmsLabtestDispatch(fake.db, { ...input(), grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'corrupt' });
    fake.rows.splice(2, 1);
    fake.rows[1].value.holdId = randomUUID();
    await expect(claimHmsLabtestDispatch(fake.db, { ...input(), grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'corrupt' });
  });

  it('keeps epochs local and pairs completions with the exact active hold', async () => {
    const fake = historyDb(), first = input(), other = savedClaim('765432-2');
    const epoch = await captureHmsLabtestDispatchEpoch(fake.db, first.target);
    const otherHandle = await claimHmsLabtestDispatch(fake.db, other, async () => {});
    await resolveHmsLabtestDispatch(fake.db, otherHandle, { operation: 'attach_document', confirmation: '765432-2',
      nativeStayId: other.target.nativeStayId, readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    expect(await captureHmsLabtestDispatchEpoch(fake.db, first.target)).toBe(epoch);
    const firstHandle = await claimWithEpoch(fake.db, first, async () => {}, epoch);
    const next = savedClaim('987654-1'), nextHandle = await claimHmsLabtestDispatch(fake.db, next, async () => {});
    await resolveHmsLabtestDispatch(fake.db, nextHandle, { operation: 'attach_document', confirmation: '987654-1',
      nativeStayId: next.target.nativeStayId, readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    await expect(claimHmsLabtestDispatch(fake.db, { ...first, grantId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
    await resolveHmsLabtestDispatch(fake.db, firstHandle, { operation: 'create', confirmation: '123456-1',
      readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
  });

  it('excludes normalized same-guest arrivals regardless of requested departure or work item', async () => {
    const fake = historyDb(), first = input();
    await claimHmsLabtestDispatch(fake.db, first, async () => {});
    const same = structuredClone(first);
    same.workItemId = randomUUID(); same.grantId = randomUUID();
    same.target.firstName = ' PROOF '; same.target.lastName = 'labtest';
    same.recovery.request.stay.departure = '2027-03-05';
    same.recovery.preimage.departure = '2027-03-05';
    await expect(claimHmsLabtestDispatch(fake.db, same, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
  });

  it('reads legacy targets from sealed recovery and confines unattributable holds to their work item', async () => {
    const fake = historyDb(), first = input();
    await claimHmsLabtestDispatch(fake.db, first, async () => {});
    delete fake.rows[0].value.target;
    await expect(claimHmsLabtestDispatch(fake.db, { ...first, grantId: randomUUID(), workItemId: randomUUID() }, async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
    const unrelated = savedClaim('654321-1');
    await claimHmsLabtestDispatch(fake.db, unrelated, async () => {});
    fake.rows[0].value.recovery = { opaque: true };
    const sameItem = { ...savedClaim('654321-2'), workItemId: first.workItemId };
    await expect(claimHmsLabtestDispatch(fake.db, sameItem, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(fake.db, savedClaim('654321-3'), async () => {});
  });

  it('confines corrupt evidence to the attributed target and work item', async () => {
    const fake = historyDb(), first = input();
    await claimHmsLabtestDispatch(fake.db, first, async () => {});
    fake.rows[0].value.ownerDigest = 'corrupt';
    await expect(captureHmsLabtestDispatchEpoch(fake.db, first.target)).rejects.toMatchObject({ reason: 'corrupt' });
    await claimHmsLabtestDispatch(fake.db, savedClaim('345678-1'), async () => {});
    fake.rows.push({ id: randomUUID(), workItemId: randomUUID(), type: 'write.evidence', actorKind: 'system',
      value: { nonsense: true } });
    await claimHmsLabtestDispatch(fake.db, savedClaim('345678-2'), async () => {});
  });

  it('serializes a reused grant across different target transactions', async () => {
    const fake = concurrentDb(), first = input(), second = savedClaim('123456-1', first.grantId.toUpperCase());
    const [firstEpoch, secondEpoch] = await Promise.all([
      captureHmsLabtestDispatchEpoch(fake.db, first.target), captureHmsLabtestDispatchEpoch(fake.db, second.target),
    ]);
    let entered!: () => void, finish!: () => void, secondAuthorized = false;
    const inAuthority = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const one = claimWithEpoch(fake.db, first, async () => { entered(); await wait; }, firstEpoch);
    await inAuthority;
    const two = claimWithEpoch(fake.db, second, async () => { secondAuthorized = true; }, secondEpoch);
    await fake.secondGrantWaiting;
    finish();
    await one;
    await expect(two).rejects.toMatchObject({ reason: 'occupied' });
    expect(secondAuthorized).toBe(false);
  });

  it('rejects a legacy uppercase grant replay across targets', async () => {
    const fake = historyDb(), first = input();
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    await resolveHmsLabtestDispatch(fake.db, handle, { operation: 'create', confirmation: '123456-1',
      readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    fake.rows[0].value.grantId = first.grantId.toUpperCase();
    await expect(claimHmsLabtestDispatch(fake.db, savedClaim('765432-1', first.grantId), async () => {}))
      .rejects.toMatchObject({ reason: 'occupied' });
  });

  it('serializes a confirmed and native-only claim for the same verified stay', async () => {
    const fake = concurrentDb(), full = savedClaim('123456-1'), nativeOnly = nativeOnlyClaim('42');
    full.target.nativeStayId = full.recovery.nativeStayId = '42';
    const [fullEpoch, nativeEpoch] = await Promise.all([
      captureHmsLabtestDispatchEpoch(fake.db, full.target), captureHmsLabtestDispatchEpoch(fake.db, nativeOnly.target),
    ]);
    let entered!: () => void, finish!: () => void, secondAuthorized = false;
    const inAuthority = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const one = claimWithEpoch(fake.db, full, async () => { entered(); await wait; }, fullEpoch);
    await inAuthority;
    const two = claimWithEpoch(fake.db, nativeOnly, async () => { secondAuthorized = true; }, nativeEpoch)
      .then(() => null, (error) => error);
    await fake.targetWaiting;
    finish();
    await one;
    expect(await two).toMatchObject({ reason: 'occupied' });
    expect(secondAuthorized).toBe(false);
  });

  it('refuses missing or wrong native identity and mismatched fresh confirmation on native-only completion', async () => {
    const fake = historyDb(), first = nativeOnlyClaim('42');
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    const observed = verifiedReadback('123456-1', '42');
    const proof = { operation: 'attach_document' as const, confirmation: '123456-1', nativeStayId: '42', ...observed,
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } };
    const { nativeStayId: _native, nativeReadback: _readback, ...missingIdentity } = proof;
    await expect(resolveHmsLabtestDispatch(fake.db, handle, { ...missingIdentity, confirmation: '999999-1' }, async () => {}))
      .rejects.toMatchObject({ reason: 'phase' });
    await expect(resolveHmsLabtestDispatch(fake.db, handle, { ...proof, confirmation: '999999-1' }, async () => {}))
      .rejects.toMatchObject({ reason: 'phase' });
    await expect(resolveHmsLabtestDispatch(fake.db, handle, { ...proof, nativeStayId: '43' }, async () => {}))
      .rejects.toMatchObject({ reason: 'phase' });
    await expect(resolveHmsLabtestDispatch(fake.db, { ...handle, ownerToken: '0'.repeat(64) }, proof, async () => {}))
      .rejects.toMatchObject({ reason: 'owner' });
    await resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {});
    await expect(claimHmsLabtestDispatch(fake.db, { ...first, grantId: randomUUID() }, async () => {})).resolves.toBeDefined();
  });

  it('blocks a full target against legacy confirmation-only history and detects later alias changes in epoch', async () => {
    const fake = historyDb(), legacy = savedClaim('123456-1'), nativeOnly = nativeOnlyClaim('42');
    const ownerToken = 'a'.repeat(64), holdId = randomUUID();
    const value: any = { ...legacy, version: 1, kind: 'intent', holdId,
      ownerDigest: createHash('sha256').update(ownerToken).digest('hex') };
    delete value.target;
    delete value.recovery.nativeStayId;
    fake.rows.push({ id: holdId, workItemId: value.workItemId, actorKind: 'system', type: 'write.evidence', value });
    const full = { ...savedClaim('123456-1'), target: { ...legacy.target, nativeStayId: '42' },
      recovery: { ...legacy.recovery, nativeStayId: '42' } };
    await expect(captureHmsLabtestDispatchEpoch(fake.db, full.target)).rejects.toMatchObject({ reason: 'occupied' });
    await expect(captureHmsLabtestDispatchEpoch(fake.db, { propertyCode: 'HRCEN', kind: 'saved', confirmation: '123456-1' }))
      .rejects.toMatchObject({ reason: 'invalid' });
    const stale = await captureHmsLabtestDispatchEpoch(fake.db, nativeOnly.target);
    const readback = verifiedReadback('123456-1', '42');
    await resolveHmsLabtestDispatch(fake.db, { holdId, ownerToken }, { operation: 'attach_document',
      confirmation: '123456-1', nativeStayId: '42', ...readback,
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    await expect(claimWithEpoch(fake.db, nativeOnly, async () => {}, stale)).rejects.toMatchObject({ reason: 'occupied' });
    await claimHmsLabtestDispatch(fake.db, nativeOnly, async () => {});
  });

  it('does not finish when a verified alias discovers another active hold', async () => {
    const fake = historyDb(), legacy = savedClaim('123456-1'), ownerToken = 'a'.repeat(64), holdId = randomUUID();
    const value: any = { ...legacy, version: 1, kind: 'intent', holdId,
      ownerDigest: createHash('sha256').update(ownerToken).digest('hex') };
    delete value.target;
    delete value.recovery.nativeStayId;
    fake.rows.push({ id: holdId, workItemId: value.workItemId, actorKind: 'system', type: 'write.evidence', value });
    await claimHmsLabtestDispatch(fake.db, nativeOnlyClaim('42'), async () => {});
    await expect(resolveHmsLabtestDispatch(fake.db, { holdId, ownerToken }, { operation: 'attach_document',
      confirmation: '123456-1', nativeStayId: '42', ...verifiedReadback('123456-1', '42'),
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {}))
      .rejects.toMatchObject({ reason: 'corrupt' });
    expect(fake.rows.filter((row) => row.value.kind === 'resolved')).toHaveLength(0);
  });

  it('keeps a legacy wrong-confirmation completion corrupt only for its own target', async () => {
    const fake = historyDb(), first = savedClaim('234567-1');
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    await resolveHmsLabtestDispatch(fake.db, handle, { operation: 'attach_document', confirmation: '234567-1',
      nativeStayId: first.target.nativeStayId, readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    fake.rows[1].value.confirmation = '999999-1';
    await expect(captureHmsLabtestDispatchEpoch(fake.db, first.target)).rejects.toMatchObject({ reason: 'corrupt' });
    await claimHmsLabtestDispatch(fake.db, savedClaim('345678-1'), async () => {});
  });

  it('refuses a target that disagrees with sealed request evidence and refuses missing targets', async () => {
    const fake = historyDb(), first = input();
    await expect(claimWithEpoch(fake.db, { ...first, target: { ...first.target, arrival: '2027-03-02' } }, async () => {},
      await captureHmsLabtestDispatchEpoch(fake.db, first.target))).rejects.toMatchObject({ reason: 'invalid' });
    await expect(captureHmsLabtestDispatchEpoch(fake.db)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('does not guess or omit a confirmation or native ID present in sealed evidence', async () => {
    const fake = historyDb(), nativeOnly = nativeOnlyClaim('42');
    const epoch = await captureHmsLabtestDispatchEpoch(fake.db, nativeOnly.target);
    await expect(claimWithEpoch(fake.db, { ...nativeOnly, recovery: { ...nativeOnly.recovery, confirmation: '123456-1' } },
      async () => {}, epoch)).rejects.toMatchObject({ reason: 'invalid' });
    await expect(claimWithEpoch(fake.db, { ...nativeOnly, recovery: { ...nativeOnly.recovery, confirmation: 'not-valid' } },
      async () => {}, epoch)).rejects.toMatchObject({ reason: 'invalid' });
    const full = savedClaim('123456-1');
    await expect(claimWithEpoch(fake.db, { ...full, recovery: { ...full.recovery, nativeStayId: '43' } }, async () => {},
      await captureHmsLabtestDispatchEpoch(fake.db, full.target))).rejects.toMatchObject({ reason: 'invalid' });
  });
});

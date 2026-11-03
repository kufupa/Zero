import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch as claimWithEpoch, resolveHmsLabtestDispatch } from '../src/ai/hms-labtest-dispatch.js';
import { digestCloudCreateRequest } from '../tooling/hms-cloud/create-request-binding.mjs';

const binding = digestCloudCreateRequest({ propertyCode: 'HRCEN',
  guest: { nativeId: '12345', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: '2027-03-01', departure: '2027-03-03', adults: 1, childAges: [] },
  room: { roomType: 'STQN', ratePlan: 'BAR' }, guaranteeType: 'NGI', sendHmsConfirmation: { kind: 'never' } });
if (binding.outcome !== 'ok') throw new Error('invalid fixture');

function input() {
  return { workItemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', transportId: 'fake-mailbox', actorUserId: 'staff',
    grantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', propertyCode: 'HRCEN' as const, firstName: 'Proof' as const,
    lastName: 'Labtest' as const, nativeGuestId: '12345', operation: 'create' as const, stayId: 's1_1',
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

async function claimHmsLabtestDispatch(db: DB, claim: Parameters<typeof claimWithEpoch>[1], authorize: Parameters<typeof claimWithEpoch>[2]) {
  return claimWithEpoch(db, claim, authorize, await captureHmsLabtestDispatchEpoch(db));
}

describe('shared Labtest dispatch intent', () => {
  it('rejects an intervening completed writer even when the preimage lock is lost', async () => {
    const fake = historyDb(), staleEpoch = await captureHmsLabtestDispatchEpoch(fake.db);
    const handle = await claimWithEpoch(fake.db, input(), async () => {}, staleEpoch);
    await resolveHmsLabtestDispatch(fake.db, handle, { operation: 'create', confirmation: '123456-1',
      readbackDigest: 'e'.repeat(64), savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } }, async () => {});
    let continued = false;
    await expect(claimWithEpoch(fake.db, { ...input(), grantId: randomUUID() }, async () => { continued = true; }, staleEpoch))
      .rejects.toMatchObject({ reason: 'occupied' });
    expect(continued).toBe(false);
    const nextEpoch = await captureHmsLabtestDispatchEpoch(fake.db);
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

  it('blocks another fake profile and refuses a resolution for the wrong operation', async () => {
    const fake = historyDb(), first = input();
    const handle = await claimHmsLabtestDispatch(fake.db, first, async () => {});
    const { stayId: _stayId, ...shared } = input();
    const filing = { ...shared, workItemId: randomUUID(), grantId: randomUUID(), nativeGuestId: '99999',
      operation: 'attach_document' as const, recovery: { confirmation: '123456-1', documentName: 'proof.pdf' } };
    await expect(claimHmsLabtestDispatch(fake.db, filing, async () => {})).rejects.toMatchObject({ reason: 'occupied' });
    const proof = { operation: 'attach_document' as const, confirmation: '123456-1', readbackDigest: 'e'.repeat(64),
      savedShot: { runId: randomUUID(), sha256: 'f'.repeat(64) } };
    await expect(resolveHmsLabtestDispatch(fake.db, handle, proof, async () => {})).rejects.toMatchObject({ reason: 'phase' });
    expect(fake.rows.map((row) => row.value.kind)).toEqual(['intent']);
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
});

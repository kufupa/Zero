import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { canonicalJson } from '../src/ai/draft-approval.js';
import { formDigest, lockConsumedCloudAmendApproval } from '../src/ai/hms-approval.js';
import { HMS_LABTEST_AMEND_PROMPT_VERSION } from '../src/ai/pane-cloud-amend-readiness.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

function fixture() {
  const workItemId = randomUUID(), runId = randomUUID(), grantId = randomUUID();
  const fence = { runId, claimOwner: 'worker', claimToken: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) };
  const readAt = new Date().toISOString(), before = 'a'.repeat(64);
  const state = { action: 'amend', confirmation: '123456-1', arrival: '2027-09-14',
    fields: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' }, cloudAmend: { binding: 'reviewed' },
    hmsSnapshot: { digest: before, readAt } };
  const item = { id: workItemId, transportId: 'mailbox', threadId: 'thread', sourceMessageId: 'selected',
    status: 'needs_you', state };
  const authority = { actorUserId: 'staff', sessionId: 'session', sessionProfile: 'remote' as const };
  const grant = { grantId, workItemId, transportId: 'mailbox', ...authority,
    formDigest: formDigest(state), hmsBeforeDigest: before, hmsReadAt: readAt };
  const payloadHash = createHash('sha256').update(canonicalJson(grant)).digest('hex');
  const run = { id: runId, runKind: 'hms_write', promptVersion: HMS_LABTEST_AMEND_PROMPT_VERSION,
    idempotencyKey: `hms-write:${grantId}`, transportId: 'mailbox', workItemId, state: 'running',
    claimOwner: fence.claimOwner, claimToken: fence.claimToken, deadlineAt: fence.deadlineAt,
    threadId: item.threadId, triggerMessageId: item.sourceMessageId };
  const rows: unknown[][] = [[{ id: 'mailbox', isActive: true, email: 'staff@example.test' }],
    [{ id: 'access', userId: 'staff', transportId: 'mailbox' }], [{ id: 'session' }], [run],
    [{ value: grant, payloadHash }], [{ id: randomUUID() }]];
  return { input: { fence, transportId: 'mailbox', item: item as never, grantId,
    approvedDigest: grant.formDigest, authority }, rows, run };
}

function transaction(rows: unknown[][]) {
  const update = vi.fn(async () => []), locks: string[] = [];
  const next = () => {
    const row = rows.shift();
    if (!row) throw new Error('unexpected database read');
    return row;
  };
  const tx = {
    select: () => {
      const query = new Proxy({ from: () => query, where: () => query, limit: () => query,
        for: async (mode: string) => { locks.push(mode); return next(); } }, {
        get(target, property, receiver) {
          if (property === 'then') return (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(next).then(resolve, reject);
          return Reflect.get(target, property, receiver);
        },
      });
      return query;
    },
    update: () => ({ set: () => ({ where: update }) }),
  } as unknown as Tx;
  return { tx, locks, update };
}

describe('final Labtest amend approval', () => {
  it('locks the active session, exact Go, lease and sole consume marker', async () => {
    const f = fixture(), db = transaction(f.rows);
    await expect(lockConsumedCloudAmendApproval(db.tx, f.input)).resolves.toBeUndefined();
    expect(db.locks).toEqual(['share', 'share', 'share', 'update', 'share', 'share']);
    expect(db.update).toHaveBeenCalledOnce();
  });

  it('refuses a different action queue or duplicate consumption', async () => {
    const wrongQueue = fixture();
    wrongQueue.run.promptVersion = 'hms-write/lab-attach/1';
    await expect(lockConsumedCloudAmendApproval(transaction(wrongQueue.rows).tx, wrongQueue.input))
      .rejects.toThrow('lease_lost');
    const duplicate = fixture();
    duplicate.rows[5] = [{ id: randomUUID() }, { id: randomUUID() }];
    const db = transaction(duplicate.rows);
    await expect(lockConsumedCloudAmendApproval(db.tx, duplicate.input)).rejects.toThrow('not_consumed');
    expect(db.update).not.toHaveBeenCalled();
  });
});

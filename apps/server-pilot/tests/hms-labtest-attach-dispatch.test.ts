import { createHash, randomUUID } from 'node:crypto';
import { documentCodeForUuid } from '../tooling/hms-cloud/pane-attach-session.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { canonicalJson } from '../src/ai/draft-approval.js';
import { authorizeConsumedLabtestAttach, formDigest } from '../src/ai/hms-approval.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION } from '../src/ai/run-ledger.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const workItemId = randomUUID(), runId = randomUUID(), grantId = randomUUID();
  const fence = { runId, claimOwner: 'worker', claimToken: randomUUID(), deadlineAt: new Date(Date.now() + 60_000) };
  const transportId = 'transport-centurion', confirmation = '123456-1', arrival = '2027-09-14', sourceDigest = 'a'.repeat(64);
  const document = { code: documentCodeForUuid(randomUUID()), name: 'voucher.pdf', sha256: 'b'.repeat(64) };
  const readAt = new Date().toISOString(), before = 'c'.repeat(64);
  const selected = { id: 'selected-message', subject: 'Voucher', textBody: 'Please file', htmlBody: null };
  const state = { action: 'attach_document', confirmation, arrival, lastName: 'Labtest', attachmentId: 'attachment-1',
    sourceMessageId: 'selected-message', sourceInternetMessageId: 'selected@example.test',
    sourceThreadId: 'thread', sourceHash: staffQuoteSourceHash(selected),
    sourceSnapshotDigest: sourceDigest, documentName: document.name, pdfSha256: document.sha256,
    documentCode: document.code, filingStateDigest: before,
    hmsSnapshot: { digest: before, readAt } };
  const item = { id: workItemId, transportId, threadId: 'thread', sourceMessageId: 'selected-message',
    status: 'needs_you', state };
  const grant = { grantId, workItemId, transportId, actorUserId: 'staff', sessionId: 'session-1', sessionProfile: 'remote',
    formDigest: formDigest(state), hmsBeforeDigest: before, hmsReadAt: readAt };
  const run = { id: runId, runKind: 'hms_write', promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION,
    idempotencyKey: `hms-write:${grantId}`, transportId, workItemId, state: 'running',
    claimOwner: fence.claimOwner, claimToken: fence.claimToken, deadlineAt: fence.deadlineAt,
    threadId: item.threadId, triggerMessageId: item.sourceMessageId };
  const input = { fence, transportId, workItemId, confirmation, arrival, grantId, actorUserId: 'staff',
    sessionId: 'session-1', sessionProfile: 'remote' as const, sourceDigest, approvedDigest: grant.formDigest,
    documentCode: document.code, documentName: document.name, pdfSha256: document.sha256,
    lockSource: async () => item as never };
  const rows: unknown[][] = [[selected], [{ active: true }], [{ userId: 'staff' }], [{ id: 'session-1' }], [run],
    [{ value: grant, payloadHash: sha(canonicalJson(grant)) }], [{ id: randomUUID() }]];
  return { input, item, rows };
}

function transaction(rows: unknown[][]) {
  const update = vi.fn(async () => []);
  const next = () => {
    const row = rows.shift();
    if (!row) throw new Error('unexpected database read');
    return row;
  };
  const tx = {
    select: () => {
      const query = new Proxy({ from: () => query, where: () => query, limit: () => query,
        for: async () => next() }, {
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
  return { tx, update };
}

afterEach(() => vi.unstubAllEnvs());

describe('final Labtest filing claim authorization', () => {
  it('accepts only a consumed Go, live lease, exact source, current access and session', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'on'); vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    const f = fixture(), { tx, update } = transaction(f.rows);
    await expect(authorizeConsumedLabtestAttach(tx, f.input)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });

  it('refuses changed source, revoked mailbox or session, missing consume and repeated Go', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'on'); vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    const changed = fixture();
    await expect(authorizeConsumedLabtestAttach(transaction([]).tx, { ...changed.input,
      lockSource: async () => ({ ...changed.item, sourceMessageId: 'other' }) as never }))
      .rejects.toThrow('state_changed');
    await expect(authorizeConsumedLabtestAttach(transaction([]).tx, { ...changed.input, arrival: '2027-09-15' }))
      .rejects.toThrow('state_changed');
    const changedBody = fixture();
    changedBody.item.state.sourceHash = 'd'.repeat(64);
    await expect(authorizeConsumedLabtestAttach(transaction(changedBody.rows).tx, changedBody.input))
      .rejects.toThrow('source_mail_changed');
    for (const [index, reason] of [[0, 'filing_unavailable'], [1, 'filing_unavailable'],
      [2, 'filing_unavailable'], [3, 'lease_lost'], [4, 'no_grant'], [5, 'not_consumed']] as const) {
      const f = fixture();
      f.rows[index + 1] = [];
      await expect(authorizeConsumedLabtestAttach(transaction(f.rows).tx, f.input)).rejects.toThrow(reason);
    }
    const duplicate = fixture();
    duplicate.rows[6] = [{ id: randomUUID() }, { id: randomUUID() }];
    await expect(authorizeConsumedLabtestAttach(transaction(duplicate.rows).tx, duplicate.input)).rejects.toThrow('not_consumed');
  });

  it('refuses if the Labtest worker is disabled before touching the database', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'off'); vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    const f = fixture();
    await expect(authorizeConsumedLabtestAttach(transaction([]).tx, f.input)).rejects.toThrow('filing_unavailable');
  });
});

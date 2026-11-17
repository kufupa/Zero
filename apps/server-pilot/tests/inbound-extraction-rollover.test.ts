import { beforeEach, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import type { AiWorkflowRun } from '../src/ai/run-ledger.js';

vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...await original<typeof import('../src/ai/run-ledger.js')>(),
  enqueueAiRun: vi.fn().mockResolvedValue({}),
  markAiRunPolicyRefused: vi.fn().mockResolvedValue(true),
}));

import { enqueueAiRun, markAiRunPolicyRefused } from '../src/ai/run-ledger.js';
import { executeInboundExtractionRun, EXTRACTION_VERSION, refreshSelectedAmendExtraction } from '../src/ai/extraction/inbound-run.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

const run = {
  id: 'old-run', transportId: 'hotel', threadId: 'thread', triggerMessageId: 'message',
  promptVersion: 'old-extraction', admissionSnapshotId: 'snapshot', admissionSnapshotHash: 'hash',
  attempts: 0, metrics: { origin: 'admitted' },
} as AiWorkflowRun;
const input = {
  run,
  fence: { claimOwner: 'worker', claimToken: 'token', deadlineAt: new Date() },
  signal: new AbortController().signal,
  db: {} as DB,
  env: { INBOUND_EXTRACTION: 'on', INBOUND_TRIAGE_CLASSIFIER: 'on' },
};

beforeEach(() => vi.clearAllMocks());

it('queues the current extraction with its admitted source before retiring an old queued version', async () => {
  await executeInboundExtractionRun(input);
  expect(enqueueAiRun).toHaveBeenCalledWith(expect.objectContaining({
    promptVersion: EXTRACTION_VERSION, triggerMessageId: 'message', admissionSnapshotId: 'snapshot',
    admissionSnapshotHash: 'hash', metrics: { origin: 'admitted' },
  }), input.db);
  expect(markAiRunPolicyRefused).toHaveBeenCalledOnce();
  expect(vi.mocked(enqueueAiRun).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(markAiRunPolicyRefused).mock.invocationCallOrder[0]!,
  );
});

it('keeps the old run retryable if scheduling the replacement fails', async () => {
  vi.mocked(enqueueAiRun).mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(executeInboundExtractionRun(input)).rejects.toThrow('queue unavailable');
  expect(markAiRunPolicyRefused).not.toHaveBeenCalled();
});

const mail = { id: 'message', subject: 'Amend', textBody: 'Change the stay', htmlBody: null };
const selected = { transportId: 'hotel', workItemId: 'item', source: {
  threadId: 'thread', messageId: mail.id, sourceHash: staffQuoteSourceHash(mail),
} };
const enabled = { INBOUND_EXTRACTION: 'on' };

function selectedDb(rows: unknown[][]): DB {
  const tx = {
    update: vi.fn(() => ({ set: () => ({ where: async () => [] }) })),
    select: vi.fn(() => {
      const result = rows.shift();
      if (!result) throw new Error('unexpected select');
      return Object.assign(Promise.resolve(result), {
        from() { return this; }, where() { return this; }, limit() { return this; },
        for: async () => result,
      });
    }),
  };
  return { transaction: (fn: (transaction: unknown) => unknown) => fn(tx) } as unknown as DB;
}

function selectedRows(current: unknown[] = []) {
  return [[{ id: 'thread' }], [mail], [{ kind: 'amendment', extractionId: 'old' }], [{ id: 'old' }], current];
}

it('queues only the exact selected source with the worker version key', async () => {
  vi.mocked(enqueueAiRun).mockResolvedValueOnce({ id: 'run', state: 'queued' } as never);
  const db = selectedDb(selectedRows());
  expect(await refreshSelectedAmendExtraction(db, selected, enabled)).toEqual({ status: 'queued', runId: 'run' });
  expect(enqueueAiRun).toHaveBeenCalledWith(expect.objectContaining({
    transportId: 'hotel', threadId: 'thread', triggerMessageId: 'message',
    idempotencyKey: `inbound-extraction:message:${EXTRACTION_VERSION}`,
  }), expect.anything());
});

it('blocks a changed source before enqueueing', async () => {
  const db = selectedDb([[{ id: 'thread' }], [{ ...mail, textBody: 'different' }]]);
  expect(await refreshSelectedAmendExtraction(db, selected, enabled)).toEqual({ status: 'blocked', reason: 'source_changed' });
  expect(enqueueAiRun).not.toHaveBeenCalled();
});

it('reports current, failed and unlinked reads without changing the work item', async () => {
  expect(await refreshSelectedAmendExtraction(selectedDb(selectedRows([{ id: 'old', status: 'succeeded', kind: 'amendment' }])),
    selected, enabled)).toEqual({ status: 'current', extractionId: 'old' });
  expect(await refreshSelectedAmendExtraction(selectedDb(selectedRows([{ id: 'new', status: 'succeeded', kind: 'amendment' }])),
    selected, enabled)).toEqual({ status: 'blocked', reason: 'relink_required' });
  expect(await refreshSelectedAmendExtraction(selectedDb(selectedRows([{ id: 'new', status: 'failed', kind: null }])),
    selected, enabled)).toEqual({ status: 'blocked', reason: 'read_failed' });
  expect(enqueueAiRun).not.toHaveBeenCalled();
});

it('reports disabled and terminal runs honestly', async () => {
  expect(await refreshSelectedAmendExtraction(selectedDb(selectedRows()), selected, {}))
    .toEqual({ status: 'blocked', reason: 'disabled' });
  vi.mocked(enqueueAiRun).mockResolvedValueOnce({ id: 'run', state: 'dead_letter' } as never);
  expect(await refreshSelectedAmendExtraction(selectedDb(selectedRows()), selected, enabled))
    .toEqual({ status: 'blocked', reason: 'run_failed' });
});

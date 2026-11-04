import { beforeEach, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import type { AiWorkflowRun } from '../src/ai/run-ledger.js';

vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...await original<typeof import('../src/ai/run-ledger.js')>(),
  enqueueAiRun: vi.fn().mockResolvedValue({}),
  markAiRunPolicyRefused: vi.fn().mockResolvedValue(true),
}));

import { enqueueAiRun, markAiRunPolicyRefused } from '../src/ai/run-ledger.js';
import { executeInboundExtractionRun, EXTRACTION_VERSION } from '../src/ai/extraction/inbound-run.js';

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

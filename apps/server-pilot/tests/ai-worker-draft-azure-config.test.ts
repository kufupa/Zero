import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({
  claimNextAiRun: vi.fn(),
  markAiRunRunning: vi.fn(),
  markAiRunDeadLetter: vi.fn(),
  markAiRunRetry: vi.fn(),
  heartbeatAiRun: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock('../src/ai/run-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/run-ledger.js')>()),
  claimNextAiRun: ledger.claimNextAiRun,
  markAiRunRunning: ledger.markAiRunRunning,
  markAiRunDeadLetter: ledger.markAiRunDeadLetter,
  markAiRunRetry: ledger.markAiRunRetry,
  heartbeatAiRun: ledger.heartbeatAiRun,
}));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: dbMocks.getDb,
}));

import { aiWorkerOwnerId, runAiWorkerOnce } from '../src/ai/worker.js';

function stubWorkerEnv(): void {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PORT', '8788');
  vi.stubEnv('DATABASE_URL', 'postgres://zero:secret@127.0.0.1:5432/zero_unit');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost');
  vi.stubEnv('BETTER_AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('AWS_REGION', 'af-south-1');
  vi.stubEnv('S3_BUCKET', 'zero-unit-test-bucket');
  vi.stubEnv('AI_WORKER_LANE', 'default');
  vi.stubEnv('HMS_DRAFT_ENRICHMENT_MODE', 'off');
  vi.stubEnv('AZURE_OPENAI_BASE_URL', '');
  vi.stubEnv('AZURE_FOUNDRY_API_KEY', '');
  vi.stubEnv('AI_MODEL_ROUTE', 'unavailable');
}

function claimedDraftRun(id: string) {
  const now = new Date();
  return {
    id,
    transportId: 'transport-unit',
    threadId: `thread-${id}`,
    triggerMessageId: `message-${id}`,
    runKind: 'candidate_draft' as const,
    idempotencyKey: `candidate-draft:${id}`,
    modelId: 'gpt-6-luna',
    promptVersion: 'draft-v1',
    promptHash: null,
    admissionSnapshotId: null,
    admissionSnapshotHash: null,
    readRequest: null,
    readResultRef: null,
    readResult: null,
    readResultExpiresAt: null,
    state: 'claimed' as const,
    executorLane: 'default' as const,
    workItemId: null,
    priority: 0,
    claimOwner: aiWorkerOwnerId('default'),
    claimToken: `tok-${id}`,
    attempts: 0,
    nextRunAt: null,
    mastraTraceId: null,
    mastraScorerId: null,
    generationId: null,
    metrics: null,
    lastError: null,
    failureClass: null,
    claimedAt: now,
    heartbeatAt: now,
    deadlineAt: new Date(now.getTime() + 120_000),
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('ai worker missing Azure draft config', () => {
  beforeEach(() => {
    stubWorkerEnv();
    ledger.claimNextAiRun.mockReset();
    ledger.markAiRunRunning.mockReset().mockResolvedValue(true);
    ledger.markAiRunDeadLetter.mockReset().mockResolvedValue({ id: 'dead' });
    ledger.markAiRunRetry.mockReset();
    ledger.heartbeatAiRun.mockReset().mockResolvedValue(true);
    dbMocks.getDb.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records a missing-Azure draft claim failed and keeps the worker loop going', async () => {
    const first = claimedDraftRun('run-a');
    const second = claimedDraftRun('run-b');
    const rows = [first, second];
    let selectCount = 0;
    dbMocks.getDb.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [rows[Math.min(selectCount++, rows.length - 1)]],
          }),
        }),
      }),
    });
    ledger.claimNextAiRun.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await expect(runAiWorkerOnce()).resolves.toBe(true);
    await expect(runAiWorkerOnce()).resolves.toBe(true);

    expect(ledger.markAiRunDeadLetter).toHaveBeenCalledTimes(2);
    expect(ledger.markAiRunDeadLetter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        runId: 'run-a',
        lastError: expect.stringMatching(/AZURE_OPENAI_BASE_URL|AZURE_FOUNDRY_API_KEY/),
      }),
    );
    expect(ledger.markAiRunDeadLetter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runId: 'run-b',
        lastError: expect.stringMatching(/AZURE_OPENAI_BASE_URL|AZURE_FOUNDRY_API_KEY/),
      }),
    );
    expect(ledger.markAiRunRetry).not.toHaveBeenCalled();
  });
});

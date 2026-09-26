/**
 * Purpose-built, model-free read harness.  By default it exercises a
 * synthetic typed handler only; live execution must be explicitly wired by a
 * trusted caller that supplies the normal audited runtime and property lock.
 */
import { createHash } from 'node:crypto';
import { executeReadToolRun, type ReadExecutionContext } from '../src/hms/read-service.js';

export type HarnessEvaluationMode = 'fixture' | 'current-state' | 'historical-replay' | 'future-shadow';

export type ReadHarnessReceipt = {
  evaluationMode: HarnessEvaluationMode;
  inputDigest: string;
  outputStatus: string;
  modelId: 'not_applicable';
  readResultRef: string;
  source: 'synthetic';
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function runHmsReadToolHarness(options: {
  evaluationMode?: HarnessEvaluationMode;
  context?: ReadExecutionContext;
  resultRef?: string;
} = {}): Promise<ReadHarnessReceipt> {
  const context = options.context ?? {
    transportId: 'harness-transport',
    mailboxId: 'harness-mailbox',
    threadId: 'harness-thread',
    triggerMessageId: 'harness-trigger',
    propertyCode: 'HRCEN',
    parentRef: 'harness-parent',
    branchId: 'guest_stay_search',
    releaseId: 'harness-release',
    requester: {
      authorizationId: 'harness-auth',
      transportId: 'harness-transport',
      threadId: 'harness-thread',
      triggerMessageId: 'harness-trigger',
      allowedClaimKinds: ['reservation_summary'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    handlers: {
      findReservation: async () => ({
        status: 'ok' as const,
        data: {
          confirmation: 'SYNTHETIC-CONFIRMATION',
          label: 'reservation match',
          referenceKind: 'confirmation' as const,
          status: 'Confirmed',
          arrival: '2026-09-10',
          departure: '2026-09-12',
          roomType: 'STD',
        },
        evidenceRef: 'harness-evidence',
        observedAt: '2026-09-07T12:00:00.000Z',
        expiresAt: '2026-09-07T12:05:00.000Z',
      }),
    },
  } satisfies ReadExecutionContext;
  const request = { toolId: 'hms_find_reservation' as const, candidateId: 'synthetic-candidate' };
  const receipt = await executeReadToolRun({
    runKind: 'read_tool',
    executorLane: 'hms',
    draftingEnabled: false,
    request,
    context,
    resultRef: options.resultRef ?? 'harness-result',
  });
  return {
    evaluationMode: options.evaluationMode ?? 'fixture',
    inputDigest: digest(request),
    outputStatus: receipt.result.status,
    modelId: receipt.modelId,
    readResultRef: receipt.readResultRef,
    source: 'synthetic',
  };
}

if (process.argv[1]?.endsWith('hms-read-tool-harness.ts')) {
  runHmsReadToolHarness()
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

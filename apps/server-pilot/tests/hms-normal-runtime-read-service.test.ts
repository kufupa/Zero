import { describe, expect, it, vi } from 'vitest';
import {
  executeReadToolRun,
  NOT_APPLICABLE_MODEL_ID,
} from '../src/hms/read-service.js';

describe('U8 normal runtime read_tool path', () => {
  it('executes with drafting disabled and records a typed receipt without initializing a model', async () => {
    const model = vi.fn();
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      modelFactory: model,
      request: {
        toolId: 'hms_find_reservation',
        candidateId: 'candidate-1',
      },
      context: {
        transportId: 'transport-centurion',
        mailboxId: 'mailbox-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'message-1',
        propertyCode: 'HRCEN',
        parentRef: 'parent-1',
        branchId: 'guest_stay_search',
        releaseId: 'release-1',
        requester: {
          authorizationId: 'auth-1',
          transportId: 'transport-centurion',
          threadId: 'thread-1',
          triggerMessageId: 'message-1',
          allowedClaimKinds: ['reservation_summary'],
          expiresAt: '2026-09-07T12:05:00.000Z',
        },
        signal: new AbortController().signal,
        budget: { total: 0, limit: 3 },
        now: () => new Date('2026-09-07T12:00:00.000Z'),
        handlers: {
          findReservation: async () => ({
            status: 'not_found' as const,
            data: {
              confirmation: null,
              label: null,
              referenceKind: null,
              status: null,
              arrival: null,
              departure: null,
              roomType: null,
            },
            evidenceRef: 'evidence-1',
            observedAt: '2026-09-07T12:00:00.000Z',
            expiresAt: '2026-09-07T12:05:00.000Z',
          }),
        },
      },
      resultRef: 'read-result-1',
    });

    expect(model).not.toHaveBeenCalled();
    expect(receipt.modelId).toBe(NOT_APPLICABLE_MODEL_ID);
    expect(receipt.readResultRef).toBe('read-result-1');
    expect(receipt.result.status).toBe('not_found');
  });
});

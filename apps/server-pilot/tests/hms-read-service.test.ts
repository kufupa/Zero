import { describe, expect, it, vi } from 'vitest';
import {
  executeRead,
  readExecutionContextSchema,
  readRequestSchema,
  type ReadExecutionContext,
} from '../src/hms/read-service.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';

function context(overrides: Partial<ReadExecutionContext> = {}): ReadExecutionContext {
  return {
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
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    ...overrides,
  };
}

describe('U8 typed read service', () => {
  it('rejects arbitrary dispatcher keys and model-facing browser inputs', () => {
    expect(() =>
      readRequestSchema.parse({
        toolId: 'hms_find_reservation',
        candidateId: 'candidate-1',
        url: 'https://pms.invalid',
      }),
    ).toThrow();
    expect(() =>
      readExecutionContextSchema.parse({
        ...context(),
        selector: '#anything',
      }),
    ).toThrow();
  });

  it('dispatches a real typed reservation lookup without a model or stub result', async () => {
    const lookup = vi.fn(async () => ({
      status: 'ok' as const,
      data: {
        confirmation: 'CONF-100',
        label: 'CONF-100',
        referenceKind: 'confirmation' as const,
        status: 'Confirmed',
        arrival: '2026-09-10',
        departure: '2026-09-12',
        roomType: 'STD',
      },
      evidenceRef: 'evidence-1',
      observedAt: '2026-09-07T12:00:00.000Z',
      expiresAt: '2026-09-07T12:05:00.000Z',
    }));
    const result = await executeRead(
      context({ handlers: { findReservation: lookup } }),
      { toolId: 'hms_find_reservation', candidateId: 'candidate-1' },
    );

    expect(lookup).toHaveBeenCalledOnce();
    expect(result.status).toBe('ok');
    expect(result.data).toMatchObject({
      matches: [expect.objectContaining({ reservationRef: expect.any(String) })],
    });
    expect(result).not.toHaveProperty('unresolvedFields');
    expect(readResultSchema.parse(result)).toEqual(result);
  });

  it('rejects expired request authorization before invoking a handler', async () => {
    const lookup = vi.fn();
    await expect(
      executeRead(
        context({
          requester: {
            ...context().requester,
            expiresAt: '2026-09-07T11:59:59.000Z',
          },
          handlers: { findReservation: lookup },
        }),
        { toolId: 'hms_find_reservation', candidateId: 'candidate-1' },
      ),
    ).rejects.toMatchObject({ code: 'READ_AUTHORIZATION_EXPIRED' });
    expect(lookup).not.toHaveBeenCalled();
  });
});

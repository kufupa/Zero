import { folioReadRequestSchema, readResultSchema } from '../../../../../apps/server-pilot/src/hms/read-service-contracts.js';
import { executeRead, type ReadExecutionContext } from '../../../../../apps/server-pilot/src/hms/read-service.js';
import { describe, expect, it, vi } from 'vitest';

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
      allowedClaimKinds: ['folio_deposit_summary'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 3 },
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    ...overrides,
  };
}

function unavailableFolioResult() {
  return readResultSchema.parse({
    toolId: 'hms_read_folio',
    schemaVersion: 'hms-folio/1',
    status: 'manual_required',
    data: null,
    completeness: 'unknown',
    unavailableSections: [{ section: 'transactions', reasonCode: 'SOURCE_UNAVAILABLE' }],
    scopeRef: 'reservation-1',
    evidence: [],
    page: null,
    issues: [{ code: 'SOURCE_UNAVAILABLE', retryable: false, safeNextAction: 'manual_review' }],
  });
}

describe('bounded folio request paging', () => {
  it('keeps legacy requests free of paging fields and bounds new fields', () => {
    const legacy = folioReadRequestSchema.parse({
      toolId: 'hms_read_folio',
      reservationRef: 'reservation-1',
      candidateId: 'candidate-1',
      sections: ['transactions'],
    });
    expect(legacy).not.toHaveProperty('limit');
    expect(legacy).not.toHaveProperty('cursor');

    expect(
      folioReadRequestSchema.parse({
        ...legacy,
        limit: 1,
        cursor: 'a'.repeat(1000),
      }),
    ).toMatchObject({ limit: 1, cursor: 'a'.repeat(1000) });
    expect(() => folioReadRequestSchema.parse({ ...legacy, limit: 0 })).toThrow();
    expect(() => folioReadRequestSchema.parse({ ...legacy, limit: 51 })).toThrow();
    expect(() => folioReadRequestSchema.parse({ ...legacy, cursor: 'a'.repeat(1001) })).toThrow();
  });

  it('passes optional paging to the handler without changing the old call shape', async () => {
    const handler = vi.fn(async () => unavailableFolioResult());
    const base = {
      toolId: 'hms_read_folio' as const,
      reservationRef: 'reservation-1',
      candidateId: 'candidate-1',
      sections: ['transactions'] as const,
    };

    await executeRead(context({ handlers: { readFolio: handler } }), base);
    expect(handler).toHaveBeenLastCalledWith({
      candidateId: base.candidateId,
      reservationRef: base.reservationRef,
      sections: base.sections,
    });

    await executeRead(context({ handlers: { readFolio: handler } }), {
      ...base,
      limit: 50,
      cursor: 'next-1',
    });
    expect(handler).toHaveBeenLastCalledWith({
      candidateId: base.candidateId,
      reservationRef: base.reservationRef,
      sections: base.sections,
      limit: 50,
      cursor: 'next-1',
    });
  });
});

import { executeRead, type ReadExecutionContext } from '../src/hms/read-service.js';
import { describe, expect, it, vi } from 'vitest';

const observedAt = '2026-09-08T12:00:00.000Z';
const expiresAt = '2026-09-08T12:05:00.000Z';

function known<T>(value: T) {
  return {
    state: 'known' as const,
    value,
    data: value,
    evidenceRef: 'u15-evidence',
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function unknown(reasonCode: 'SURFACE_UNPROVEN' | 'NOT_APPLICABLE' = 'SURFACE_UNPROVEN') {
  return {
    state: 'unknown' as const,
    value: null,
    data: null,
    reasonCode,
    evidenceRef: 'u15-evidence',
    observedAt,
    sourceUpdatedAt: null,
    expiresAt,
  };
}

function result(toolId: string, data: unknown, status: 'ok' | 'partial' = 'ok') {
  return {
    toolId,
    schemaVersion: 'u15-context/1',
    status,
    data,
    completeness: status === 'ok' ? 'complete' : 'partial',
    unavailableSections: [],
    scopeRef: 'u15-scope',
    evidence: [
      {
        evidenceRef: 'u15-evidence',
        sourceSystem: 'hms' as const,
        sourceSurface: 'u15-tested-source',
        requestBranchId: 'u15-context',
        observedAt,
        sourceUpdatedAt: null,
        expiresAt,
        scopeVerified: true,
        artifactRef: null,
      },
    ],
    page: null,
    issues: [],
  };
}

function context(overrides: Partial<ReadExecutionContext> = {}): ReadExecutionContext {
  return {
    transportId: 'transport-u15',
    mailboxId: 'mailbox-u15',
    threadId: 'thread-u15',
    triggerMessageId: 'message-u15',
    propertyCode: 'HRCEN',
    parentRef: 'parent-u15',
    branchId: 'u15-context',
    releaseId: 'release-u15',
    requester: {
      authorizationId: 'auth-u15',
      transportId: 'transport-u15',
      threadId: 'thread-u15',
      triggerMessageId: 'message-u15',
      allowedClaimKinds: ['company_billing_summary', 'group_status', 'event_status'],
      expiresAt,
    },
    signal: new AbortController().signal,
    budget: { total: 0, limit: 4 },
    now: () => new Date(observedAt),
    ...overrides,
  };
}

describe('U15 normal model-free context reads', () => {
  it('returns linked company identity while keeping unproved billing terms unknown', async () => {
    const readCompany = vi.fn(async () =>
      result(
        'hms_company_account_read',
        {
          companyRef: known('company-u15'),
          billingMode: unknown(),
          paymentTerms: unknown(),
          requiredPaperwork: unknown(),
          billingReference: unknown(),
          arAccountRef: unknown(),
          organizationRef: known('organization-u15'),
          agencyRef: unknown('NOT_APPLICABLE'),
          negotiatedRateRefs: unknown(),
          restrictions: unknown(),
          audience: known('staff_only'),
        },
        'partial',
      ),
    );

    const read = await executeRead(
      context({
        handlers: { readCompanyAccount: readCompany },
      }),
      { toolId: 'hms_company_account_read', reservationRef: 'reservation-u15' } as never,
    );

    expect(readCompany).toHaveBeenCalledWith({ reservationRef: 'reservation-u15' });
    expect(read.status).toBe('partial');
    expect(read.data).toMatchObject({
      organizationRef: { state: 'known', value: 'organization-u15' },
      billingMode: { state: 'unknown', value: null },
    });
  });

  it('keeps tentative group dates useful while aggregate counts and delegates remain independent sections', async () => {
    const readGroup = vi.fn(async () =>
      result(
        'hms_group_block_read',
        {
          summary: {
            state: 'available',
            data: {
              groupRef: known('group-u15'),
              status: known('tentative'),
              startDate: known('2026-10-01'),
              endDate: known('2026-10-04'),
              releasePolicy: unknown(),
              billingRef: unknown(),
            },
            completeness: 'complete',
            issues: [],
          },
          blocks: {
            state: 'unavailable',
            data: null,
            reasonCode: 'SURFACE_UNPROVEN',
            issues: [],
          },
          delegates: {
            state: 'available',
            data: {
              items: [
                {
                  delegateRef: 'delegate-1',
                  reservationRef: known('reservation-1'),
                  arrival: known('2026-10-01'),
                  departure: known('2026-10-04'),
                  roomQuantity: known(2),
                  roomType: known('STD'),
                  billingRef: unknown(),
                },
                {
                  delegateRef: 'delegate-2',
                  reservationRef: known('reservation-2'),
                  arrival: known('2026-10-01'),
                  departure: known('2026-10-04'),
                  roomQuantity: known(1),
                  roomType: known('DLX'),
                  billingRef: unknown(),
                },
              ],
              page: { returnedCount: 2, hasMore: false, nextCursor: null },
            },
            completeness: 'complete',
            issues: [],
          },
        },
        'partial',
      ),
    );

    const read = await executeRead(context({ handlers: { readGroupBlock: readGroup } }), {
      toolId: 'hms_group_block_read',
      groupRef: 'group-u15',
      sections: ['summary', 'blocks', 'delegates'],
    } as never);

    expect(read.status).toBe('partial');
    expect(read.data).toMatchObject({
      summary: { data: { status: { value: 'tentative' } } },
      blocks: { state: 'unavailable', reasonCode: 'SURFACE_UNPROVEN' },
    });
    expect(
      (read.data as { delegates: { data: { items: unknown[] } } }).delegates.data.items,
    ).toHaveLength(2);
    expect(readGroup).toHaveBeenCalledWith({
      groupRef: 'group-u15',
      sections: ['summary', 'blocks', 'delegates'],
    });
  });

  it('preserves exact HMS event source and distinct deposit facts', async () => {
    const readEvent = vi.fn(async () =>
      result('hms_event_read', {
        eventRef: known('event-u15'),
        source: known('hms'),
        masterRef: unknown(),
        status: known('confirmed'),
        startAt: known('2026-10-10T08:00:00.000Z'),
        endAt: known('2026-10-10T17:00:00.000Z'),
        layout: known('theatre'),
        persons: known(80),
        setup: known('60 minutes'),
        lines: { state: 'unavailable', data: null, reasonCode: 'SURFACE_UNPROVEN', issues: [] },
        quotedAmount: unknown(),
        contractedAmount: unknown(),
        depositAmount: known({
          amount: '5000.00',
          currency: 'ZAR',
          basis: 'per_stay',
          taxTreatment: 'unknown',
        }),
        depositReceived: known({
          amount: '1000.00',
          currency: 'ZAR',
          basis: 'per_stay',
          taxTreatment: 'unknown',
        }),
        depositDueDate: known('2026-10-03'),
        linkedRefs: unknown(),
      }),
    );

    const read = await executeRead(context({ handlers: { readEvent: readEvent } }), {
      toolId: 'hms_event_read',
      eventRef: 'event-u15',
    } as never);

    expect(read.status).toBe('ok');
    expect(read.data).toMatchObject({
      source: { value: 'hms' },
      depositAmount: { value: { amount: '5000.00' } },
      depositReceived: { value: { amount: '1000.00' } },
      depositDueDate: { value: '2026-10-03' },
    });
    expect(read.data).not.toHaveProperty('settledAmount');
    expect(readEvent).toHaveBeenCalledWith({ eventRef: 'event-u15' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  executeRead,
  readExecutionContextSchema,
  readRequestSchema,
  type ReadExecutionContext,
} from '../src/hms/read-service.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';
import { createReservationContextFacade } from '../src/hms/reservation-context-facade.js';
import { normalizeQuoteRequest } from '../src/hms/quote-request-normalization.js';
import { syntheticQuoteReferenceAuthority } from './helpers/quote-reference-authority.js';

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
      allowedClaimKinds: [
        'reservation_summary',
        'folio_deposit_summary',
        'quote_stay_summary',
        'company_billing_summary',
        'group_status',
        'event_status',
        'notes_trace_observation',
        'document_metadata',
        'sent_email_audit',
        'document_bytes',
      ],
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

  it('keeps the find-issued reservation ref bound to the supplied facade for detail', async () => {
    const facade = createReservationContextFacade({
      now: () => new Date('2026-09-07T12:00:00.000Z'),
      lookup: async () => ({
        status: 'matched' as const,
        row: {
          confirmationNumber: 'CONF-100',
          externalReference: null,
          guestName: 'Guest',
          arrivalDate: '2026-09-10',
          departureDate: '2026-09-12',
          reservationStatus: 'Confirmed',
          roomType: 'STD',
          ratePlan: null,
        },
        evidenceRef: 'evidence-facade',
        observedAt: '2026-09-07T12:00:00.000Z',
        expiresAt: '2026-09-07T12:05:00.000Z',
      }),
      readContext: async (_input, row) => ({
        core: { status: 'available', confirmation: row.confirmationNumber },
        stay: { status: 'available', arrival: row.arrivalDate, departure: row.departureDate },
      }),
    });
    const first = await executeRead(
      context({ reservationFacade: facade }),
      { toolId: 'hms_find_reservation', candidateId: 'candidate-1' },
    );
    const reservationRef = first.data.matches[0]?.reservationRef;
    expect(reservationRef).toEqual(expect.any(String));
    const second = await executeRead(
      context({ reservationFacade: facade, budget: { total: 0, limit: 3 } }),
      {
        toolId: 'hms_read_reservation',
        reservationRef: reservationRef!,
        sections: ['core', 'stay'],
        detail: 'detail',
      },
    );
    expect(second.status).toBe('ok');
    expect(second.scopeRef).toBe(reservationRef);
  });

  it('returns typed unavailable for PMS document bytes until a genuine provider is bound', async () => {
    const result = await executeRead(
      context({
        branchId: 'document_bytes',
        requester: {
          ...context().requester,
          allowedClaimKinds: ['document_bytes'],
        },
      }),
      {
        toolId: 'hms_read_document',
        candidateId: 'candidate-1',
        documentRef: 'doc-1',
        format: 'bytes',
      },
    );
    expect(result.status).toBe('manual_required');
    expect(result.unavailableSections).toEqual([
      { section: 'document_bytes', reasonCode: 'SOURCE_UNAVAILABLE' },
    ]);
    expect(readResultSchema.parse(result)).toEqual(result);
  });

  it('returns typed unavailable for every included provider-backed branch when unbound', async () => {
    const normalized = normalizeQuoteRequest(
      {
        arrival: '2026-09-10',
        departure: '2026-09-12',
        rooms: [
          { quantity: 1, adultsPerRoom: 2, childAges: [], roomTypeRef: 'STD', ratePlanRef: 'BAR' },
        ],
        currency: 'ZAR',
      },
      { referenceAuthority: syntheticQuoteReferenceAuthority },
    );
    expect(normalized.status).toBe('ready');
    if (normalized.status !== 'ready') return;

    const cases = [
      {
        request: { toolId: 'hms_find_reservation', candidateId: 'candidate-1' },
        section: 'reservation_lookup',
        scopeRef: 'candidate-1',
      },
      {
        request: {
          toolId: 'hms_read_reservation',
          reservationRef: 'reservation-1',
          sections: ['core'],
          detail: 'summary',
        },
        section: 'reservation_context',
        scopeRef: 'reservation-1',
      },
      {
        request: {
          toolId: 'hms_read_folio',
          reservationRef: 'reservation-1',
          candidateId: 'candidate-1',
          sections: ['balance'],
        },
        section: 'folio',
        scopeRef: 'reservation-1',
      },
      {
        request: {
          toolId: 'hms_quote_stay',
          quoteRequestRef: normalized.request.quoteRequestRef,
          quoteRequest: normalized.request,
          detail: 'summary',
        },
        section: 'quote',
        scopeRef: normalized.request.quoteRequestRef,
      },
      {
        request: { toolId: 'hms_company_account_read', reservationRef: 'reservation-1' },
        section: 'company_account',
        scopeRef: 'reservation-1',
      },
      {
        request: { toolId: 'hms_group_block_read', groupRef: 'group-1', sections: ['summary'] },
        section: 'group_block',
        scopeRef: 'group-1',
      },
      {
        request: { toolId: 'hms_event_read', eventRef: 'event-1' },
        section: 'event',
        scopeRef: 'event-1',
      },
      {
        request: {
          toolId: 'hms_read_notes_traces',
          resourceRef: 'reservation-1',
          states: ['open'],
          limit: 20,
          audience: 'staff',
        },
        section: 'notes_traces',
        scopeRef: 'reservation-1',
      },
    ] as const;

    for (const item of cases) {
      const result = await executeRead(context(), item.request as never);
      expect(result).toMatchObject({
        toolId: item.request.toolId,
        status: 'manual_required',
        data: null,
        completeness: 'unknown',
        scopeRef: item.scopeRef,
        unavailableSections: [{ section: item.section, reasonCode: 'SOURCE_UNAVAILABLE' }],
      });
      expect(readResultSchema.parse(result)).toEqual(result);
    }
  });
});

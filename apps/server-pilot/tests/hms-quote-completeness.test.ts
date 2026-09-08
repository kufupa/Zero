import {
  assertPersistedReadAdmissionIssuer,
  issueReadAdmission,
  persistReadAdmissionIssuer,
} from '../src/hms/read-admission.js';
import { readRequestSchema, executeReadToolRun } from '../src/hms/read-service.js';
import { normalizeQuoteRequest } from '../src/hms/quote-request-normalization.js';
import { quoteStayReadDataSchema } from '../src/hms/quote-stay-contract.js';
import { readResultSchema } from '../src/hms/read-service-contracts.js';
import { describe, expect, it } from 'vitest';

describe('trusted quote completeness contract', () => {
  it('preserves signed observed availability without treating it as sold out', () => {
    const parsed = quoteStayReadDataSchema.parse({
      requestRef: 'quote_stay_request:abc123',
      arrival: '2026-09-10',
      departure: '2026-09-12',
      rooms: [
        {
          quantity: 1,
          adultsPerRoom: 2,
          childAges: [],
          roomTypeRef: 'STD',
          ratePlanRef: 'BAR',
        },
      ],
      currency: 'ZAR',
      coveredNights: ['2026-09-10', '2026-09-11'],
      missingNights: [],
      continuousStay: true,
      roomMoveRequired: false,
      displayRateSum: {
        amount: '2450.00',
        currency: 'ZAR',
        basis: 'per_room_per_night',
        taxTreatment: 'unknown',
      },
      nightlyObservations: [
        {
          date: '2026-09-10',
          roomType: 'STD',
          availableCount: -2,
          ratePlan: 'BAR',
          displayedAmount: '1200.00',
          currency: 'ZAR',
          rateBasis: 'nightly',
          restrictions: ['negative-observed-overbooking'],
          observedAt: '2026-09-08T00:00:00.000Z',
        },
        {
          date: '2026-09-11',
          roomType: 'STD',
          availableCount: 2,
          ratePlan: 'BAR',
          displayedAmount: '1250.00',
          currency: 'ZAR',
          rateBasis: 'nightly',
          restrictions: ['none'],
          observedAt: '2026-09-08T00:00:00.000Z',
        },
      ],
      bookable: false,
      stayTotal: null,
      occupancyPriced: false,
      held: false,
      unresolvedInputs: ['negative_observed_overbooking'],
      requestedRooms: 1,
    });

    expect(parsed.nightlyObservations[0]?.availableCount).toBe(-2);
    expect(parsed.bookable).toBe(false);
    expect(parsed.stayTotal).toBeNull();
    expect(parsed.occupancyPriced).toBe(false);
    expect(parsed.held).toBe(false);
    expect(parsed.unresolvedInputs).toContain('negative_observed_overbooking');
  });

  it('binds a normalized producer request to the typed read receipt without a model', async () => {
    const normalized = normalizeQuoteRequest({
      arrival: '2026-09-10',
      departure: '2026-09-12',
      rooms: [
        { quantity: 1, adultsPerRoom: 2, childAges: [], roomTypeRef: 'STD', ratePlanRef: 'BAR' },
      ],
      currency: 'ZAR',
    });
    expect(normalized.status).toBe('ready');
    if (normalized.status !== 'ready') return;

    const request = readRequestSchema.parse({
      toolId: 'hms_quote_stay',
      quoteRequestRef: normalized.request.quoteRequestRef,
      quoteRequest: normalized.request,
      detail: 'detail',
    });
    expect(request).toMatchObject({
      toolId: 'hms_quote_stay',
      quoteRequestRef: normalized.request.quoteRequestRef,
    });

    const resultData = quoteStayReadDataSchema.parse({
      requestRef: normalized.request.quoteRequestRef,
      arrival: normalized.request.arrival,
      departure: normalized.request.departure,
      rooms: normalized.request.rooms,
      currency: normalized.request.currency,
      coveredNights: normalized.request.coveredNights,
      missingNights: [],
      continuousStay: true,
      roomMoveRequired: false,
      nightlyObservations: [],
      bookable: false,
      stayTotal: null,
      occupancyPriced: false,
      held: false,
      unresolvedInputs: ['no_observed_nights'],
      requestedRooms: 1,
    });
    const receipt = await executeReadToolRun({
      runKind: 'read_tool',
      executorLane: 'hms',
      draftingEnabled: false,
      request,
      context: {
        transportId: 'transport-centurion',
        mailboxId: 'mailbox-centurion',
        threadId: 'thread-quote',
        triggerMessageId: 'message-quote',
        propertyCode: 'HRCEN',
        parentRef: 'parent-quote',
        branchId: 'quote_availability_search',
        releaseId: 'release-quote',
        requester: {
          authorizationId: 'auth-quote',
          transportId: 'transport-centurion',
          threadId: 'thread-quote',
          triggerMessageId: 'message-quote',
          allowedClaimKinds: ['quote_stay_summary'],
          expiresAt: '2026-09-08T00:05:00.000Z',
        },
        signal: new AbortController().signal,
        budget: { total: 0, limit: 3 },
        now: () => new Date('2026-09-08T00:00:00.000Z'),
        handlers: {
          quoteStay: async () => ({
            toolId: 'hms_quote_stay',
            schemaVersion: 'quote-stay/2',
            status: 'partial',
            data: resultData,
            completeness: 'partial',
            unavailableSections: [],
            scopeRef: normalized.request.quoteRequestRef,
            evidence: [],
            page: null,
            issues: [],
          }),
        },
      },
      resultRef: 'read-result-quote',
    });

    expect(receipt.modelId).toBe('not_applicable');
    expect(readResultSchema.parse(receipt.result)).toEqual(receipt.result);
    expect(receipt.result).toMatchObject({
      toolId: 'hms_quote_stay',
      scopeRef: normalized.request.quoteRequestRef,
      data: { bookable: false, stayTotal: null, held: false },
    });
  });

  it('mints a quote-only admission and preserves the exact request digest through issuer proof', () => {
    const normalized = normalizeQuoteRequest({
      arrival: '2026-09-10',
      departure: '2026-09-12',
      rooms: [
        { quantity: 1, adultsPerRoom: 2, childAges: [], roomTypeRef: 'STD', ratePlanRef: 'BAR' },
      ],
      currency: 'ZAR',
    });
    expect(normalized.status).toBe('ready');
    if (normalized.status !== 'ready') return;
    const issued = issueReadAdmission({
      source: {
        userId: 'user-quote',
        mailboxAccessId: 'access-quote',
        transportId: 'transport-centurion',
        threadId: 'thread-quote',
        triggerMessageId: 'message-quote',
        releaseId: 'release-quote',
        requestBranchId: 'quote_availability_search',
      },
      now: new Date('2026-09-08T00:00:00.000Z'),
      toolId: 'hms_quote_stay',
      quoteRequest: normalized.request,
      detail: 'detail',
    });
    expect(issued.admission.reservationRef).toBeNull();
    expect(issued.readRequest).toMatchObject({
      toolId: 'hms_quote_stay',
      quoteRequestRef: normalized.request.quoteRequestRef,
      detail: 'detail',
    });
    const persisted = persistReadAdmissionIssuer(issued.issuer);
    expect(
      assertPersistedReadAdmissionIssuer({
        issuer: persisted,
        request: issued.readRequest,
        run: {
          transportId: 'transport-centurion',
          threadId: 'thread-quote',
          triggerMessageId: 'message-quote',
        },
        expectedUserId: 'user-quote',
        expectedMailboxAccessId: 'access-quote',
        expectedToolId: 'hms_quote_stay',
      }),
    ).toEqual(persisted);
  });
});

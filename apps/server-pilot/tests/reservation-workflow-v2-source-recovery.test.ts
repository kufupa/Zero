import {
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  type ReservationWorkflowV2Draft,
} from '../src/ai/reservation-workflow-v2-contract.js';
import { recoverReservationWorkflowV2SourceFields } from '../src/ai/reservation-workflow-v2-source-recovery.js';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const now = '2026-11-14T00:00:00.000Z';
const messageId = 'message-1';
const generationId = '00000000-0000-4000-8000-000000000002';
const requestRoot = '/proposal/content/requests/quote-1/body';
const occupancyPath = `${requestRoot}/groups/0/occupancy`;
const sourceRef = `src_${createHash('sha256').update(`${messageId}\u001fmessage\u001f${messageId}`).digest('hex').slice(0, 12)}`;

function staleDraft(): ReservationWorkflowV2Draft {
  return {
    contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
    schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
    workItemId: '00000000-0000-4000-8000-000000000001',
    transportId: 'transport-1',
    propertyCode: 'HRCEN',
    source: { threadId: 'thread-1', messageId, sourceHash: 'a'.repeat(64), arrivedAt: now },
    generationId,
    revision: 7,
    status: 'ready',
    extractionGenerationId: generationId,
    extraction: {
      requests: [
        {
          id: 'quote-1',
          kind: 'quote',
          requestText: { raw: 'Quote one room', value: 'Quote one room', sourceRefs: [sourceRef] },
          dates: [],
          occupancy: [],
          guests: [],
          parties: [],
          confirmationHints: [],
          roomTypeHints: [],
          rateHints: [],
          mealPlanHints: [],
          serviceHints: [],
          documentRefs: [],
          documentHints: [],
        },
      ],
      issues: [],
    },
    proposal: {
      schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
      content: {
        requests: [
          {
            id: 'quote-1',
            requestText: 'Quote one room',
            sourceRefs: [sourceRef],
            serviceRefs: [],
            documentRefs: [],
            kind: 'quote',
            body: {
              groups: [
                {
                  id: 'group-1',
                  arrival: '2027-02-01',
                  departure: '2027-02-02',
                  quantity: 1,
                  mealPlan: 'bb',
                  requestedMealPlan: 'bb',
                  roomCodes: ['STD'],
                  ratePlan: 'BAR',
                  occupancy: {
                    scope: 'unresolved',
                    adults: null,
                    childCount: null,
                    childAges: null,
                  },
                  priceObservationRefs: [],
                },
              ],
              parties: { organization: null, bookingAgency: null },
              salesStrategy: null,
              client: { attention: null, email: null, telephone: null },
              requestedMoney: [],
              notes: null,
              outputIntent: { artifacts: ['email_quote'], evidenceRefs: [] },
              provisionalBookingRequested: false,
            },
          },
        ],
        services: [],
        documents: [],
      },
      annotations: [],
      issues: [],
      sourceClaims: [],
      lookupResultRefs: [],
    },
    observations: [
      {
        ref: 'obs-source',
        generationId,
        kind: 'source',
        status: 'complete',
        observedAt: now,
        propertyCode: 'HRCEN',
        sourceMessageId: messageId,
        sourceRefs: [sourceRef],
        criteria: {},
        coverage: { complete: true, notes: [] },
        result: { textCoverageComplete: true },
      },
    ],
    fieldReviewRequirements: {},
    staffReviews: {},
    operationResults: [],
    fieldOverrides: {
      [occupancyPath]: {
        state: 'set',
        value: { scope: 'per_room', adults: 3, childCount: null, childAges: null },
        updatedAt: now,
      },
      [`${requestRoot}/groups/0/ratePlan`]: { state: 'set', value: 'CORP', updatedAt: now },
    },
    errors: [],
    prefill: {
      status: 'complete',
      attemptId: null,
      attemptCount: 1,
      startedAt: now,
      finishedAt: now,
    },
  };
}

describe('reservation workflow v2 source recovery', () => {
  it('clears a policy guess copied into a parent edit without changing staff choices', () => {
    const draft = staleDraft();
    const request = draft.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.groups[0]!.occupancy = { scope: 'per_room', adults: 1, childCount: 0, childAges: [] };
    draft.proposal.annotations = ['adults', 'childCount', 'childAges'].map(field => ({
      path: `${occupancyPath}/${field}`, basis: 'policy', evidenceRefs: [],
    }));
    draft.fieldOverrides[occupancyPath] = { state: 'set', value: { scope: 'per_room', adults: 3, childCount: 0, childAges: [] }, updatedAt: now };
    const recovered = recoverReservationWorkflowV2SourceFields(draft);
    expect(recovered?.draft.fieldOverrides[occupancyPath]?.value).toEqual({
      scope: 'per_room', adults: 3, childCount: null, childAges: null,
    });
    expect(recovered?.draft.fieldOverrides[`${requestRoot}/groups/0/ratePlan`]?.value).toBe('CORP');
  });

  it('does not invent Quote children or replace staff occupancy and rate choices', () => {
    const recovered = recoverReservationWorkflowV2SourceFields(staleDraft());
    expect(recovered).toBeNull();
  });

  it('does not invent children after a partial failed prefill', () => {
    const draft = staleDraft();
    draft.status = 'partial';
    draft.prefill = { ...draft.prefill!, status: 'failed' };

    const recovered = recoverReservationWorkflowV2SourceFields(draft);

    expect(recovered).toBeNull();
  });
});

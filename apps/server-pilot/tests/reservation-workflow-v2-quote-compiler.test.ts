import {
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  type ReservationWorkflowV2Draft,
} from '../src/ai/reservation-workflow-v2-contract.js';
import { compileReservationWorkflowV2Quote } from '../src/ai/reservation-workflow-v2-quote.js';
import { describe, expect, it } from 'vitest';

const requestRoot = '/proposal/content/requests/quote-1/body';
const groupRoot = `${requestRoot}/groups/0`;
const now = '2026-11-14T00:00:00.000Z';
const candidateRef = 'organization-candidate-1';

function draft(): ReservationWorkflowV2Draft {
  return {
    contractVersion: RESERVATION_WORKFLOW_V2_VERSION,
    schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
    workItemId: '00000000-0000-4000-8000-000000000001',
    transportId: 'transport-1',
    propertyCode: 'HRCEN',
    source: {
      threadId: 'thread-1',
      messageId: 'message-1',
      sourceHash: 'a'.repeat(64),
      arrivedAt: now,
    },
    generationId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    status: 'ready',
    proposal: {
      schemaVersion: RESERVATION_PREFILL_SCHEMA_VERSION,
      content: {
        requests: [
          {
            id: 'quote-1',
            requestText: 'Quote one room',
            sourceRefs: [],
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
                  ratePlan: 'bad code',
                  occupancy: { scope: 'per_room', adults: 1, childCount: null, childAges: null },
                  priceObservationRefs: [],
                },
              ],
              parties: {
                organization: {
                  name: 'Acme Ltd',
                  candidateRefs: [candidateRef],
                  suggestedRef: null,
                },
                bookingAgency: null,
              },
              salesStrategy: 'BAR',
              client: { attention: 'Buyer', email: 'buyer@example.com', telephone: null },
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
        ref: candidateRef,
        generationId: '00000000-0000-4000-8000-000000000002',
        kind: 'party_candidate',
        status: 'complete',
        observedAt: now,
        propertyCode: 'HRCEN',
        sourceMessageId: 'message-1',
        sourceRefs: [],
        criteria: { workflow: 'quote', requestId: 'quote-1', role: 'organization' },
        coverage: { complete: true, notes: [] },
        result: { nativeId: 'ORG-1', name: 'Acme Ltd' },
      },
    ],
    fieldReviewRequirements: {},
    staffReviews: {},
    operationResults: [],
    fieldOverrides: {},
    errors: [],
  };
}

function compile(value: ReservationWorkflowV2Draft, execute = false) {
  const request = value.proposal.content.requests[0];
  if (!request || request.kind !== 'quote') throw new Error('quote fixture missing');
  return compileReservationWorkflowV2Quote(value, request, execute);
}

function fields(value: ReservationWorkflowV2Draft, execute = false): string[] {
  const result = compile(value, execute);
  return result.status === 'ok' ? [] : result.fields;
}

describe('reservation workflow v2 Quote compiler staff edits', () => {
  it('clears child count and ages blocker when staff sets zero children', () => {
    const value = draft();
    expect(fields(value)).toContain(
      `${groupRoot}/occupancy/childCount:known_child_count_and_ages_required`,
    );

    value.fieldOverrides[`${groupRoot}/occupancy/childCount`] = {
      state: 'set',
      value: 0,
      updatedAt: now,
    };
    value.fieldOverrides[`${groupRoot}/occupancy/childAges`] = {
      state: 'set',
      value: [],
      updatedAt: now,
    };

    expect(
      fields(value).some((field) => field.endsWith(':known_child_count_and_ages_required')),
    ).toBe(false);
  });

  it('clears organization selection blockers after native selection and staff acceptance', () => {
    const value = draft();
    expect(fields(value)).toContain('organization_selection_required');

    const selectionPath = `${requestRoot}/parties/organization/nativeSelectionRef`;
    value.fieldOverrides[selectionPath] = { state: 'set', value: candidateRef, updatedAt: now };
    expect(fields(value, true)).toContain('organization_requires_staff_acceptance');

    for (const path of [
      `${requestRoot}/parties/organization`,
      `${requestRoot}/parties/organization/name`,
      selectionPath,
    ]) {
      value.staffReviews[path] = { status: 'accepted', note: null, at: now };
    }

    expect(fields(value, true)).not.toContain('organization_selection_required');
    expect(fields(value, true)).not.toContain('organization_requires_staff_acceptance');
  });

  it('clears native rate code blocker when staff sets a valid rate plan', () => {
    const value = draft();
    expect(fields(value)).toContain(`${groupRoot}/ratePlan:native_rate_code_required`);

    value.fieldOverrides[`${groupRoot}/ratePlan`] = { state: 'set', value: 'BAR', updatedAt: now };

    expect(fields(value)).not.toContain(`${groupRoot}/ratePlan:native_rate_code_required`);
  });
});

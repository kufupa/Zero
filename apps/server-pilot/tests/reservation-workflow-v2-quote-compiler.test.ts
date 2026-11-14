import {
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  type ReservationWorkflowV2Draft,
} from '../src/ai/reservation-workflow-v2-contract.js';
import { compileReservationWorkflowV2Quote, reservationWorkflowV2QuoteLookup,
  reservationWorkflowV2QuotePrepare } from '../src/ai/reservation-workflow-v2-quote.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ load: vi.fn(), append: vi.fn(), record: vi.fn(), run: vi.fn() }));
vi.mock('../src/ai/reservation-workflow-v2-state.js', async (original) => ({
  ...(await original<typeof import('../src/ai/reservation-workflow-v2-state.js')>()),
  getReservationWorkflowV2Draft: backend.load, appendReservationWorkflowV2Observation: backend.append,
  recordReservationWorkflowV2Result: backend.record,
}));
vi.mock('../src/ai/staff-quote-run.js', async (original) => ({
  ...(await original<typeof import('../src/ai/staff-quote-run.js')>()), runStaffQuote: backend.run,
}));

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
    // O8: bare code plus mounted picker path for Review/focus.
    expect(fields(value)).toContain(`${requestRoot}/parties/organization`);

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

  it('surfaces focus paths for poisoned org/agency names (Pass4/Pass6 fail modes)', () => {
    // Former workItemIds: 7940e9dc… unknown_staff; e497761d… name_unresolved; 6678481f… agency.
    const orgPath = `${requestRoot}/parties/organization`;
    const agencyPath = `${requestRoot}/parties/bookingAgency`;

    const unknownStaff = draft();
    unknownStaff.fieldOverrides[`${orgPath}/name`] = { state: 'unknown', updatedAt: now };
    expect(fields(unknownStaff)).toEqual(expect.arrayContaining([
      'organization_unknown_staff_value',
      orgPath,
    ]));

    const unresolved = draft();
    unresolved.proposal.content.requests[0]!.body.parties.organization = {
      name: null, candidateRefs: [], suggestedRef: null,
    } as never;
    expect(fields(unresolved)).toEqual(expect.arrayContaining([
      'organization_name_unresolved',
      orgPath,
    ]));

    const agency = draft();
    agency.proposal.content.requests[0]!.body.parties.bookingAgency = {
      name: 'Poisoned Agency', candidateRefs: [], suggestedRef: null,
    } as never;
    expect(fields(agency)).toEqual(expect.arrayContaining([
      'bookingAgency_selection_required',
      agencyPath,
    ]));
  });

  it('clears native rate code blocker when staff sets a valid rate plan', () => {
    const value = draft();
    expect(fields(value)).toContain(`${groupRoot}/ratePlan:native_rate_code_required`);

    value.fieldOverrides[`${groupRoot}/ratePlan`] = { state: 'set', value: 'BAR', updatedAt: now };

    expect(fields(value)).not.toContain(`${groupRoot}/ratePlan:native_rate_code_required`);
  });
});

describe('quote receipt reuse and property propagation', () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

  function readyDraft() {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.parties.organization = null;
    request.body.groups[0]!.ratePlan = 'BAR';
    request.body.groups[0]!.occupancy.childCount = 0;
    request.body.groups[0]!.occupancy.childAges = [];
    value.observations = [];
    return value;
  }

  function setup(value: ReservationWorkflowV2Draft) {
    backend.load.mockResolvedValue({ status: 'ok', draft: value, revision: value.revision, seq: 0 });
    backend.record.mockResolvedValue({ status: 'ok' });
    backend.append.mockResolvedValue({ status: 'ok', revision: value.revision, seq: 0 });
    backend.run.mockRejectedValue(new Error('native_unavailable'));
    return { ctx: { db: {} as never, transport: { id: value.transportId }, user: { id: 'user' },
      property: { propertyCode: value.propertyCode } },
      input: { workItemId: value.workItemId, source: value.source, requestId: 'quote-1', expectedRevision: value.revision, expectedSeq: 0 } };
  }

  it('keeps HRDAVS through lookup and the pricing dispatch', async () => {
    const value = readyDraft();
    value.propertyCode = 'HRDAVS';
    value.transportId = 'transport-davinci';
    vi.stubEnv('HMS_DAVINCI_MAKE_QUOTE', 'on');
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAVS', '/tmp/suites.json');
    const { ctx, input } = setup(value);
    await reservationWorkflowV2QuoteLookup(ctx, input);
    expect(backend.run).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ transportId: 'transport-davinci', propertyCode: 'HRDAVS' }), expect.anything(), expect.anything());
  });

  it('reuses shortage evidence after review-only edits but rechecks a pricing override', async () => {
    const value = readyDraft();
    const compiled = compile(value);
    if (compiled.status !== 'ok') throw new Error(`invalid fixture: ${compiled.issue}`);
    const freshUntil = new Date(Date.now() + 60_000).toISOString();
    value.observations.push({ ref: 'shortage', generationId: value.generationId, kind: 'rate_availability',
      status: 'failed', observedAt: new Date().toISOString(), propertyCode: value.propertyCode,
      sourceMessageId: value.source.messageId, sourceRefs: [], coverage: { complete: false, notes: [] },
      criteria: { workflow: 'quote', requestId: 'quote-1', sourceHash: value.source.sourceHash, inputDigest: compiled.inputDigest },
      result: { inputOverrides: {}, requestedGroups: compiled.input.groups, failureCode: 'native_quote_insufficient_inventory',
        failureKind: 'proven_shortage', sourceHash: value.source.sourceHash, inputDigest: compiled.inputDigest,
        availabilityTruncated: false, freshUntil, shortfall: { roomCode: 'STD', roomLabel: 'Standard', date: '2027-02-01', demand: 1, supply: 0 },
        quoteDiagnostics: [{ kind: 'requested', contextMatchesSelection: true, availabilityTruncated: false, freshUntil,
          availabilityBoard: [{ groupId: 'group-1', roomCode: 'STD', rateCode: 'BAR', mealPlan: 'bb',
            availability: 'unavailable', roomsLeft: 0, coverage: { search: 'complete', requiredFacts: 'complete' },
            nightCoverage: { complete: true, expected: 1, observed: 1 },
            nightly: [{ date: '2027-02-01', availableCount: 0, requestedCount: 1, stockStatus: 'sold' }] }] }] } });
    const { ctx, input } = setup(value);
    for (const path of [`${requestRoot}/guestNames/0`, `${groupRoot}/guestNames/0`, `${groupRoot}/requestedRoomDescription`]) {
      value.fieldOverrides[path] = { state: 'set', value: 'review context', updatedAt: now };
    }
    await expect(reservationWorkflowV2QuotePrepare(ctx, input)).resolves.toMatchObject({ status: 'prepared', observationRef: 'shortage' });
    expect(backend.run).not.toHaveBeenCalled();
    value.fieldOverrides[`${groupRoot}/ratePlan`] = { state: 'set', value: 'BAR', updatedAt: now };
    await reservationWorkflowV2QuotePrepare(ctx, input);
    expect(backend.run).toHaveBeenCalledOnce();
  });
});

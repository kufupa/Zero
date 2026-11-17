import {
  RESERVATION_PREFILL_SCHEMA_VERSION,
  RESERVATION_WORKFLOW_V2_VERSION,
  type ReservationWorkflowV2Draft,
} from '../src/ai/reservation-workflow-v2-contract.js';
import { compileReservationWorkflowV2Quote, reservationWorkflowV2QuoteExecute, reservationWorkflowV2QuoteLookup,
  reservationWorkflowV2QuotePrepare } from '../src/ai/reservation-workflow-v2-quote.js';
import { quoteExtrasReadiness, quoteInputOverrides, quoteRateNeedsConfirmation } from '../src/ai/reservation-workflow-v2-quote-readiness.js';
import { changeReservationWorkflowV2Rows } from '../src/ai/reservation-workflow-v2-draft-commands.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { getQuotePackageOutput } from '../../mail/lib/reservation-workflow/quote-output.js';
import { buildStaffProposalFacts } from '../src/ai/staff-quote-workflow.js';
import { deriveAuthorizedExtraLines } from '../src/quote-proposal/quote-lines.js';

const backend = vi.hoisted(() => ({ load: vi.fn(), append: vi.fn(), record: vi.fn(), run: vi.fn(), mutate: vi.fn() }));
vi.mock('../src/ai/reservation-workflow-v2-state.js', async (original) => ({
  ...(await original<typeof import('../src/ai/reservation-workflow-v2-state.js')>()),
  getReservationWorkflowV2Draft: backend.load, appendReservationWorkflowV2Observation: backend.append,
  recordReservationWorkflowV2Result: backend.record, withLockedV2DraftMutation: backend.mutate,
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
  it('splits alternative dates and meals without losing groups, extras or confirmed counts', async () => {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    const original = request.body.groups[0]!;
    original.occupancy = { scope: 'per_room', adults: 1, childCount: 0, childAges: [] };
    request.body.groups = [
      original,
      { ...structuredClone(original), id: 'group-2', arrival: '2027-02-03', departure: '2027-02-04' },
      { ...structuredClone(original), id: 'group-3', mealPlan: 'room_only', requestedMealPlan: 'room_only' },
      { ...structuredClone(original), id: 'group-4', arrival: '2027-02-03', departure: '2027-02-04', mealPlan: 'room_only', requestedMealPlan: 'room_only' },
    ];
    const composition = { kind: 'scenarios' as const, scenarios: [
      { id: 'breakfast', label: 'Breakfast', groupIds: ['group-1', 'group-2'], evidenceRefs: [] },
      { id: 'room-only', label: 'Room only', groupIds: ['group-3', 'group-4'], evidenceRefs: [] },
    ] };
    value.fieldOverrides[`${requestRoot}/quoteComposition`] = { state: 'set', value: composition, updatedAt: now };
    value.proposal.issues.push({ path: '/requests/quote-1/body/groups', kind: 'quote_rate_code_not_projected',
      explanation: 'Choose the named rate.', evidenceRefs: [] });
    value.fieldOverrides[`${groupRoot}/ratePlan`] = { state: 'set', value: 'BAR', updatedAt: now };
    value.fieldOverrides[`${requestRoot}/groups/1/ratePlan`] = { state: 'none', updatedAt: now };
    request.body.requestedMoney = [
      { id: 'dinner', amount: '200', currency: 'ZAR', unit: 'per_person_per_night', scope: 'overall', targetRefs: [], sourceRefs: [], staffAllowanceType: 'dinner' },
      { id: 'transfer', amount: '100', currency: 'ZAR', unit: 'per_trip', scope: 'overall', targetRefs: [], sourceRefs: [], staffAllowanceType: 'airport_transfer' },
      { id: 'target', amount: '30', currency: 'ZAR', unit: 'per_person_per_night', scope: 'per_target', targetRefs: ['group-2', 'group-4'], sourceRefs: [], staffAllowanceType: 'lunch' },
    ];
    for (const field of ['adults', 'childCount'] as const) {
      const path = `${groupRoot}/occupancy/${field}`;
      value.proposal.annotations.push({ path, basis: 'policy', evidenceRefs: [] });
      value.fieldOverrides[path] = { state: 'set', value: original.occupancy[field], updatedAt: now };
    }
    value.proposal.issues.push({ path: `${groupRoot}/quantity`, kind: 'quote_guest_room_count_inferred', explanation: 'Confirm rooms.', evidenceRefs: [] });
    value.fieldOverrides[`${groupRoot}/quantity`] = { state: 'set', value: 1, updatedAt: now };
    backend.mutate.mockImplementation(async (_ctx, _input, mutation) => mutation.apply(value, {}));
    const result = await changeReservationWorkflowV2Rows({} as never, { kind: 'split_quote_dates', requestId: request.id } as never) as unknown as { draft: ReservationWorkflowV2Draft } | null;
    expect(result).not.toBeNull();
    const children = result!.draft.proposal.content.requests.filter(row => row.kind === 'quote');
    expect(children).toHaveLength(4);
    expect(children.flatMap(row => row.kind === 'quote' ? row.body.groups.map(group => group.id) : []).sort()).toEqual(['group-1', 'group-2', 'group-3', 'group-4']);
    for (const child of children) {
      if (child.kind !== 'quote') throw new Error('quote fixture missing');
      expect(child.body.quoteFamily?.members).toHaveLength(4);
      expect(child.body.requestedMoney.filter(row => row.id === 'dinner')).toHaveLength(1);
      expect(child.body.requestedMoney.some(row => row.id === 'target')).toBe(['group-2', 'group-4'].includes(child.body.groups[0]!.id));
      expect(quoteRateNeedsConfirmation(result!.draft, child.id, 0)).toBe(['group-3', 'group-4'].includes(child.body.groups[0]!.id));
    }
    const family = children[0]!.kind === 'quote' ? children[0]!.body.quoteFamily : undefined;
    expect(family?.composition?.kind).toBe('scenarios');
    if (family?.composition?.kind !== 'scenarios') throw new Error('scenario grouping missing');
    expect(family.composition.options.map(option => [option.label, option.requestIds.length])).toEqual([
      ['Breakfast', 2], ['Room only', 2],
    ]);
    expect(children.flatMap(row => row.kind === 'quote' ? row.body.requestedMoney.filter(item => item.id === 'transfer') : [])).toHaveLength(2);
    for (const path of [`${groupRoot}/occupancy/adults`, `${groupRoot}/occupancy/childCount`, `${groupRoot}/quantity`])
      expect(result!.draft.fieldOverrides[path]?.state).toBe('set');
    const edited = result!.draft;
    const second = edited.proposal.content.requests.find(row => row.kind === 'quote' && row.body.groups[0]?.id === 'group-2');
    if (!second || second.kind !== 'quote') throw new Error('split option missing');
    second.body.groups.push({ ...structuredClone(second.body.groups[0]!), id: 'group-5', arrival: '2027-02-05', departure: '2027-02-06' });
    backend.mutate.mockImplementation(async (_ctx, _input, mutation) => mutation.apply(edited, {}));
    const resplit = await changeReservationWorkflowV2Rows({} as never, { kind: 'split_quote_dates', requestId: second.id } as never) as unknown as { draft: ReservationWorkflowV2Draft } | null;
    expect(resplit).not.toBeNull();
    const options = resplit!.draft.proposal.content.requests.filter(row => row.kind === 'quote');
    expect(options).toHaveLength(5);
    expect(options.every(row => row.kind === 'quote' && row.body.quoteFamily?.members.length === 5)).toBe(true);
    const resplitFamily = options[0]!.kind === 'quote' ? options[0]!.body.quoteFamily : undefined;
    expect(resplitFamily?.composition?.kind === 'scenarios' && resplitFamily.composition.options.map(option => option.requestIds.length)).toEqual([3, 2]);
    backend.mutate.mockImplementation(async (_ctx, _input, mutation) => mutation.apply(resplit!.draft, {}));
    const removed = await changeReservationWorkflowV2Rows({} as never, { kind: 'remove_action', requestId: second.id } as never) as unknown as { draft: ReservationWorkflowV2Draft } | null;
    expect(removed?.draft.proposal.content.requests.filter(row => row.kind === 'quote')).toHaveLength(0);
  });

  it('does not duplicate an ambiguous once-per-person extra across date runs', async () => {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.groups.push({ ...structuredClone(request.body.groups[0]!), id: 'group-2',
      arrival: '2027-02-03', departure: '2027-02-04' });
    const extra = { id: 'dinner', amount: '200', currency: 'ZAR', unit: 'per_person' as const,
      scope: 'overall' as const, targetRefs: [], sourceRefs: [], staffAllowanceType: 'dinner' as const };
    request.body.requestedMoney = [extra];
    backend.mutate.mockImplementation(async (_ctx, _input, mutation) => mutation.apply(value, {}));
    expect(await changeReservationWorkflowV2Rows({} as never, { kind: 'split_quote_dates', requestId: request.id } as never)).toBeNull();
    request.body.requestedMoney = [];
    const split = await changeReservationWorkflowV2Rows({} as never, { kind: 'split_quote_dates', requestId: request.id } as never) as unknown as { draft: ReservationWorkflowV2Draft } | null;
    expect(split).not.toBeNull();
    const siblings = split!.draft.proposal.content.requests.filter(row => row.kind === 'quote');
    const first = siblings[0]!, second = siblings[1]!;
    if (first.kind !== 'quote' || second.kind !== 'quote') throw new Error('split fixture missing');
    first.body.requestedMoney.push(extra);
    second.body.groups.push({ ...structuredClone(second.body.groups[0]!), id: 'group-3',
      arrival: '2027-02-05', departure: '2027-02-06' });
    backend.mutate.mockImplementation(async (_ctx, _input, mutation) => mutation.apply(split!.draft, {}));
    expect(await changeReservationWorkflowV2Rows({} as never, { kind: 'split_quote_dates', requestId: second.id } as never)).toBeNull();
  });

  it('requires staff to choose or explicitly fall back from a named rate', () => {
    const value = draft();
    value.proposal.issues.push({ path: '/requests/quote-1/body/groups', kind: 'quote_rate_code_not_projected',
      explanation: 'Choose the named rate.', evidenceRefs: [] });
    const path = `${groupRoot}/ratePlan`;
    expect(fields(value, true)).toContain(`${path}:rate_hint_confirmation_required`);
    value.staffReviews[path] = { status: 'accepted', note: null, at: now };
    expect(fields(value, true)).toContain(`${path}:rate_hint_confirmation_required`);
    value.fieldOverrides[path] = { state: 'none', updatedAt: now };
    expect(fields(value, true)).not.toContain(`${path}:rate_hint_confirmation_required`);
    value.fieldOverrides[path] = { state: 'set', value: 'GOV', updatedAt: now };
    expect(fields(value, true)).not.toContain(`${path}:rate_hint_confirmation_required`);
  });

  it('requires an explicit choice for old guest-count policy guesses', () => {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.groups[0]!.occupancy = { scope: 'per_room', adults: 1, childCount: 0, childAges: [] };
    const adults = `${groupRoot}/occupancy/adults`, children = `${groupRoot}/occupancy/childCount`;
    for (const path of [adults, children]) {
      value.proposal.annotations.push({ path, basis: 'policy', evidenceRefs: [] });
      value.staffReviews[path] = { status: 'accepted', note: null, at: now };
    }
    expect(fields(value)).toContain(`${adults}:guest_count_confirmation_required`);
    expect(fields(value)).toContain(`${children}:guest_count_confirmation_required`);
    value.fieldOverrides[adults] = { state: 'set', value: 1, updatedAt: now };
    value.fieldOverrides[children] = { state: 'set', value: 0, updatedAt: now };
    expect(fields(value).some(field => field.endsWith(':guest_count_confirmation_required'))).toBe(false);
  });

  it('does not treat a bulk review as confirmation of an inferred room count', () => {
    const value = draft();
    const path = `${groupRoot}/quantity`;
    value.proposal.issues.push({ path, kind: 'quote_guest_room_count_inferred', explanation: 'Confirm rooms.', evidenceRefs: [] });
    value.staffReviews[path] = { status: 'accepted', note: null, at: now };
    expect(fields(value)).toContain(`${path}:room_count_confirmation_required`);
    value.fieldOverrides[path] = { state: 'set', value: 1, updatedAt: now };
    expect(fields(value)).not.toContain(`${path}:room_count_confirmation_required`);
  });

  it('does not add different meal options until staff chooses how groups relate', () => {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.groups.push({ ...structuredClone(request.body.groups[0]!), id: 'group-2', mealPlan: 'room_only', requestedMealPlan: 'room_only' });
    const path = `${requestRoot}/quoteComposition`;
    expect(fields(value)).toContain(`${path}:quote_relationship_unresolved`);
    value.fieldOverrides[path] = { state: 'set', updatedAt: now, value: { kind: 'additive' } };
    expect(fields(value)).not.toContain(`${path}:quote_relationship_unresolved`);
    value.fieldOverrides[path] = { state: 'set', updatedAt: now, value: { kind: 'scenarios', scenarios: [
      { id: 'bb', label: 'Breakfast', groupIds: ['group-1'], evidenceRefs: [] },
      { id: 'ro', label: 'Room only', groupIds: ['group-2'], evidenceRefs: [] },
    ] } };
    expect(fields(value)).toContain(`${path}:separate_quote_options_required`);
    value.fieldOverrides[path] = { state: 'set', updatedAt: now, value: { kind: 'scenarios', scenarios: [
      { id: 'bb', label: 'Breakfast', groupIds: ['group-1'], evidenceRefs: [] },
      { id: 'ro', label: 'Room only', groupIds: ['group-1'], evidenceRefs: [] },
    ] } };
    expect(fields(value)).toContain(`${path}:quote_relationship_unresolved`);
  });

  it('requires explicit approval of the exact prepared extras', () => {
    const value = draft();
    const observation = { ...value.observations[0]!, ref: 'price-1', kind: 'rate_availability' as const,
      criteria: { workflow: 'quote', requestId: 'quote-1' }, result: { extrasReviewItems: ['Confirm dinner'] } };
    value.observations.push(observation);
    value.operationResults.push({ id: 'prepared-1', generationId: value.generationId, requestId: 'quote-1', allocationId: null,
      workflow: 'quote', status: 'prepared', draftRevision: value.revision, observationRefs: [observation.ref], updatedAt: now, summary: null });
    value.staffReviews[requestRoot] = { status: 'accepted', note: null, at: now };
    expect(quoteExtrasReadiness(value, 'quote-1', observation.ref)).toHaveLength(1);
    value.staffReviews[requestRoot] = { status: 'accepted', note: 'quote-extras:prepared-1:price-1', at: now };
    expect(quoteExtrasReadiness(value, 'quote-1', observation.ref)).toHaveLength(0);
    value.operationResults[0]!.id = 'prepared-2';
    expect(quoteExtrasReadiness(value, 'quote-1', observation.ref)).toHaveLength(1);
  });

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

  it('accepts a name without a selection and reviews an explicitly selected organization', () => {
    const value = draft();
    const request = value.proposal.content.requests[0]!;
    if (request.kind !== 'quote') throw new Error('quote fixture missing');
    request.body.groups[0]!.ratePlan = 'BAR';
    request.body.groups[0]!.occupancy.childCount = 0;
    request.body.groups[0]!.occupancy.childAges = [];
    if (!request.body.parties.organization || !('suggestedRef' in request.body.parties.organization)) throw new Error('organization fixture missing');
    request.body.parties.organization.suggestedRef = candidateRef;
    const namePath = `${requestRoot}/parties/organization/name`;
    const selectionPath = `${requestRoot}/parties/organization/nativeSelectionRef`;
    value.fieldOverrides[namePath] = { state: 'set', value: 'Manual Ltd', updatedAt: now };
    value.fieldOverrides[selectionPath] = { state: 'unknown', updatedAt: now };
    const unbound = compile(value);
    expect(unbound.status).toBe('ok');
    if (unbound.status !== 'ok') throw new Error('name-only quote did not compile');
    expect(unbound.input.organization).toBe('Manual Ltd');
    expect(unbound.input.parties).toBeUndefined();

    value.fieldOverrides[namePath] = { state: 'set', value: 'Acme Ltd', updatedAt: now };
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
    expect(fields(agency)).not.toContain('bookingAgency_selection_required');
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

describe('complete multi-date quote delivery', () => {
  afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  async function preparedDates(withLunch = false, overlapQuantity?: number,
    inventoryCase?: 'unknown_pool' | 'unknown_pool_different_room' | 'disagreement') {
    const value = draft();
    const first = value.proposal.content.requests[0]!;
    if (first.kind !== 'quote') throw new Error('quote fixture missing');
    first.body.parties.organization = null;
    first.body.outputIntent.artifacts = ['email_quote', 'pdf_quote', 'xlsx_quote'];
    first.body.groups[0] = { ...first.body.groups[0]!, quantity: overlapQuantity ?? 2,
      ...(overlapQuantity ? { departure: '2027-02-03' } : {}), mealPlan: 'bb', requestedMealPlan: 'bb',
      roomCodes: ['SKNG'], ratePlan: 'BAR', occupancy: { scope: 'per_room', adults: 1, childCount: 0, childAges: [] } };
    const second = structuredClone(first);
    second.id = 'quote-2';
    second.body.groups[0] = { ...second.body.groups[0]!, id: 'group-2',
      arrival: overlapQuantity ? '2027-02-02' : '2027-02-04', departure: overlapQuantity ? '2027-02-03' : '2027-02-05' };
    if (inventoryCase === 'unknown_pool_different_room') second.body.groups[0].roomCodes = ['STQN'];
    if (withLunch) second.body.requestedMoney = [{ id: 'lunch', amount: '50', currency: 'ZAR', unit: 'per_person_per_night',
      scope: 'overall', targetRefs: [], sourceRefs: [], staffAllowanceType: 'lunch' }];
    const members = [{ requestId: first.id, label: 'First stay' }, { requestId: second.id, label: 'Second stay' }];
    first.body.quoteFamily = { id: 'family', label: members[0]!.label, members, composition: { kind: 'additive' } };
    second.body.quoteFamily = { id: 'family', label: members[1]!.label, members, composition: { kind: 'additive' } };
    value.proposal.content.requests.push(second);
    value.observations = [];
    for (const request of [first, second]) {
      const root = `/proposal/content/requests/${request.id}/body`;
      for (const field of ['provisionalBookingRequested', 'groups/0/arrival', 'groups/0/departure', 'groups/0/quantity',
        'groups/0/mealPlan', 'groups/0/occupancy/adults', 'groups/0/occupancy/childCount', 'groups/0/roomCodes',
        'groups/0/ratePlan', 'salesStrategy', 'client/attention', 'client/email', 'requestedMoney/0/staffAllowanceType',
        'requestedMoney/0/amount', 'requestedMoney/0/currency', 'requestedMoney/0/unit', 'requestedMoney/0/scope', 'requestedMoney/0/targetRefs'])
        value.staffReviews[`${root}/${field}`] = { status: 'accepted', note: null, at: now };
      const compiled = compileReservationWorkflowV2Quote(value, request, true);
      if (compiled.status !== 'ok') throw new Error(`invalid quote fixture: ${compiled.issue} ${JSON.stringify(compiled.fields)}`);
      const group = request.body.groups[0]!;
      const revision = await syntheticRevision(request.id === first.id && overlapQuantity ? ['100.00', '100.00'] :
        [request.id === first.id ? '100.00' : '150.00'], 'Bed & Breakfast R', group.roomCodes?.[0] ?? 'SKNG',
        new Date().toISOString(), group.arrival!, 'synthetic-auth', group.id, group.quantity!,
        inventoryCase === 'unknown_pool' || inventoryCase === 'unknown_pool_different_room' ? { building: null, extraUnprofiledOption: true } :
          inventoryCase === 'disagreement' && request.id === second.id ? { inventory: 4 } : undefined);
      const facts = buildStaffProposalFacts(compiled.input, { messageId: value.source.messageId, sourceHash: value.source.sourceHash },
        { authorizationId: revision.authorizationId }, revision).facts;
      const extraTotal = facts ? deriveAuthorizedExtraLines(revision, facts).reduce((sum, line) => sum + line.totalMinor, 0) : 0;
      const ref = `price-${request.id}`;
      value.observations.push({ ref, generationId: value.generationId, kind: 'rate_availability', status: 'complete',
        observedAt: new Date().toISOString(), propertyCode: value.propertyCode, sourceMessageId: value.source.messageId,
        sourceRefs: [], coverage: { complete: true, notes: [] },
        criteria: { workflow: 'quote', requestId: request.id, sourceHash: value.source.sourceHash, inputDigest: compiled.inputDigest },
        result: { sourceHash: value.source.sourceHash, inputOverrides: quoteInputOverrides(value, request.id),
          freshUntil: new Date(Date.now() + 300_000).toISOString(), revision, facts, totalMinor: revision.totalMinor + extraTotal,
          currency: revision.currency, nativeInputDigest: `native-${request.id}`, workflowRunId: `run-${request.id}` } });
      value.operationResults.push({ id: `prepared-${request.id}`, generationId: value.generationId, requestId: request.id,
        allocationId: null, workflow: 'quote', status: 'prepared', draftRevision: value.revision,
        observationRefs: [ref], updatedAt: now, summary: null });
    }
    backend.load.mockResolvedValue({ status: 'ok', draft: value, revision: value.revision, seq: 0 });
    backend.record.mockResolvedValue({ status: 'ok' });
    backend.append.mockResolvedValue({ status: 'ok', revision: value.revision, seq: 0 });
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: 'Staff', email: 'staff@example.test' }] }) }) }) };
    const ctx = { db, transport: { id: value.transportId }, user: { id: 'user' }, property: { propertyCode: value.propertyCode } };
    const input = { workItemId: value.workItemId, source: value.source, requestId: first.id, expectedRevision: value.revision,
      expectedSeq: 0, go: true, idempotencyKey: '00000000-0000-4000-8000-000000000099' };
    vi.stubEnv('GOTENBERG_URL', 'http://local.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.4 synthetic', { headers: { 'content-type': 'application/pdf' } })));
    return { value, ctx, input };
  }

  it('generates one cover, PDF and Excel for all dates and rejects a stale sibling in the pane', async () => {
    const { value, ctx, input } = await preparedDates();
    const result = await reservationWorkflowV2QuoteExecute(ctx as never, input as never);
    expect(result.status).toBe('succeeded');
    const cover = result.coverEmail as { to: string; body: string };
    expect(cover.to).toBe('buyer@example.com');
    expect(cover.body).toContain('1-2 February 2027');
    expect(cover.body).toContain('4-5 February 2027');
    expect(cover.body).toContain('ZAR 500.00');
    const artifacts = result.artifacts as Array<{ kind: string; totalMinor: number; bytesBase64: string }>;
    expect(artifacts.map(artifact => artifact.kind).sort()).toEqual(['pdf_quote', 'xlsx_quote']);
    expect(artifacts.every(artifact => artifact.totalMinor === 50_000)).toBe(true);
    expect(Buffer.from(artifacts.find(artifact => artifact.kind === 'pdf_quote')!.bytesBase64, 'base64').toString()).toMatch(/^%PDF-/);
    const sheet = new TextDecoder().decode(unzipSync(Buffer.from(artifacts.find(artifact => artifact.kind === 'xlsx_quote')!.bytesBase64, 'base64'))['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('1-2 February 2027');
    expect(sheet).toContain('4-5 February 2027');
    const totalCell = sheet.match(/<c r="H31"[^>]*>[\s\S]*?<\/c>/)?.[0] ?? '';
    expect(Number(totalCell.match(/<v>([^<]+)<\/v>/)?.[1])).toBe(500);
    const document = backend.append.mock.calls.at(-1)![1].observation;
    const operation = backend.record.mock.calls.at(-1)![1].result;
    value.observations.push(document); value.operationResults.push(operation);
    const source = { mailboxId: value.transportId, propertyId: value.propertyCode, threadId: value.source.threadId,
      messageId: value.source.messageId, sourceHash: value.source.sourceHash };
    const snapshot = { sourceMessageId: value.source.messageId, session: { revision: value.revision, draft: value } };
    expect(getQuotePackageOutput(source as never, snapshot as never, input.requestId)?.artifacts).toHaveLength(2);
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never)).resolves.toMatchObject({ status: 'succeeded' });
    const receipt = (document.result as { optionReceipt: { inventoryValidation?: string } }).optionReceipt;
    delete receipt.inventoryValidation;
    expect(getQuotePackageOutput(source as never, snapshot as never, input.requestId)).toBeNull();
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never))
      .resolves.toMatchObject({ status: 'needs_prepare', issue: 'quote_output_no_longer_current' });
    receipt.inventoryValidation = 'joint-inventory/v1';
    (value.observations[1]!.result as { freshUntil: string }).freshUntil = new Date(Date.now() - 1).toISOString();
    expect(getQuotePackageOutput(source as never, snapshot as never, input.requestId)).toBeNull();
  });

  it('refuses to generate a partial option when one date lacks a current price', async () => {
    const { value, ctx, input } = await preparedDates();
    value.operationResults.pop();
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never))
      .resolves.toMatchObject({ status: 'needs_prepare', issue: 'complete_current_quote_option_required' });
    expect(backend.append).not.toHaveBeenCalled();
  });

  it('refuses a combined option when overlapping groups exceed the same room inventory', async () => {
    const { ctx, input } = await preparedDates(false, 4);
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never))
      .resolves.toMatchObject({ status: 'needs_input', issue: 'quote_option_joint_inventory_unavailable' });
    expect(backend.append).not.toHaveBeenCalled();
  });

  it('generates overlapping groups when their combined room inventory is sufficient', async () => {
    const { ctx, input } = await preparedDates(false, 2);
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never)).resolves.toMatchObject({ status: 'succeeded' });
  });

  it.each(['unknown_pool', 'unknown_pool_different_room', 'disagreement'] as const)('requires review when overlapping inventory has %s', async inventoryCase => {
    const { ctx, input } = await preparedDates(false, 2, inventoryCase);
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never))
      .resolves.toMatchObject({ status: 'needs_input', issue: 'quote_option_joint_inventory_unavailable' });
    expect(backend.append).not.toHaveBeenCalled();
  });

  it('includes a lunch charge and its explanation when only one date needs it', async () => {
    const { ctx, input } = await preparedDates(true);
    const result = await reservationWorkflowV2QuoteExecute(ctx as never, input as never);
    expect(result.status).toBe('succeeded');
    const cover = result.coverEmail as { body: string };
    expect(cover.body).toContain('Lunch');
    expect(cover.body).toContain('Lunch is quoted as a separate extra.');
    expect(cover.body).toContain('Total: ZAR 600.00');
    const artifacts = result.artifacts as Array<{ totalMinor: number }>;
    expect(artifacts.every(artifact => artifact.totalMinor === 60_000)).toBe(true);
  });

  it('does not publish generated files if a sibling price expires during conversion', async () => {
    const { value, ctx, input } = await preparedDates();
    vi.stubGlobal('fetch', vi.fn(async () => {
      (value.observations[1]!.result as { freshUntil: string }).freshUntil = new Date(Date.now() - 1).toISOString();
      return new Response('%PDF-1.4 synthetic', { headers: { 'content-type': 'application/pdf' } });
    }));
    await expect(reservationWorkflowV2QuoteExecute(ctx as never, input as never))
      .resolves.toMatchObject({ status: 'failed', issue: 'quote_artifact_generation_failed' });
    const document = backend.append.mock.calls.at(-1)![1].observation;
    expect(document.status).toBe('failed');
    expect(document.result.artifacts).toEqual([]);
  });
});

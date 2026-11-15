import type { ReservationWorkflowV2Extraction } from '../src/ai/reservation-workflow-v2-contract.js';
import { reservationWorkflowV2DraftSchema, reservationWorkflowV2ObservationSchema } from '../src/ai/reservation-workflow-v2-contract.js';
import { randomUUID } from 'node:crypto';
import * as memoryLeads from '../src/ai/reservation-workflow-v2-native-leads.js';
import * as bookingCodes from '../src/ai/booking-code-rules.js';
import { createReservationWorkflowV2CandidateReader, runReservationWorkflowV2Prefill } from '../src/ai/reservation-workflow-v2-prefill.js';
import * as cloudStay from '../src/ai/hms-cloud-saved-stay-find.js';
import * as paneStaySave from '../src/ai/pane-stay-save.js';
import * as hmsService from '../src/hms/hms-service.js';
import * as paneLookup from '../src/ai/pane-stay-lookup.js';
import * as nativeCatalog from '../src/ai/native-catalog-lookup.js';
import { lookupNativeParty } from '../src/ai/reservation-workflow-v2-native-party.js';
import { hmsReadTargetForProperty } from '../src/hms/hms-read-target.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import type { SyncedQuoteAttachment } from '../src/ai/quote-workflow-synced-selection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  latencyMs: 1,
  estimatedCostUsd: 0,
  rateTableVersion: 'test',
};

function projectionFixture(
  extraction: (sourceRef: string, attachmentRef?: string) => ReservationWorkflowV2Extraction,
  synthesis?: (sourceRef: string) => Record<string, unknown>,
): ModelAdapter {
  let call = 0;
  return {
    async invoke(input) {
      call += 1;
      const evidence = (JSON.parse(input.userPrompt) as { evidence: Array<{ ref: string; kind: string }> }).evidence;
      const sourceRef = evidence[0]!.ref;
      return {
        modelId: 'projection-fixture',
        output: call === 1 ? extraction(sourceRef, evidence.find(row => row.kind === 'attachment_text')?.ref) : (synthesis?.(sourceRef) ?? {}),
        usage,
      };
    },
  };
}

async function project(
  extraction: (sourceRef: string, attachmentRef?: string) => ReservationWorkflowV2Extraction,
  synthesis?: (sourceRef: string) => Record<string, unknown>,
  body = 'Please quote both stays for two adults per room, room only or bed and breakfast.',
  readCandidate?: ReturnType<typeof createReservationWorkflowV2CandidateReader>,
  attachments: SyncedQuoteAttachment[] = [],
) {
  const messageId = 'projection-message';
  const threadId = 'projection-thread';
  return runReservationWorkflowV2Prefill({
    adapter: projectionFixture(extraction, synthesis),
    transportId: 'projection-transport',
    propertyCode: 'HRCEN',
    source: {
      messageId,
      threadId,
      sourceHash: 'a'.repeat(64),
      arrivedAt: '2026-11-14T00:00:00.000Z',
    },
    selection: {
      messageId,
      threadId,
      subject: 'Quote request',
      bodyText: body,
      currentBodyText: body,
      fromAddress: 'guest@example.com',
      preceding: [],
      attachments,
    },
    lookupFixtures: {},
    readCandidate,
    env: {},
  });
}

const claim = (raw: string, value: string | number, sourceRef: string) => ({
  raw,
  value,
  sourceRefs: [sourceRef],
});

function quoteFixture(sourceRef: string): ReservationWorkflowV2Extraction['requests'][number] {
  return {
    id: 'quote_request',
    kind: 'quote',
    requestText: claim('Please quote both stays', 'Please quote both stays', sourceRef),
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
  };
}

function allocatedCreate(ref: string, shared: Record<string, unknown> = {}) {
  return { proposal: { schemaVersion: 'reservation-prefill.v0.2', content: { requests: [{ id: 'quote_request', kind: 'create',
    requestText: 'Please book', sourceRefs: [ref], serviceRefs: [], documentRefs: [], body: { shared, dateSections: [{ id: 'section',
      arrival: '2027-01-10', departure: '2027-01-12', requestedRooms: 1, requestedTotals: { adults: null, childCount: null, childAges: null },
      defaults: {}, unassignedGuestNames: [] }], allocations: [{ id: 'allocation', dateSectionId: 'section', overrides: {},
        guest: { firstName: null, lastName: null, email: null, mobile: null, profileIntent: 'existing_or_unknown', candidateRefs: [], suggestedRef: null },
        occupancy: { adults: null, childCount: null, childAges: null }, priceObservationRefs: [] }] } }], services: [], documents: [] },
    annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] }, reviewRequirements: {} };
}

describe('reservation workflow host projection', () => {
  it.each([
    ['matched guest', { outcome: 'ok', rows: [{ firstName: 'Proof', lastName: 'Labtest', status: 'Reserved', arrival: '2027-01-10', departure: '2027-01-12' }] }, true],
    ['wrong guest', { outcome: 'ok', rows: [{ firstName: 'Other', lastName: 'Labtest', status: 'Reserved', arrival: '2027-01-10', departure: '2027-01-12' }] }, false],
    ['wrong dates', { outcome: 'ok', rows: [{ firstName: 'Proof', lastName: 'Labtest', status: 'Reserved', arrival: '2027-01-10', departure: '2027-01-13' }] }, false],
    ['unknown departure', { outcome: 'ok', rows: [{ firstName: 'Proof', lastName: 'Labtest', status: 'Reserved', arrival: '2027-01-10', departure: null }] }, false],
    ['cancelled guest', { outcome: 'ok', rows: [{ firstName: 'Proof', lastName: 'Labtest', status: 'Cancelled', arrival: '2027-01-10', departure: '2027-01-12' }] }, false],
    ['not found', { outcome: 'not_found', rows: [] }, false],
    ['ambiguous', { outcome: 'ambiguous', rows: [] }, false],
  ])('binds a partial guest stay only on positive identity and dates: %s', async (_scenario, stayResult, matched) => {
    const body = 'Please book Proof Labtest for Northwind Travel from 2027-01-10 to 2027-01-12. See attached voucher.';
    const result = await project((ref, attachmentRef) => {
      if (!attachmentRef) throw new Error('expected voucher evidence');
      return { requests: [{ ...quoteFixture(ref), kind: 'create',
        requestText: claim('Please book Proof Labtest', 'Please book Proof Labtest', ref),
        dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }],
        guests: [{ role: 'guest', name: claim('Proof Labtest', 'Proof Labtest', ref) }],
        parties: [{ role: 'bookingAgency', name: claim('Northwind Travel', 'Northwind Travel', ref) }],
        documentRefs: [attachmentRef], documentHints: [{ documentRef: attachmentRef, kind: 'voucher', sourceRefs: [attachmentRef] }],
      }], issues: [] };
    }, ref => allocatedCreate(ref), body, async candidate => candidate.kind === 'stay_candidate'
      ? { status: 'partial', result: stayResult, coverage: { complete: false, notes: ['Search incomplete'] } } : null,
    [{ id: 'voucher', filename: 'voucher.pdf', mimeType: 'application/pdf', bytesPresent: true, text: 'Voucher for Proof Labtest' }]);
    expect(result.proposal.issues.some(issue => issue.kind === 'voucher_existing_native_stay_hold')).toBe(matched);
    expect(result.proposal.content.requests.find(request => request.id === 'quote_request')?.kind).toBe(matched ? 'other' : 'create');
  });

  it.each([
    ['matched confirmation', 'partial', { outcome: 'found', stay: { confirmation: '123456-1', arrival: '2027-01-10', departure: '2027-01-12' } }, true],
    ['wrong confirmation', 'partial', { outcome: 'found', stay: { confirmation: '654321-1', arrival: '2027-01-10', departure: '2027-01-12' } }, false],
    ['wrong dates', 'partial', { outcome: 'found', stay: { confirmation: '123456-1', arrival: '2027-01-10', departure: '2027-01-13' } }, false],
    ['failed read', 'failed', { outcome: 'found', stay: { confirmation: '123456-1', arrival: '2027-01-10', departure: '2027-01-12' } }, false],
    ['ambiguous read', 'partial', { outcome: 'ambiguous', stay: { confirmation: '123456-1', arrival: '2027-01-10', departure: '2027-01-12' } }, false],
  ] as const)('binds a partial confirmation stay only on positive identity and dates: %s', async (_scenario, status, stayResult, matched) => {
    const body = 'Please book 123456-1 for Northwind Travel from 2027-01-10 to 2027-01-12. See attached voucher.';
    const result = await project((ref, attachmentRef) => {
      if (!attachmentRef) throw new Error('expected voucher evidence');
      return { requests: [{ ...quoteFixture(ref), kind: 'create',
        requestText: claim('Please book 123456-1', 'Please book 123456-1', ref),
        dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }],
        confirmationHints: [claim('123456-1', '123456-1', ref)],
        parties: [{ role: 'bookingAgency', name: claim('Northwind Travel', 'Northwind Travel', ref) }],
        documentRefs: [attachmentRef], documentHints: [{ documentRef: attachmentRef, kind: 'voucher', sourceRefs: [attachmentRef] }],
      }], issues: [] };
    }, ref => allocatedCreate(ref), body, async candidate => candidate.kind === 'stay_candidate'
      ? { status, result: stayResult, coverage: { complete: false, notes: ['Search incomplete'] } } : null,
    [{ id: 'voucher', filename: 'voucher.pdf', mimeType: 'application/pdf', bytesPresent: true, text: 'Voucher for 123456-1' }]);
    expect(result.proposal.issues.some(issue => issue.kind === 'voucher_existing_native_stay_hold')).toBe(matched);
  });

  it('combines a verified saved note after a partial confirmation search', async () => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock: async <T>(operation: () => Promise<T>) => operation() } as never);
    const range = { from: '2027-01-01', to: '2027-01-31' };
    const completeness = { searchedDateRange: range, searchedRanges: [range],
      requestedDateHorizon: { from: '2020-01-01', to: '2040-01-01' }, displayed: 1, total: 1,
      gridComplete: true, requestedDatesCovered: false, allChunksSearched: false, truncated: false };
    const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', confirmation: '123456-1',
      guestId: '42', reservationStayId: '81', reservationId: '82', recordId: '83', status: 'Reserved',
      firstName: 'Proof', lastName: 'Labtest', arrival: '2027-01-10', departure: '2027-01-12',
      roomType: 'STQN', ratePlan: 'BAR', adults: 2, children: 0, childAges: 'unknown' };
    const run = vi.spyOn(cloudStay, 'runCloudStayFind').mockResolvedValue({ outcome: 'ok', completeness,
      shallow: { confirmation: '123456-1', searchResults: { complete: true } }, record: { nativePreimage: native, details: { fields: [
        { name: 'status', value: 'Reserved' }, { name: 'guestid', value: '42' },
        { name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' },
        { name: 'arrivaldate', value: '10-Jan-2027' }, { name: 'departuredate', value: '12-Jan-2027' },
        { name: 'roomtype', value: 'STQN' }, { name: 'rateplan', value: 'BAR' },
        { name: 'adults', value: '2' }, { name: 'children', value: '0' },
        { name: 'reservationnote', value: 'Existing note', rawValue: 'Existing note' },
      ] } } });
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'projection-message', threadId: 'projection-thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    const body = 'Please amend 123456-1.\nParking requested.';
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'amend',
      requestText: claim('Please amend 123456-1', 'Please amend 123456-1', ref),
      confirmationHints: [claim('123456-1', '123456-1', ref)] }], issues: [] }), ref => ({
      proposal: { schemaVersion: 'reservation-prefill.v0.2', content: { requests: [{ id: 'quote_request', kind: 'amend',
        requestText: 'Please amend 123456-1', sourceRefs: [ref], serviceRefs: [], documentRefs: [], body: {
          targets: { mode: 'explicit', include: [{ id: 'target', confirmation: '123456-1', candidateRefs: [], suggestedRef: null,
            sourceRefs: [ref] }], exclude: [], sourceRefs: [ref] }, sharedChanges: [], perTarget: [] } }], services: [], documents: [] },
        annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] }, reviewRequirements: {} }), body, read);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ request: { confirmation: '123456-1' } }));
    const baseline = result.observations.find(row => row.criteria.kind === 'prefill_saved_note_baseline');
    expect(baseline).toMatchObject({ status: 'partial', coverage: { complete: false, notes: [expect.any(String)] },
      result: { outcome: 'found', completeness, reservationObservations: { reservationNote: {
        state: 'observed', value: 'Existing note', source: 'record_view_raw_value', confirmation: '123456-1' } } } });
    const request = result.proposal.content.requests.find(row => row.kind === 'amend');
    if (request?.kind !== 'amend') throw new Error('expected Amend');
    expect(request.body.perTarget.flatMap(row => row.changes)).toContainEqual(expect.objectContaining({
      op: 'set', field: 'reservationNote', value: 'Existing note\nParking requested.' }));
    expect(result.proposal.issues).not.toContainEqual(expect.objectContaining({ kind: 'saved_note_requires_review' }));
  });
  it.each(['create', 'quote', 'amend'] as const)('emits schema-valid source-only note composition for %s', async (kind) => {
      const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind,
        requestText: claim('Please arrange', 'Please arrange', ref),
        rateHints: ['corporate rate', 'agency rate', 'historical rate'].map(text => claim(text, text, ref)) }], issues: [] }), undefined,
      'Please arrange. Parking requested.\nPlease quote the corporate rate.\nDo not use the agency rate.\n> Please quote the historical rate.');
      const observations = result.observations.filter(row => row.criteria.kind === 'reservation_note_composition' && row.criteria.workflow === kind);
      expect(observations.length).toBeGreaterThan(0);
      for (const row of observations) {
        expect(reservationWorkflowV2ObservationSchema.safeParse(row).success).toBe(true);
        expect(row.criteria).toMatchObject({ generationId: result.generationId, sourceHash: 'a'.repeat(64), propertyCode: 'HRCEN' });
        expect(row.result).toMatchObject({ limit: 2000, memory: {}, compositionStatus: 'clean' });
      }
      expect(observations.some(row => Array.isArray(row.result.sourceClauses) && row.result.sourceClauses.some((clause: unknown) =>
        typeof clause === 'object' && clause !== null && 'text' in clause && clause.text === 'Parking requested.'))).toBe(true);
      const request = result.proposal.content.requests.find(row => row.kind === kind);
      const note = request?.kind === 'create' ? request.body.shared.reservationNote : request?.kind === 'quote' ? request.body.notes : null;
      if (kind !== 'amend') {
        expect(note).toContain('Please quote the corporate rate.');
        expect(note).not.toContain('\ncorporate rate');
        expect(note).toContain('Do not use the agency rate.');
        expect(note).not.toContain('\nagency rate');
        expect(note).not.toContain('historical rate');
      }
      expect(reservationWorkflowV2DraftSchema.safeParse({ contractVersion: 2, schemaVersion: 'reservation-prefill.v0.2',
        workItemId: randomUUID(), transportId: 'projection-transport', propertyCode: 'HRCEN',
        source: { messageId: 'projection-message', threadId: 'projection-thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' },
        generationId: result.generationId, revision: 0, status: result.status, proposal: result.proposal, observations: result.observations,
        fieldReviewRequirements: result.fieldReviewRequirements, staffReviews: {}, operationResults: [], fieldOverrides: {}, errors: result.errors }).success).toBe(true);
  }, 12_000);

  it.each([[1, 1, false, false], [2, 3, false, false], [2, 2, true, false], [2, 2, false, true]])
  ('keeps note and guarantee history advisory, independent of research purity (%i/%i)', async (support, denominator, _applies, webmailDomain) => {
    vi.spyOn(memoryLeads, 'loadReservationMemoryGuidance').mockResolvedValue({ status: 'available', denominator,
      notes: [{ value: 'BB to agent', support, denominator, confidence: support / denominator }],
      guarantees: [{ value: 'CC', support, denominator, confidence: support / denominator }], tracks: [], complete: true, multiClientDomain: false, webmailDomain });
    vi.spyOn(memoryLeads, 'loadReservationRateTrackMapping').mockResolvedValue({ status: 'available', mappings: [{ propertyCode: 'HRCEN', ratePlan: 'BAR',
      countingUnit: 'distinct_verified_stays', capturedThrough: '2026-01-01T00:00:00.000Z', denominator,
      candidates: [{ track: 'COR', support, denominator, confidence: support / denominator }] }] });
    vi.spyOn(bookingCodes, 'loadNativeBookingCodes').mockImplementation(async input => input.kind === 'trackSubsegment'
      ? { status: 'available', records: [{ code: 'COR', meaning: 'Corporate' }], capturedAt: '2026-01-01T00:00:00.000Z' } as never
      : input.kind === 'guaranteeTypes' ? { status: 'available', records: [{ code: 'CC', meaning: 'Card' }], capturedAt: '2026-01-01T00:00:00.000Z' } as never
      : { status: 'unavailable', issue: 'test' });
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ propertyCode: 'HRCEN',
      roomsEnvelope: () => ({ status: 'available', coverage: { scope: 'whole_catalog', complete: true } }),
      ratesEnvelope: () => ({ status: 'available', coverage: { scope: 'whole_catalog', complete: true } }),
      lookupVerifiedCode: (kind: string, code: string) => ({ status: kind === 'rate' && code === 'BAR' ? 'unique' : 'not_found' }),
    } as never);
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'create',
      requestText: claim('Please book', 'Please book', ref), rateHints: [claim('BAR', 'BAR', ref)],
      dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref),
        roomCount: claim('one room', 1, ref) }] }], issues: [] }),
    ref => allocatedCreate(ref),
    'Please book one room at rate BAR 2027-01-10 to 2027-01-12.');
    const request = result.proposal.content.requests.find(row => row.kind === 'create');
    if (request?.kind !== 'create') throw new Error('expected Create');
    expect(memoryLeads.loadReservationMemoryGuidance, JSON.stringify(request.body)).toHaveBeenCalled();
    const note = result.observations.find(row => row.criteria.kind === 'reservation_note_composition' && row.criteria.fieldPath ===
      `/proposal/content/requests/${request.id}/body/shared/reservationNote`);
    expect(note?.result.memory).toMatchObject({
      guarantee: { support, denominator, autoApplied: false, blockedReason: 'staff_confirmation_required' } });
    expect(note?.result.memory).not.toHaveProperty('payer');
    expect(note?.result.memory).not.toHaveProperty('dinnerCap');
    expect(request.body.shared.reservationNote).toBe('Please book one room at rate BAR 2027-01-10 to 2027-01-12.');
    expect(request.body.shared.guaranteeType ?? null).toBeNull();
    expect(Boolean(result.observations.find(row => row.criteria.kind === 'rate_track_memory'))).toBe(support >= 2 && support / denominator >= 0.8);
  });

  it.each(['none', 'conflict', 'over_limit'] as const)('protects note composition in the %s case', async scenario => {
    vi.spyOn(memoryLeads, 'loadReservationMemoryGuidance').mockResolvedValue({ status: 'available', denominator: 2,
      notes: [{ value: 'DBB to agent; Dinner allowance R350', support: 2, denominator: 2, confidence: 1 }],
      guarantees: [], tracks: [], complete: true, multiClientDomain: false });
    const clause = scenario === 'conflict' ? 'Dinner allowance R200' : scenario === 'over_limit' ? `Parking ${'x'.repeat(2000)}` : 'Parking requested';
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'create',
      requestText: claim('Please book', 'Please book', ref), dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref),
        departure: claim('2027-01-12', '2027-01-12', ref) }] }], issues: [] }),
      ref => allocatedCreate(ref, scenario === 'none' ? { reservationNote: { kind: 'none' } } : {}),
      `Please book 2027-01-10 to 2027-01-12.\n${clause}`);
    const request = result.proposal.content.requests.find(row => row.kind === 'create');
    if (request?.kind !== 'create') throw new Error('expected Create');
    const note = result.observations.find(row => row.criteria.kind === 'reservation_note_composition' && row.criteria.fieldPath ===
      `/proposal/content/requests/${request.id}/body/shared/reservationNote`);
    expect(note?.result.compositionStatus).toBe(scenario === 'none' ? 'blocked_none' : scenario === 'over_limit' ? 'over_limit' : 'clean');
    if (scenario === 'none') expect(request.body.shared.reservationNote).toEqual({ kind: 'none' });
    if (scenario === 'conflict') {
      expect(request.body.shared.reservationNote).toContain('R200');
      expect(request.body.shared.reservationNote).not.toContain('R350');
      expect(note?.result.conflicts).toEqual([]);
    }
  });
  it.each([
    ['Please book ROOMX', 'ROOMX', 'available', true],
    ['Please book no ROOMX', 'ROOMX', 'available', false],
    ['Please book without ROOMX', 'ROOMX', 'available', false],
    ['Please book rate ROOMX', 'ROOMX', 'available', false],
    ['Please book away from the ROOMX', 'ROOMX', 'available', false],
    ['We visited ROOMX', 'ROOMX', 'available', false],
    ['Please book away from the roomx', 'away from the roomx', 'available', false],
    ['Please book roomx', 'roomx', 'available', false],
    ['Please book ROOMX', 'ROOMX', 'partial_or_legacy', false],
  ])('requires exact source intent and complete catalog: %s (%s, %s)', async (body, raw, status, expected) => {
    const envelope = { status, coverage: { scope: 'whole_catalog', complete: status === 'available' } };
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ propertyCode: 'HRCEN',
      roomsEnvelope: () => envelope, ratesEnvelope: () => envelope,
      lookupVerifiedCode: (kind: string, code: string) => ({ status: kind === 'room' && code === 'ROOMX' ? 'unique' : 'not_found' }),
    } as never);
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'create',
      requestText: claim('Please book', 'Please book', ref), roomTypeHints: [claim(raw, 'ROOMX', ref)],
      dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }] }], issues: [] }),
    undefined, `${body} 2027-01-10 to 2027-01-12`);
    const request = result.proposal.content.requests.find(row => row.kind === 'create');
    if (request?.kind !== 'create') throw new Error('expected Create');
    expect(request.body.shared.roomType ?? null).toBe(expected ? 'ROOMX' : null);
    expect(request.body.shared.requestedRoomDescription).toBe(raw);
  });

  it.each([
    ['rate', 'BAR is unavailable, please quote PROMO.', 'BAR', 'BAR', null],
    ['rate', 'BAR is unavailable, please quote PROMO.', 'PROMO', 'PROMO', 'PROMO'],
    ['room', 'Room BAR is not wanted, please use DLX.', 'BAR', 'BAR', null],
    ['room', 'Room BAR is not wanted, please use DLX.', 'DLX', 'DLX', 'DLX'],
    ['room', 'Room code BAR is not wanted.', 'Room code BAR', 'BAR', null],
    ['rate', 'rate code BAR is unavailable.', 'rate code BAR', 'BAR', null],
    ['rate', 'Please quote BAR instead of PROMO.', 'BAR', 'BAR', 'BAR'],
    ['rate', 'Please quote BAR instead of PROMO.', 'PROMO', 'PROMO', null],
    ['room', 'Please book BAR, but BAR is sold out.', 'BAR', 'BAR', null],
    ['room', "Don't book BAR or DLX.", 'DLX', 'DLX', null],
    ['room', "Don't book BAR or DLX and STQN.", 'STQN', 'STQN', null],
    ['room', "Don't book BAR or the room DLX.", 'DLX', 'DLX', null],
    ['room', "Don't book BAR, but use DLX and STQN.", 'STQN', 'STQN', 'STQN'],
    ['room', 'Room BAR and DLX are unavailable.', 'BAR', 'BAR', null],
    ['room', 'Room BAR and DLX are unavailable.', 'DLX', 'DLX', null],
    ['rate', 'BAR or PROMO cannot be quoted', 'BAR', 'BAR', null],
    ['rate', 'BAR or PROMO cannot be quoted', 'PROMO', 'PROMO', null],
    ['room', 'STQN, DLX are all unavailable', 'STQN', 'STQN', null],
    ['room', "STQN and DLX aren't available", 'STQN', 'STQN', null],
    ['room', 'Neither STQN nor DLX', 'DLX', 'DLX', null],
    ['room', 'STQN and room code dlx are currently not available', 'room code dlx', 'DLX', null],
    ['room', 'room code stqn', 'room code stqn', 'STQN', 'STQN'],
    ['rate', 'rate code promo', 'rate code promo', 'PROMO', 'PROMO'],
    ['room', 'avoid room code stqn', 'room code stqn', 'STQN', null],
    ['room', 'avoid room code stqn', 'avoid room code stqn', 'STQN', null],
    ['rate', 'rate code promo is unavailable', 'rate code promo', 'PROMO', null],
    ['rate', 'rate code promo is unavailable', 'rate code promo is unavailable', 'PROMO', null],
  ] as const)('projects only wanted %s code in %s (%s)', async (kind, body, raw, code, expected) => {
    const envelope = { status: 'available', coverage: { scope: 'whole_catalog', complete: true } };
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ propertyCode: 'HRCEN',
      roomsEnvelope: () => envelope, ratesEnvelope: () => envelope,
      lookupVerifiedCode: () => ({ status: 'unique' }),
    } as never);
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'create',
      requestText: claim(body, body, ref),
      ...(kind === 'room' ? { roomTypeHints: [claim(raw, code, ref)] } : { rateHints: [claim(raw, code, ref)] }),
      dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }] }], issues: [] }),
    undefined, `${body} 2027-01-10 to 2027-01-12`);
    const request = result.proposal.content.requests.find(row => row.kind === 'create');
    if (request?.kind !== 'create') throw new Error('expected Create');
    expect((kind === 'room' ? request.body.shared.roomType : request.body.shared.ratePlan) ?? null).toBe(expected);
  });

  it.each(([
    ['Avoid STQN, DLX', ['DLX'], []],
    ['Do not book STQN, DLX, or STE', ['DLX'], []],
    ['Do not book STQN, DLX, or STE', ['STE'], []],
    ['Avoid STQN, room DLX, room code STE', ['STE'], []],
    ['Avoid STQN/DLX', ['DLX'], []],
    ['STQN, DLX, STE are unavailable', ['STQN'], []],
    ['STQN, DLX, STE are unavailable', ['DLX'], []],
    ['STQN, DLX, STE are unavailable', ['STE'], []],
    ['STQN, room DLX, room code STE are unavailable', ['STQN'], []],
    ['STQN, DLX not wanted', ['STQN'], []],
    ['STQN, DLX are closed/sold out', ['STQN'], []],
    ['STQN, DLX are all unavailable', ['STQN', 'DLX'], []],
    ["STQN and DLX aren't available", ['STQN', 'DLX'], []],
    ['Neither STQN nor DLX', ['STQN', 'DLX'], []],
    ['Please quote neither STQN nor DLX', ['STQN', 'DLX'], []],
    ['STQN and DLX are both unavailable', ['STQN', 'DLX'], []],
    ['STQN and DLX are currently not valid', ['STQN', 'DLX'], []],
    ['STQN and DLX are now unavailable', ['STQN', 'DLX'], []],
    ['STQN and DLX are still not offered', ['STQN', 'DLX'], []],
    ['STQN and DLX are no longer available', ['STQN', 'DLX'], []],
    ['STQN and DLX cannot be quoted', ['STQN', 'DLX'], []],
    ["STQN and DLX can't be used", ['STQN', 'DLX'], []],
    ['STQN and DLX should not be quoted', ['STQN', 'DLX'], []],
    ['STQN and DLX are not wanted', ['STQN', 'DLX'], []],
    ["STQN and DLX isn't available", ['STQN', 'DLX'], []],
    ["STQN and DLX wasn't available", ['STQN', 'DLX'], []],
    ["STQN and DLX weren't available", ['STQN', 'DLX'], []],
    ["STQN and DLX don't work", ['STQN', 'DLX'], []],
    ["STQN and DLX doesn't work", ['STQN', 'DLX'], []],
    ["STQN and DLX didn't work", ['STQN', 'DLX'], []],
    ["STQN and DLX couldn't be booked", ['STQN', 'DLX'], []],
    ["STQN and DLX won't be available", ['STQN', 'DLX'], []],
    ["STQN and DLX wouldn't be available", ['STQN', 'DLX'], []],
    ["STQN and DLX shouldn't be used", ['STQN', 'DLX'], []],
    ['STQN and DLX are unable to be booked', ['STQN', 'DLX'], []],
    ['STQN, DLX, STE are all unavailable', ['STQN', 'DLX', 'STE'], []],
    ['STQN and room code dlx are currently not available', ['STQN'], []],
    ['Unable to book STQN or DLX', ['STQN', 'DLX'], []],
    ['Neither STQN nor DLX, please book STE', ['STQN', 'DLX', 'STE'], ['STE']],
    ['STQN and DLX can no longer be booked', ['STQN', 'DLX'], []],
    ['STQN and DLX are both currently unable to be booked', ['STQN', 'DLX'], []],
    ['STQN and DLX shouldn’t be offered', ['STQN', 'DLX'], []],
    ['Avoid STQN. Book DLX', ['DLX'], ['DLX']],
    ['BAR is unavailable, please quote PROMO.', ['PROMO'], ['PROMO']],
    ['BAR is unavailable, DLX', ['DLX'], ['DLX']],
    ['Please quote STQN, DLX', ['STQN'], ['STQN']],
    ['Please quote STQN, DLX', ['DLX'], ['DLX']],
    ['Please quote STQN, DLX instead of STE', ['STQN', 'DLX', 'STE'], ['STQN', 'DLX']],
    ['Please quote STQN, DLX rather than STE', ['STQN', 'DLX', 'STE'], ['STQN', 'DLX']],
    ['STQN and DLX are available', ['STQN', 'DLX'], ['STQN', 'DLX']],
    ['STQN is unavailable, please quote DLX and STE', ['DLX', 'STE'], ['DLX', 'STE']],
    ['STQN and DLX are all unavailable, please quote STE', ['STQN', 'DLX', 'STE'], ['STE']],
    ['Avoid STQN, please quote DLX', ['DLX'], ['DLX']],
  ] as const).flatMap(([body, codes, expected]) => codes.map(code =>
    [body, code, expected.some(item => item === code) ? [code] : []] as const)))('projects only requested room code from list: %s (%s)', async (body, code, expected) => {
    const envelope = { status: 'available', coverage: { scope: 'whole_catalog', complete: true } };
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ propertyCode: 'HRCEN',
      roomsEnvelope: () => envelope, ratesEnvelope: () => envelope,
      lookupVerifiedCode: () => ({ status: 'unique' }),
    } as never);
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref),
      requestText: claim(body, body, ref), roomTypeHints: [claim(code, code, ref)],
      dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }] }], issues: [] }),
    undefined, `${body} 2027-01-10 to 2027-01-12`);
    const request = result.proposal.content.requests.find(row => row.kind === 'quote');
    if (request?.kind !== 'quote') throw new Error('expected Quote');
    expect(request.body.groups[0]?.roomCodes).toEqual(expected);
  });

  it('retains both requested code claims when Quote needs scope review', async () => {
    const envelope = { status: 'available', coverage: { scope: 'whole_catalog', complete: true } };
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ propertyCode: 'HRCEN',
      roomsEnvelope: () => envelope, ratesEnvelope: () => envelope,
      lookupVerifiedCode: () => ({ status: 'unique' }),
    } as never);
    const body = 'Please quote STQN, DLX';
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), requestText: claim(body, body, ref),
      roomTypeHints: ['STQN', 'DLX'].map(code => claim(code, code, ref)),
      dates: [{ arrival: claim('2027-01-10', '2027-01-10', ref), departure: claim('2027-01-12', '2027-01-12', ref) }] }], issues: [] }),
    undefined, `${body} 2027-01-10 to 2027-01-12`);
    const request = result.proposal.content.requests.find(row => row.kind === 'quote');
    if (request?.kind !== 'quote') throw new Error('expected Quote');
    expect(request.body.groups[0]?.roomCodes).toEqual([]);
    expect(result.proposal.issues).toContainEqual(expect.objectContaining({ kind: 'quote_room_code_scope_ambiguous',
      explanation: expect.stringContaining('Multiple current room codes') }));
  });

  it.each([
    { requestedDatesCovered: false }, { allChunksSearched: false }, { truncated: true }, { gridComplete: false },
    { displayed: 0, total: 1 },
    { searchedRanges: [{ from: '2027-01-01', to: '2027-01-15' }] },
    {},
  ])('preserves found stays with accurate confirmation coverage: %s', async flags => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock: async <T>(operation: () => Promise<T>) => operation() } as never);
    const range = { from: '2027-01-01', to: '2027-01-31' };
    const completeness = { searchedDateRange: range, searchedRanges: [range], requestedDateHorizon: range,
      displayed: 1, total: 1, gridComplete: true, requestedDatesCovered: true, allChunksSearched: true, truncated: false, ...flags };
    vi.spyOn(cloudStay, 'runCloudStayFind').mockResolvedValue({ outcome: 'ok', completeness,
      shallow: { confirmation: '123456-1', searchResults: { complete: true } },
      record: { details: { fields: [{ name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' }] } } });
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    const complete = Object.keys(flags).length === 0;
    expect(await read({ id: 'confirmation', ref: 'source-confirmation', kind: 'stay_candidate', propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: '123456-1' }, sourceRefs: [] })).toMatchObject({
      status: complete ? 'complete' : 'partial', result: { outcome: 'found', stay: { firstName: 'Proof', lastName: 'Labtest' } },
      coverage: { complete, notes: complete ? [] : [expect.stringMatching(/\S/)] },
    });
  });

  it.each([
    { requestedDatesCovered: false }, { allChunksSearched: false }, { truncated: true }, { gridComplete: false },
  ])('marks incomplete exact confirmation searches partial: %s', async flags => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock: async <T>(operation: () => Promise<T>) => operation() } as never);
    vi.spyOn(cloudStay, 'runCloudStayFind').mockResolvedValue({ outcome: 'read_failed', issue: 'CONFIRMATION_NOT_FOUND',
      completeness: { searchedDateRange: { from: '2027-01-01', to: '2027-01-31' },
        searchedRanges: [{ from: '2027-01-01', to: '2027-01-31' }],
        requestedDateHorizon: { from: '2027-01-01', to: '2027-01-31' }, displayed: 0, total: 0,
        gridComplete: true, requestedDatesCovered: true, allChunksSearched: true, truncated: false, ...flags } });
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    expect(await read({ id: 'confirmation', ref: 'source-confirmation', kind: 'stay_candidate', propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: '123456-1' }, sourceRefs: [] })).toMatchObject({ status: 'partial',
      result: { outcome: 'ambiguous', reason: expect.stringMatching(/SEARCH_INCOMPLETE|CONFIRMATION_NOT_FOUND_IN_SEARCH_WINDOW/) },
      coverage: { complete: false, notes: [expect.any(String)] } });
  });

  it('keeps a fully verified confirmation not-found search complete', async () => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock: async <T>(operation: () => Promise<T>) => operation() } as never);
    vi.spyOn(cloudStay, 'runCloudStayFind').mockResolvedValue({ outcome: 'read_failed', issue: 'CONFIRMATION_NOT_FOUND',
      completeness: { searchedDateRange: { from: '2027-01-01', to: '2027-01-31' },
        searchedRanges: [{ from: '2027-01-01', to: '2027-01-31' }],
        requestedDateHorizon: { from: '2027-01-01', to: '2027-01-31' }, displayed: 0, total: 0,
        gridComplete: true, requestedDatesCovered: true, allChunksSearched: true, truncated: false } });
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    expect(await read({ id: 'confirmation', ref: 'source-confirmation', kind: 'stay_candidate', propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: '123456-1' }, sourceRefs: [] })).toMatchObject({ status: 'complete',
      result: { outcome: 'not_found' }, coverage: { complete: true, notes: [] } });
  });
  it('keeps partial guest-search coverage and never presents it as complete absence', async () => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(hmsService, 'nativeReadCapabilityAvailable').mockResolvedValue(true);
    const completeness = { searchedDateRange: { from: '2027-01-01', to: '2027-01-02' },
      searchedRanges: [{ from: '2027-01-01', to: '2027-01-02' }],
      requestedDateHorizon: { from: '2027-01-01', to: '2027-01-10' }, displayed: 0, total: 0,
      gridComplete: true, requestedDatesCovered: false, allChunksSearched: false, truncated: false };
    vi.spyOn(paneLookup, 'searchGuestCloudBatch').mockResolvedValue([{ outcome: 'execution_failure', rows: [],
      screenshots: [], runId: null, error: 'incomplete', completeness }]);
    const candidate = { id: 'guest-stay', ref: 'guest-stay', kind: 'stay_candidate' as const, propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: 'Example', dates: [{ arrival: '2027-01-01', departure: '2027-01-10' }] }, sourceRefs: [] };
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' }, candidates: [candidate] });
    expect(await read(candidate)).toMatchObject({ status: 'partial', result: { completeness, truncated: false,
      searchedDateRange: completeness.searchedDateRange, requestedDateHorizon: completeness.requestedDateHorizon, reason: 'incomplete' },
      coverage: { complete: false, notes: [expect.stringContaining('absence is not established')] } });
  });

  it.each([
    { requestedDatesCovered: false }, { allChunksSearched: false }, { truncated: true }, { gridComplete: false },
  ])('keeps guest matches when search coverage is incomplete: %s', async flags => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    const range = { from: '2027-01-01', to: '2027-01-10' };
    const completeness = { searchedDateRange: range, searchedRanges: [range], requestedDateHorizon: range,
      displayed: 1, total: 1, gridComplete: true, requestedDatesCovered: true, allChunksSearched: true, truncated: false, ...flags };
    const rows = [{ confirmation: '123456-1', firstName: 'Proof', lastName: 'Labtest', status: 'Reserved',
      arrival: '2027-01-01', departure: '2027-01-10' }];
    vi.spyOn(paneLookup, 'searchGuestCloudBatch').mockResolvedValue([{ outcome: 'ok', rows, screenshots: [], runId: null, completeness }]);
    const candidate = { id: 'guest-stay', ref: 'guest-stay', kind: 'stay_candidate' as const, propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: 'Labtest', dates: [{ arrival: range.from, departure: range.to }] }, sourceRefs: [] };
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' }, candidates: [candidate] });
    expect(await read(candidate)).toMatchObject({ status: 'partial', result: { rows, completeness },
      coverage: { complete: false, notes: [expect.stringMatching(/\S/)] } });
  });

  it('does not treat a guest search without coverage metadata as complete', async () => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(hmsService, 'nativeReadCapabilityAvailable').mockResolvedValue(true);
    vi.spyOn(paneLookup, 'searchGuestCloudBatch').mockResolvedValue([{ outcome: 'ok', rows: [], screenshots: [], runId: null }]);
    const candidate = { id: 'guest-stay', ref: 'guest-stay', kind: 'stay_candidate' as const, propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: 'Example', dates: [{ arrival: '2027-01-01', departure: '2027-01-10' }] }, sourceRefs: [] };
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' }, candidates: [candidate] });
    expect(await read(candidate)).toMatchObject({ status: 'partial', coverage: { complete: false } });
  });

  it('does not treat guest search ranges with a gap as complete', async () => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    const completeness = { searchedDateRange: { from: '2027-01-01', to: '2027-01-10' },
      searchedRanges: [{ from: '2027-01-01', to: '2027-01-03' }, { from: '2027-01-05', to: '2027-01-10' }],
      requestedDateHorizon: { from: '2027-01-01', to: '2027-01-10' }, displayed: 0, total: 0,
      gridComplete: true, requestedDatesCovered: true, allChunksSearched: true, truncated: false };
    vi.spyOn(paneLookup, 'searchGuestCloudBatch').mockResolvedValue([{ outcome: 'ok', rows: [], screenshots: [], runId: null, completeness }]);
    const candidate = { id: 'guest-stay', ref: 'guest-stay', kind: 'stay_candidate' as const, propertyCode: 'HRCEN',
      criteria: { confirmationOrGuestText: 'Example', dates: [{ arrival: '2027-01-01', departure: '2027-01-10' }] }, sourceRefs: [] };
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRCEN', transportId: 'transport',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' }, candidates: [candidate] });
    expect(await read(candidate)).toMatchObject({ status: 'partial', coverage: { complete: false, notes: [expect.any(String)] } });
  });
  it.each([50, 51, 300, 301])('preserves a %i-character Create booker only within draft limits', async (length) => {
    const name = 'N'.repeat(length);
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'create',
      requestText: claim('Please book', 'Please book', ref),
      guests: [{ role: 'booker', name: claim(name, name, ref) }] }], issues: [] }), undefined, `Please book. Booker: ${name}`);
    const request = result.proposal.content.requests.find(row => row.kind === 'create');
    expect(request?.kind).toBe('create');
    if (request?.kind !== 'create') throw new Error('expected Create');
    expect(request.body.shared.bookerName ?? null).toBe(length <= 300 ? name : null);
    expect(result.proposal.issues.some(issue => issue.kind === 'native_booker_name_max_50')).toBe(length > 50 && length <= 300);
  });

  it.each([
    ['Please update the booker email to new@example.test', true],
    ['Please amend the stay. Regards, booker new@example.test', false],
    ['Please send the confirmation to new@example.test', false],
    ['Please amend the stay and send confirmation to the booker contact new@example.test', false],
    ['Please do not update the booker email to new@example.test', false],
  ])('projects booker contact only for explicit Amend intent: %s', async (body, expected) => {
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'amend',
      requestText: claim(body, body, ref), guests: [{ role: 'booker', email: claim('new@example.test', 'new@example.test', ref) }] }], issues: [] }), undefined, body);
    const request = result.proposal.content.requests.find(row => row.kind === 'amend');
    expect(request?.kind).toBe('amend');
    if (request?.kind !== 'amend') throw new Error('expected Amend');
    const changes = [...request.body.sharedChanges, ...request.body.perTarget.flatMap(row => row.changes)];
    const email = changes.find(change => 'field' in change && change.field === 'bookerEmail');
    expect(Boolean(email)).toBe(expected);
    if (expected) expect(email).toMatchObject({ op: 'set', value: 'new@example.test', sourceRefs: [expect.any(String)] });
    expect(changes.some(change => 'field' in change && (change.field === 'bookerName' || change.field === 'bookerMobile'))).toBe(false);
  });

  it('projects explicitly changed Amend name and mobile without inventing an email change', async () => {
    const body = 'Please update the booker contact name Jane Example and phone 0123456789';
    const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind: 'amend',
      requestText: claim(body, body, ref), guests: [{ role: 'booker',
        name: claim('Jane Example', 'Jane Example', ref), mobile: claim('0123456789', '0123456789', ref) }] }], issues: [] }), undefined, body);
    const request = result.proposal.content.requests.find(row => row.kind === 'amend');
    if (request?.kind !== 'amend') throw new Error('expected Amend');
    expect(request.body.sharedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'set', field: 'bookerName', value: 'Jane Example' }),
      expect.objectContaining({ op: 'set', field: 'bookerMobile', value: '0123456789' }),
    ]));
    expect(request.body.sharedChanges.some(change => 'field' in change && change.field === 'bookerEmail')).toBe(false);
  });
  it.each(['HRCEN', 'HRDAV', 'HRDAVS'])('reads an exact source confirmation through the selected %s Cloud session', async (propertyCode) => {
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    vi.spyOn(hmsService, 'nativeReadCapabilityAvailable').mockResolvedValue(true);
    const withLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock } as never);
    const native = { source: 'record_view_ext_model', propertyCode, confirmation: '123456-1',
      guestId: '42', reservationStayId: '81', reservationId: '82', recordId: '83', status: 'Reserved',
      firstName: 'Proof', lastName: 'Labtest', arrival: '2027-01-10', departure: '2027-01-12',
      roomType: 'SUP', ratePlan: 'BAR', adults: 2, children: 0, childAges: 'unknown' };
    const run = vi.spyOn(cloudStay, 'runCloudStayFind').mockResolvedValue({ outcome: 'ok',
      shallow: { confirmation: '123456-1', searchResults: { complete: true } }, record: {
        details: { fields: [
          { name: 'status', value: 'Reserved' }, { name: 'guestid', value: '42' },
          { name: 'firstname', value: 'Proof' }, { name: 'lastname', value: 'Labtest' },
          { name: 'arrivaldate', value: '10-Jan-2027' }, { name: 'departuredate', value: '12-Jan-2027' },
          { name: 'roomtype', value: 'SUP' }, { name: 'rateplan', value: 'BAR' },
          { name: 'adults', value: '2' }, { name: 'children', value: '0' },
        ] }, nativePreimage: native,
      } });
    const projectNative = vi.spyOn(cloudStay, 'projectCloudStayFind');
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode,
      transportId: propertyCode === 'HRCEN' ? 'transport-centurion' : 'transport-davinci',
      source: { messageId: 'source', threadId: 'thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    const result = await read({ id: 'confirmation', ref: 'source-confirmation', kind: 'stay_candidate', propertyCode,
      criteria: { confirmationOrGuestText: '123456-1', dates: [{ arrival: '2027-01-10' }] }, sourceRefs: [] });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ propertyCode }),
      request: { confirmation: '123456-1', arrival: '2027-01-10' } }));
    expect(projectNative).toHaveBeenCalledWith(expect.anything(), expect.anything(), propertyCode);
    expect(result).toMatchObject({ status: 'complete', result: { propertyCode, outcome: 'found',
      stay: { firstName: 'Proof', lastName: 'Labtest' } } });
    expect(withLock).toHaveBeenCalledTimes(1);
  });

  it('refuses native prefill and historical parties when selected property reads are disabled', async () => {
    vi.stubEnv('HMS_DAVINCI_READS', 'off');
    vi.stubEnv('HMS_DAVINCI_ENABLED_PROPERTIES', 'HRDAV,HRDAVS');
    const run = vi.spyOn(cloudStay, 'runCloudStayFind');
    const withLock = vi.fn(async <T>(operation: () => Promise<T>) => operation());
    vi.spyOn(paneStaySave, 'paneStayPropertyLock').mockReturnValue({ withLock } as never);
    const read = createReservationWorkflowV2CandidateReader({ db: {} as never, propertyCode: 'HRDAVS',
      transportId: 'transport-davinci', source: { messageId: 'source', threadId: 'thread',
        sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' } });
    for (const kind of ['stay_candidate', 'guest_candidate', 'party_candidate', 'rate_availability'] as const) {
      expect(await read({ id: kind, ref: kind, kind, propertyCode: 'HRDAVS',
        criteria: { confirmationOrGuestText: '123456-1' }, sourceRefs: [] })).toMatchObject({ status: 'unavailable' });
    }
    expect(run).not.toHaveBeenCalled();
    expect(withLock).not.toHaveBeenCalled();
    expect(await lookupNativeParty({ role: 'agency', name: 'Labtest Travel',
      target: hmsReadTargetForProperty('HRDAVS'), transportId: 'transport-davinci' })).toMatchObject({
      status: 'unavailable', result: { reason: 'native_party_read_capability_unavailable' } });
  });

  it('keeps a clear per-room adult claim across multiple occupancy and dated rows', async () => {
    const result = await project((sourceRef) => ({
      requests: [
        {
          ...quoteFixture(sourceRef),
          dates: [
            {
              arrival: claim('14 November', '2026-11-14', sourceRef),
              departure: claim('16 November', '2026-11-16', sourceRef),
            },
            {
              arrival: claim('20 November', '2026-11-20', sourceRef),
              departure: claim('22 November', '2026-11-22', sourceRef),
            },
          ],
          occupancy: [
            { scope: 'per_room', adults: claim('two adults per room', 2, sourceRef) },
            { scope: 'per_room', adults: claim('2 adults per room', 2, sourceRef) },
          ],
        },
      ],
      issues: [],
    }));

    const request = result.proposal.content.requests[0]!;
    expect(request.kind).toBe('quote');
    if (request.kind !== 'quote') throw new Error('expected quote');
    expect(request.body.groups).toHaveLength(2);
    expect(request.body.groups.map((group) => group.occupancy)).toEqual([
      expect.objectContaining({ scope: 'per_room', adults: 2 }),
      expect.objectContaining({ scope: 'per_room', adults: 2 }),
    ]);
  });

  it('keeps a cited child count beside a dominant adult claim', async () => {
    const result = await project((sourceRef) => ({
      requests: [
        {
          ...quoteFixture(sourceRef),
          dates: [
            {
              arrival: claim('14 November', '2026-11-14', sourceRef),
              departure: claim('16 November', '2026-11-16', sourceRef),
            },
          ],
          occupancy: [
            { scope: 'per_room', adults: claim('two adults per room', 2, sourceRef) },
            {
              scope: 'per_room',
              adults: claim('2 adults per room', 2, sourceRef),
              childCount: claim('one child', 1, sourceRef),
            },
          ],
        },
      ],
      issues: [],
    }));

    const request = result.proposal.content.requests[0]!;
    expect(request.kind).toBe('quote');
    if (request.kind !== 'quote') throw new Error('expected quote');
    expect(request.body.groups[0]!.occupancy).toEqual({
      scope: 'per_room',
      adults: 2,
      childCount: 1,
      childAges: null,
    });
  });

  it('leaves conflicting per-room adult claims unresolved', async () => {
    const result = await project((sourceRef) => ({
      requests: [
        {
          ...quoteFixture(sourceRef),
          dates: [
            {
              arrival: claim('14 November', '2026-11-14', sourceRef),
              departure: claim('16 November', '2026-11-16', sourceRef),
            },
          ],
          occupancy: [
            { scope: 'per_room', adults: claim('two adults per room', 2, sourceRef) },
            { scope: 'per_room', adults: claim('three adults per room', 3, sourceRef) },
          ],
        },
      ],
      issues: [],
    }));

    const request = result.proposal.content.requests[0]!;
    expect(request.kind).toBe('quote');
    if (request.kind !== 'quote') throw new Error('expected quote');
    expect(request.body.groups[0]!.occupancy).toEqual({
      scope: 'unresolved',
      adults: null,
      childCount: 0,
      childAges: [],
    });
  });

  it('preserves distinct request-wide board alternatives as separate quote groups', async () => {
    const result = await project((sourceRef) => ({
      requests: [
        {
          ...quoteFixture(sourceRef),
          dates: [
            {
              arrival: claim('14 November', '2026-11-14', sourceRef),
              departure: claim('16 November', '2026-11-16', sourceRef),
              roomCount: claim('one room', 1, sourceRef),
            },
          ],
          mealPlanHints: [
            claim('room only', 'room_only', sourceRef),
            claim('bed and breakfast', 'bb', sourceRef),
          ],
        },
      ],
      issues: [],
    }));

    const request = result.proposal.content.requests[0]!;
    expect(request.kind).toBe('quote');
    if (request.kind !== 'quote') throw new Error('expected quote');
    expect(request.body.groups.map((group) => group.requestedMealPlan).sort()).toEqual([
      'bb',
      'room_only',
    ]);
  });

  it('expands a single Pass 2 group across intentional request-wide board alternatives', async () => {
    const result = await project(
      (sourceRef) => ({
        requests: [
          {
            ...quoteFixture(sourceRef),
            dates: [
              {
                arrival: claim('14 November', '2026-11-14', sourceRef),
                departure: claim('16 November', '2026-11-16', sourceRef),
                roomCount: claim('one room', 1, sourceRef),
              },
            ],
            mealPlanHints: [
              claim('room only', 'room_only', sourceRef),
              claim('bed and breakfast', 'bb', sourceRef),
            ],
          },
        ],
        issues: [],
      }),
      (sourceRef) => ({
        proposal: {
          schemaVersion: 'reservation-prefill.v0.2',
          content: {
            requests: [
              {
                id: 'quote_request',
                requestText: 'Please quote both stays',
                sourceRefs: [sourceRef],
                serviceRefs: [],
                documentRefs: [],
                kind: 'quote',
                body: {
                  groups: [
                    {
                      id: 'pass_2_group',
                      arrival: '2026-11-14',
                      departure: '2026-11-16',
                      quantity: 1,
                      requestedMealPlan: 'BB|room_only',
                      roomCodes: [],
                      ratePlan: null,
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
                  outputIntent: { artifacts: ['email_quote'], evidenceRefs: [sourceRef] },
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
      }),
    );

    const request = result.proposal.content.requests[0]!;
    expect(request.kind).toBe('quote');
    if (request.kind !== 'quote') throw new Error('expected quote');
    expect(request.body.groups.map((group) => group.requestedMealPlan).sort()).toEqual([
      'bb',
      'room_only',
    ]);
    expect(
      result.proposal.issues.some((issue) => issue.kind === 'quote_board_scope_ambiguous'),
    ).toBe(false);
  });
});

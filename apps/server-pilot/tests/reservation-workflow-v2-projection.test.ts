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
  extraction: (sourceRef: string) => ReservationWorkflowV2Extraction,
  synthesis?: (sourceRef: string) => Record<string, unknown>,
): ModelAdapter {
  let call = 0;
  return {
    async invoke(input) {
      call += 1;
      const sourceRef = (JSON.parse(input.userPrompt) as { evidence: Array<{ ref: string }> })
        .evidence[0]!.ref;
      return {
        modelId: 'projection-fixture',
        output: call === 1 ? extraction(sourceRef) : (synthesis?.(sourceRef) ?? {}),
        usage,
      };
    },
  };
}

async function project(
  extraction: (sourceRef: string) => ReservationWorkflowV2Extraction,
  synthesis?: (sourceRef: string) => Record<string, unknown>,
  body = 'Please quote both stays for two adults per room, room only or bed and breakfast.',
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
      attachments: [],
    },
    lookupFixtures: {},
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
  it.each(['create', 'quote', 'amend'] as const)('emits schema-valid source-only note composition for %s', async (kind) => {
      const result = await project(ref => ({ requests: [{ ...quoteFixture(ref), kind,
        requestText: claim('Please arrange', 'Please arrange', ref) }], issues: [] }), undefined,
      'Please arrange. Parking requested.');
      const observations = result.observations.filter(row => row.criteria.kind === 'reservation_note_composition' && row.criteria.workflow === kind);
      expect(observations.length).toBeGreaterThan(0);
      for (const row of observations) {
        expect(reservationWorkflowV2ObservationSchema.safeParse(row).success).toBe(true);
        expect(row.criteria).toMatchObject({ generationId: result.generationId, sourceHash: 'a'.repeat(64), propertyCode: 'HRCEN' });
        expect(row.result).toMatchObject({ limit: 2000, memory: {}, compositionStatus: 'clean' });
      }
      expect(observations.some(row => Array.isArray(row.result.sourceClauses) && row.result.sourceClauses.some((clause: unknown) =>
        typeof clause === 'object' && clause !== null && 'text' in clause && clause.text === 'Parking requested.'))).toBe(true);
      expect(reservationWorkflowV2DraftSchema.safeParse({ contractVersion: 2, schemaVersion: 'reservation-prefill.v0.2',
        workItemId: randomUUID(), transportId: 'projection-transport', propertyCode: 'HRCEN',
        source: { messageId: 'projection-message', threadId: 'projection-thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' },
        generationId: result.generationId, revision: 0, status: result.status, proposal: result.proposal, observations: result.observations,
        fieldReviewRequirements: result.fieldReviewRequirements, staffReviews: {}, operationResults: [], fieldOverrides: {}, errors: result.errors }).success).toBe(true);
  }, 12_000);

  it.each([[1, 1, false, false], [2, 3, false, false], [2, 2, true, false], [2, 2, false, true]])
  ('requires two stays and 80%% purity for note and track memory (%i/%i)', async (support, denominator, applies, webmailDomain) => {
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
    expect(note?.result.memory).toMatchObject({ payer: { support, denominator, autoApplied: applies,
      blockedReason: applies ? null : support < 2 ? 'support_below_min' : webmailDomain ? 'webmail_domain' : 'purity_below_threshold' } });
    expect(Boolean(request.body.shared.reservationNote)).toBe(applies);
    expect(request.body.shared.guaranteeType ?? null).toBe(applies ? 'CC' : null);
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
    expect(note?.result.compositionStatus).toBe(scenario === 'none' ? 'blocked_none' : scenario);
    if (scenario === 'none') expect(request.body.shared.reservationNote).toEqual({ kind: 'none' });
    if (scenario === 'conflict') {
      expect(request.body.shared.reservationNote).toContain('R200');
      expect(request.body.shared.reservationNote).not.toContain('R350');
      expect(note?.result.conflicts).toContain('Dinner allowance differs from the current note.');
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

  it('refuses native prefill and historical parties after selected proof loss while reads remain enabled', async () => {
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    vi.stubEnv('HMS_DAVINCI_ENABLED_PROPERTIES', 'HRDAV,HRDAVS');
    vi.stubEnv('NAVA_BUILD_COMMIT', 'a'.repeat(40));
    vi.stubEnv('HMS_EVIDENCE_HMAC_KEY_VERSION', 'proof-loss-test');
    vi.stubEnv('HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS', 'b'.repeat(64));
    vi.stubEnv('HMS_READ_ROLE_PROOF_V2_ROOT', '/tmp/davinci-p2-no-installed-proofs');
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

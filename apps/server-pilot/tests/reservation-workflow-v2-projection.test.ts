import type { ReservationWorkflowV2Extraction } from '../src/ai/reservation-workflow-v2-contract.js';
import { createReservationWorkflowV2CandidateReader, runReservationWorkflowV2Prefill } from '../src/ai/reservation-workflow-v2-prefill.js';
import * as cloudStay from '../src/ai/hms-cloud-saved-stay-find.js';
import * as paneStaySave from '../src/ai/pane-stay-save.js';
import * as hmsService from '../src/hms/hms-service.js';
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
      bodyText: 'Please quote both stays for two adults per room, room only or bed and breakfast.',
      currentBodyText:
        'Please quote both stays for two adults per room, room only or bed and breakfast.',
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

describe('reservation workflow host projection', () => {
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

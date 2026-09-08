import {
  parseQuoteStayCandidateFromAuthoredSegment,
  quoteStayCandidateFromRequest,
  type QuoteStayCandidate,
} from '../src/hms/quote-stay-candidate.js';
import {
  buildExactOsrravSearchBody,
  buildExactOsrravSearchManifest,
  LIVE_QUOTE_STAY_SEARCH_PATH,
} from '../src/hms/live-read-manifest.js';
import {
  createLiveQuoteStayDriver,
  parseLiveQuoteAvailability,
} from '../src/hms/live-quote-stay-driver.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import { normalizeQuoteRequest } from '../src/hms/quote-request-normalization.js';
import { quoteStayReadDataSchema } from '../src/hms/quote-stay-contract.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import type { HmsBrowserAuditSpec } from '../src/hms/browser-artifacts.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://appsrv-1.legacyhotels.co.za';

function candidate(): QuoteStayCandidate {
  const parsed = parseQuoteStayCandidateFromAuthoredSegment(
    'arrival 2026-09-10, departure 2026-09-12, 2 adults, 0 children, 1 room, room type STD, rate plan BAR',
  );
  expect(parsed).not.toBeNull();
  return parsed!;
}

function liveEnvelope(nights: Array<{ date: string; rate: number; avail: number }>): string {
  return JSON.stringify({
    pageData: {
      success: true,
      values: {
        availabilitydata: {
          uoc: 'ZAR',
          roomTypeInvArray: [
            {
              roomTypeCode: 'STD',
              roomTypeName: 'Standard',
              roomTypeDailyInvArray: nights.map((n) => ({
                date: `${n.date}T00:00:00`,
                numOfAvailable: n.avail,
                closed: false,
              })),
              ratePlanInvArray: [
                {
                  ratePlanCode: 'BAR',
                  ratePlanName: 'Best Available',
                  uoc: 'ZAR',
                  ratePlanDailyInvArray: nights.map((n) => ({
                    date: `${n.date}T00:00:00`,
                    roomRate: n.rate,
                    combNumOfAvailable: n.avail,
                    closed: false,
                    closedToArrival: false,
                    closedToDeparture: false,
                    restricted: false,
                  })),
                },
              ],
            },
          ],
        },
      },
    },
  });
}

function auth(overrides: Partial<HmsSessionAuthorization> = {}): HmsSessionAuthorization {
  const c = candidate();
  const manifest = buildExactOsrravSearchManifest(ORIGIN, c);
  return {
    operationId: randomUUID(),
    toolId: 'hms_quote_stay',
    discoveryOperationId: 'quote_availability_search',
    releaseId: randomUUID(),
    requestBranchId: 'quote_availability_search',
    manifest,
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    roleProofPath: '/tmp/role-proof-quote.v2.json',
    roleProofSha256: 'a'.repeat(64),
    credentialVersionHmacSha256: 'b'.repeat(64),
    runtimeFingerprintSha256: 'c'.repeat(64),
    privateDigestKeyVersion: 'v1',
    sourceRevision: 'test-rev',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function mockRuntime(htmlOrBody: string) {
  const posts: Array<{ path: string; fields: Record<string, string> }> = [];
  const page: Partial<HmsPage> = {
    async content() {
      return '<input name="roomtypes" /><input name="startdate" />';
    },
    async click() {},
    async evaluate(fn: (arg?: unknown) => unknown, arg?: unknown) {
      if (typeof fn === 'function' && fn.length === 0) {
        return {
          property: 'HRCEN',
          currency: 'ZAR',
          salesstrategy: 'TRANSI',
          showunavailable: '0',
          ratetype: 'DR',
          showexclusiverates: '0',
          showavailableforsale: 'on',
          rowpagesize: '14',
          hoteldate: '06-AUG-2026',
          firstcolumndate: '06-AUG-2026',
          pagemode: 'display',
          ONLY_DATA_REQUIRED: 'true',
        };
      }
      return fn(arg);
    },
    async postForm(url: string, fields: Record<string, string>) {
      posts.push({ path: new URL(url).pathname, fields });
      return htmlOrBody;
    },
    waitForCorrelatedResponse: async () => undefined,
  };
  const session = {
    id: 'quote-session',
    origin: ORIGIN,
    page: page as HmsPage,
    violation: () => null,
    terminal: () => false,
    close: vi.fn(async () => undefined),
  };
  const openReadSession = vi.fn(async () => session);
  const runtime = { openReadSession } as unknown as HmsRuntime;
  return { runtime, posts, session, openReadSession };
}

describe('live quote stay parser', () => {
  it('accepts a producer-normalized request and preserves signed observed availability', async () => {
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
    const converted = quoteStayCandidateFromRequest(normalized.request);
    expect(converted).toMatchObject({
      quoteRequestRef: normalized.request.quoteRequestRef,
      childAges: [],
      currency: 'ZAR',
    });

    const { runtime } = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 1200, avail: -2 },
        { date: '2026-09-11', rate: 1250, avail: 2 },
      ]),
    );
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const result = await driver.observeExactQuote(auth(), converted, new AbortController().signal);
    expect(result.data.nightlyObservations[0]?.availableCount).toBe(-2);
    expect(result.data.requestRef).toBe(normalized.request.quoteRequestRef);
    expect(result.data.bookable).toBe(false);
    expect(result.data.unresolvedInputs).toContain('negative_observed_overbooking');
  });

  it('does not collapse a room move into the first segment search', () => {
    const normalized = normalizeQuoteRequest({
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
      segments: [
        {
          arrival: '2026-09-10',
          departure: '2026-09-11',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'STD',
              ratePlanRef: 'BAR',
            },
          ],
        },
        {
          arrival: '2026-09-11',
          departure: '2026-09-12',
          rooms: [
            {
              quantity: 1,
              adultsPerRoom: 2,
              childAges: [],
              roomTypeRef: 'DLX',
              ratePlanRef: 'BAR2',
            },
          ],
        },
      ],
    });
    expect(normalized.status).toBe('ready');
    if (normalized.status !== 'ready') return;
    expect(normalized.request.roomMoveRequired).toBe(true);
    expect(quoteStayCandidateFromRequest(normalized.request)).toBeNull();
  });

  it('maps availabilitydata nights with currency/basis/restrictions', () => {
    const c = candidate();
    const parsed = parseLiveQuoteAvailability(
      liveEnvelope([
        { date: '2026-09-10', rate: 1200, avail: 3 },
        { date: '2026-09-11', rate: 1250.5, avail: 2 },
      ]),
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-09-10',
      roomType: 'STD',
      ratePlan: 'BAR',
      availableCount: 3,
      displayedAmount: '1200.00',
      currency: 'ZAR',
      rateBasis: 'nightly',
      restrictions: ['none'],
    });
    expect(
      quoteStayReadDataSchema.parse({
        nightlyObservations: parsed.rows,
        bookable: false,
        stayTotal: null,
        occupancyPriced: false,
        requestedRooms: 1,
      }).nightlyObservations,
    ).toHaveLength(2);
  });

  it('rejects fixture HTML fallback', () => {
    const c = candidate();
    expect(() =>
      parseLiveQuoteAvailability(
        '<tr data-testid="quote-night" data-date="2026-09-10"></tr>',
        c,
        new Date(),
      ),
    ).toThrow(/fixture HTML/);
  });

  it('marks search error envelope recognized with unresolved', () => {
    const c = candidate();
    const parsed = parseLiveQuoteAvailability(
      '{ "pageData": { "success": false, "messages":[{"type":"error","msg":"x"}] } }',
      c,
      new Date(),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.unresolvedFields).toContain('quote_search_error');
  });
});

describe('live quote stay driver', () => {
  it('posts exact OSRRAV search and returns contiguous nights', async () => {
    const c = candidate();
    const { runtime, posts } = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
    );
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const result = await driver.observeExactQuote(auth(), c, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.data.nightlyObservations).toHaveLength(2);
    expect(posts[0]?.path).toBe(LIVE_QUOTE_STAY_SEARCH_PATH);
    expect(posts[0]?.fields.roomtypes).toBe('STD');
    expect(posts[0]?.fields.rateplans).toBe('BAR');
    expect(posts[0]?.fields.startdate).toBe('10-SEP-2026');
  });

  it('passes the normal audited execution spec into the live session', async () => {
    const c = candidate();
    const { runtime, openReadSession } = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
    );
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-audit-operation',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
    };
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
      auditSpecFor: () => auditSpec,
    });
    await driver.observeExactQuote(auth(), c, new AbortController().signal);
    expect(openReadSession.mock.calls[0]?.[0]).toMatchObject({ auditSpec });
  });

  it('binds requester authorization tool/claim kind', async () => {
    const { runtime } = mockRuntime(liveEnvelope([]));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    await expect(
      driver.observeExactQuote(
        auth({ toolId: 'hms_find_reservation' as never }),
        candidate(),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HmsRuntimeError);
  });

  it('returns ambiguity unresolved when duplicate nights', async () => {
    const body = liveEnvelope([
      { date: '2026-09-10', rate: 100, avail: 1 },
      { date: '2026-09-11', rate: 110, avail: 1 },
    ]);
    // inject second rate plan same nights → ambiguity after filter? use two room types
    const dual = JSON.parse(body);
    dual.pageData.values.availabilitydata.roomTypeInvArray.push(
      structuredClone(dual.pageData.values.availabilitydata.roomTypeInvArray[0]),
    );
    dual.pageData.values.availabilitydata.roomTypeInvArray[1].roomTypeCode = 'STD';
    const { runtime } = mockRuntime(JSON.stringify(dual));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const result = await driver.observeExactQuote(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.unresolvedFields.some((f) => f.includes('ambiguous'))).toBe(true);
  });

  it('denies unrelated room/rate rows instead of relabeling them as requested', async () => {
    const body = JSON.parse(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
    );
    const availability = body.pageData.values.availabilitydata;
    availability.roomTypeInvArray[0].roomTypeCode = 'DLX';
    availability.roomTypeInvArray[0].ratePlanInvArray[0].ratePlanCode = 'BAR2';
    const { runtime } = mockRuntime(JSON.stringify(body));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const result = await driver.observeExactQuote(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('manual_required');
    expect(result.data.nightlyObservations).toHaveLength(0);
    expect(result.unresolvedFields).toContain('room_rate_scope_mismatch');
  });

  it('returns unverified negative on empty availability', async () => {
    const empty = JSON.stringify({
      pageData: {
        success: true,
        values: { availabilitydata: { uoc: 'ZAR', roomTypeInvArray: [] } },
      },
    });
    const { runtime } = mockRuntime(empty);
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const result = await driver.observeExactQuote(
      auth(),
      candidate(),
      new AbortController().signal,
    );
    expect(result.status).toBe('unverified_negative');
  });

  it('propagates abort', async () => {
    const { runtime } = mockRuntime(liveEnvelope([]));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    const ac = new AbortController();
    ac.abort();
    await expect(driver.observeExactQuote(auth(), candidate(), ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects on timeout abort signal', async () => {
    const page: Partial<HmsPage> = {
      async content() {
        return '<input name="roomtypes" />';
      },
      async click() {},
      async evaluate() {
        return {};
      },
      async postForm() {
        await new Promise((r) => setTimeout(r, 5_000));
        return liveEnvelope([]);
      },
    };
    const session = {
      id: 'quote-timeout',
      origin: ORIGIN,
      page: page as HmsPage,
      violation: () => null,
      terminal: () => false,
      close: vi.fn(async () => undefined),
    };
    const runtime = {
      openReadSession: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return session;
      }),
    } as unknown as HmsRuntime;
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    await expect(
      driver.observeExactQuote(auth(), candidate(), AbortSignal.timeout(1)),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'),
    );
  });

  it('rejects denied wrong-scope request branch', async () => {
    const { runtime } = mockRuntime(liveEnvelope([]));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    await expect(
      driver.observeExactQuote(
        auth({ requestBranchId: 'guest_stay_search' }),
        candidate(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'ROLE_SCOPE_INVALID',
    });
  });

  it('rejects stale expired authorization', async () => {
    const { runtime } = mockRuntime(liveEnvelope([]));
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
    });
    await expect(
      driver.observeExactQuote(
        auth({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        candidate(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'ROLE_PROOF_EXPIRED',
    });
  });

  it('builds exact manifest with OSRRAV search path only for search POST', () => {
    const c = candidate();
    const manifest = buildExactOsrravSearchManifest(ORIGIN, c);
    expect(requestPolicyManifestSchema.parse(manifest)).toEqual(manifest);
    const search = manifest.rules.find((r) => r.id === 'live-osrrav-search-exact');
    expect(search?.path).toBe(LIVE_QUOTE_STAY_SEARCH_PATH);
    const body = buildExactOsrravSearchBody(c);
    expect(body.USER_FUNCTION_NAME).toBe('OSRRAV');
    expect(body.roomtypes).toBe('STD');
  });
});

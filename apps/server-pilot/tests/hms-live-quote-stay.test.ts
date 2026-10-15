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
import { buildQuoteStayReadData, quoteStayReadDataSchema } from '../src/hms/quote-stay-contract.js';
import { issueTrustedRequesterAuthorization } from '../src/hms/requester-authorization.js';
import { syntheticQuoteReferenceAuthority } from './helpers/quote-reference-authority.js';
import { HmsRuntimeError, type HmsPage, type HmsRuntime } from '../src/hms/runtime.js';
import { normalizeQuoteRequest } from '../src/hms/quote-request-normalization.js';
import type { HmsSessionAuthorization } from '../src/hms/release-kernel.js';
import type { HmsBrowserAuditSpec } from '../src/hms/browser-artifacts.js';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { evaluateObservedRequest } from '../src/hms/request-policy.js';
import { requestPolicyManifestSchema } from '../src/hms/contracts.js';
import { renderClaim } from '../src/ai/draft-evidence.js';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

function claimAuthorizationFor(at: Date) {
  const state = {
    operationId: 'quote-claim-operation',
    mailboxGrant: { sha256: 'a'.repeat(64), transportId: 'quote-transport', active: true },
    thread: {
      transportId: 'quote-transport',
      threadId: 'quote-thread',
      stateVersion: 'quote-thread-v1',
    },
    requester: {
      identity: 'quote-requester',
      requesterClass: 'reservation_guest',
      inquiryClass: 'quote_request',
      allowedClaimKinds: ['quote'],
      forwarded: false,
      spoofed: false,
    },
  };
  const key = Buffer.alloc(32, 0x41);
  const authorization = issueTrustedRequesterAuthorization(state, {
    key,
    keyVersion: 'quote-claim-key-v1',
    issuedAt: at,
    expiresAt: new Date(at.getTime() + 5 * 60_000),
  });
  return {
    authorization,
    currentState: state,
    key,
    expectedPrivateDigestKeyVersion: 'quote-claim-key-v1',
    now: at,
  };
}

function mockRuntime(htmlOrBody: string, receipt: Record<string, unknown> | null = null) {
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
    lastReceipt: vi.fn(() => receipt),
    close: vi.fn(async () => undefined),
  };
  const openReadSession = vi.fn(async () => session);
  const runtime = { openReadSession } as unknown as HmsRuntime;
  return { runtime, posts, session, openReadSession };
}

describe('live quote stay parser', () => {
  it('accepts a producer-normalized request and preserves signed observed availability', async () => {
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
    const normalized = normalizeQuoteRequest(
      {
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
      },
      {
        referenceAuthority: syntheticQuoteReferenceAuthority,
      },
    );
    expect(normalized.status).toBe('clarification');
    if (normalized.status !== 'clarification') return;
    expect(normalized.unresolvedInputs).toContain('segment_room_shape_mismatch');
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

  it('parses live mixed pageData with unquoted values key', () => {
    const c = candidate();
    // Shape observed on HRCEN OSRRAV.HDR.search (quoted pageData, bare values:).
    const mixed = `{

"pageData": {
	values:{"isPopup":null,"pagemode":"display","availabilitydata":{"uoc":"ZAR","roomTypeInvArray":[{"roomTypeCode":"DLXQN","ratePlanInvArray":[{"ratePlanCode":"BAR","uoc":"ZAR","ratePlanDailyInvArray":[{"date":"09/15/2026","numOfAvailable":2,"roomRate":1100,"combNumOfAvailable":2}]}],"roomTypeDailyInvArray":[{"date":"09/15/2026","numOfAvailable":2}]}]}}
}}`;
    const parsed = parseLiveQuoteAvailability(
      mixed,
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    );
    expect(parsed.envelopeRecognized).toBe(true);
    expect(parsed.rows.length).toBeGreaterThanOrEqual(1);
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-09-15',
      roomType: 'DLXQN',
      ratePlan: 'BAR',
      availableCount: 2,
      displayedAmount: '1100.00',
      currency: 'ZAR',
    });
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

  it('uses the requested currency in the exact OSRRAV body and accepts that body at the firewall', () => {
    const c = { ...candidate(), currency: 'USD' };
    const chrome = {
      property: 'HRCEN',
      salesstrategy: 'TRANSI',
      showunavailable: '0',
      showavailableforsale: 'on',
      currency: 'ZAR',
      rowpagesize: '14',
      pagemode: 'display',
      ONLY_DATA_REQUIRED: 'true',
    };
    const body = buildExactOsrravSearchBody(c, chrome);
    expect(body.currency).toBe('USD');
    expect(body.currency_display).toBe('USD');
    const manifest = buildExactOsrravSearchManifest(ORIGIN, c, chrome);
    const decision = evaluateObservedRequest(manifest, {
      url: `${ORIGIN}${LIVE_QUOTE_STAY_SEARCH_PATH}`,
      method: 'POST',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      postData: new URLSearchParams(body).toString(),
    });
    expect(decision).toMatchObject({ action: 'allow', ruleId: 'live-osrrav-search-exact' });
    expect(
      evaluateObservedRequest(manifest, {
        url: `${ORIGIN}${LIVE_QUOTE_STAY_SEARCH_PATH}`,
        method: 'POST',
        resourceType: 'xhr',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: new URLSearchParams({ ...body, property: 'OTHER' }).toString(),
      }),
    ).toMatchObject({ action: 'block', code: 'changed_property' });
  });

  it('does not label or sum observations whose currency differs from the request', () => {
    const c = { ...candidate(), currency: 'USD' };
    const rows = parseLiveQuoteAvailability(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    ).rows;
    const data = buildQuoteStayReadData({
      nightlyObservations: rows,
      requestedRooms: 1,
      requestRef: c.quoteRequestRef,
      arrival: c.arrivalDate,
      departure: c.departureDate,
      rooms: c.normalizedRooms,
      currency: c.currency,
    });
    expect(data.displayRateSum).toBeNull();
    expect(data.unresolvedInputs).toContain('currency_mismatch');
  });

  it('retains page currency and rejects a page/source currency mismatch before arithmetic', () => {
    const c = { ...candidate(), currency: 'USD' };
    const parsed = parseLiveQuoteAvailability(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]).replace('"uoc":"ZAR","ratePlanDailyInvArray"', '"uoc":"USD","ratePlanDailyInvArray"'),
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    );
    expect(parsed.currency).toBe('ZAR');
    expect(parsed.rows[0]?.currency).toBe('USD');
    expect(parsed.unresolvedFields).toContain('source_currency_mismatch');
    const data = buildQuoteStayReadData({
      nightlyObservations: parsed.rows,
      requestedRooms: 1,
      requestRef: c.quoteRequestRef,
      arrival: c.arrivalDate,
      departure: c.departureDate,
      rooms: c.normalizedRooms,
      currency: c.currency,
      sourceCurrency: parsed.currency,
      unresolvedInputs: parsed.unresolvedFields,
    });
    expect(data.sourceCurrency).toBe('ZAR');
    expect(data.displayRateSum).toBeNull();
    expect(data.unresolvedInputs).toContain('source_currency_mismatch');
  });

  it('keeps source currency unknown when the page and rate rows omit currency', () => {
    const c = candidate();
    const parsed = parseLiveQuoteAvailability(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]).replaceAll('"uoc":"ZAR"', '"uoc":null'),
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    );
    expect(parsed.currency).toBeNull();
    expect(parsed.unresolvedFields).toContain('source_currency_unresolved');
    const data = buildQuoteStayReadData({
      nightlyObservations: parsed.rows,
      requestedRooms: 1,
      arrival: c.arrivalDate,
      departure: c.departureDate,
      rooms: c.normalizedRooms,
      currency: c.currency,
      sourceCurrency: parsed.currency,
      unresolvedInputs: parsed.unresolvedFields,
    });
    expect(data.sourceCurrency).toBeNull();
    expect(data.displayRateSum).toBeNull();
  });

  it('does not emit display arithmetic for duplicate selected nights', () => {
    const c = candidate();
    const rows = parseLiveQuoteAvailability(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
      c,
      new Date('2026-08-06T00:00:00.000Z'),
    ).rows;
    const data = buildQuoteStayReadData({
      nightlyObservations: [...rows, rows[0]!],
      requestedRooms: 1,
      arrival: c.arrivalDate,
      departure: c.departureDate,
      rooms: c.normalizedRooms,
      currency: 'ZAR',
      unresolvedInputs: ['nightly.2026-09-10.ambiguous'],
    });
    expect(data.displayRateSum).toBeNull();
    expect(data.unresolvedInputs).toContain('nightly.2026-09-10.ambiguous');
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
      propertyCode: 'DVIN',
    });
    const result = await driver.observeExactQuote(auth(), c, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.evidence?.propertyCode).toBe('DVIN');
    expect(result.data.nightlyObservations).toHaveLength(2);
    expect(posts[0]?.path).toBe(LIVE_QUOTE_STAY_SEARCH_PATH);
    expect(posts[0]?.fields.roomtypes).toBe('STD');
    expect(posts[0]?.fields.rateplans).toBe('BAR');
    expect(posts[0]?.fields.startdate).toBe('10-SEP-2026');
  });

  it('propagates page-versus-rate currency mismatch into the durable observer result', async () => {
    const c = { ...candidate(), currency: 'USD' };
    const { runtime } = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]).replace('"uoc":"ZAR","ratePlanDailyInvArray"', '"uoc":"USD","ratePlanDailyInvArray"'),
    );
    const driver = createLiveQuoteStayDriver({ runtime, transportId: 'transport-centurion' });
    const result = await driver.observeExactQuote(auth(), c, new AbortController().signal);
    expect(result.status).toBe('manual_required');
    expect(result.data.sourceCurrency).toBe('ZAR');
    expect(result.data.displayRateSum).toBeNull();
    expect(result.data.unresolvedInputs).toContain('source_currency_mismatch');
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
      requestBranchId: 'quote_availability_search',
    };
    const driver = createLiveQuoteStayDriver({
      runtime,
      transportId: 'transport-centurion',
      auditSpecFor: () => auditSpec,
    });
    await driver.observeExactQuote(auth(), c, new AbortController().signal);
    expect(openReadSession.mock.calls[0]?.[0]).toMatchObject({ auditSpec });
  });

  it('uses a per-run evidence identity and links an audited result to its finalized receipt', async () => {
    const c = candidate();
    const receipt = {
      schemaVersion: 1,
      artifactId: 'quote-artifact-1',
      operationId: 'quote-audit-operation',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
      requestBranchId: 'quote_availability_search',
      operationOutcome: 'succeeded',
      artifactState: 'complete',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-audit-operation',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
    };
    const firstFixture = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
      receipt,
    );
    const secondFixture = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 200, avail: 1 },
        { date: '2026-09-11', rate: 210, avail: 1 },
      ]),
    );
    const first = await createLiveQuoteStayDriver({
      runtime: firstFixture.runtime,
      transportId: 'transport-centurion',
      auditSpecFor: () => auditSpec,
    }).observeExactQuote(auth(), c, new AbortController().signal);
    const second = await createLiveQuoteStayDriver({
      runtime: secondFixture.runtime,
      transportId: 'transport-centurion',
    }).observeExactQuote(auth(), c, new AbortController().signal);
    expect(first.evidence.kind).toBe('hms');
    expect(second.evidence.kind).toBe('hms');
    if (first.evidence.kind !== 'hms' || second.evidence.kind !== 'hms') return;
    expect(first.evidence.id).not.toBe(second.evidence.id);
    expect(first.evidence.sourceHash).not.toBe(second.evidence.sourceHash);
    expect(first.evidence.artifactRef).toBe('quote-artifact-1');
    expect(first.evidence.scopeVerified).toBe(true);
    expect(first.evidence.manifestSha256).toBe(auth().manifestSha256);
    expect(first.evidence.manifestSha256ByBranch).toEqual({
      quote_availability_search: auth().manifestSha256,
    });
    const observedAt = new Date();
    const claims = claimsFromToolResult(first, observedAt, claimAuthorizationFor(observedAt));
    expect(claims).toHaveLength(1);
    expect(claims[0]?.kind).toBe('quote_stay_summary');
    expect(renderClaim(claims[0]!)).toMatch(
      /not bookable, no stay total, and occupancy pricing is unverified/,
    );
  });

  it('bounds typed quote evidence by the actual finalized capture expiry', async () => {
    const c = candidate();
    const receiptExpiry = new Date(Date.now() + 2_000).toISOString();
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-expiry-authority',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
      requestBranchId: 'quote_availability_search',
    };
    const fixture = mockRuntime(
      liveEnvelope([
        { date: '2026-09-10', rate: 100, avail: 1 },
        { date: '2026-09-11', rate: 110, avail: 1 },
      ]),
      {
        artifactId: 'quote-expiry-artifact',
        operationId: auditSpec.operationId,
        toolId: auditSpec.toolId,
        toolVersion: auditSpec.toolVersion,
        executionClass: auditSpec.executionClass,
        inputClass: auditSpec.inputClass,
        requestBranchId: auditSpec.requestBranchId,
        operationOutcome: 'succeeded',
        artifactState: 'complete',
        expiresAt: receiptExpiry,
      },
    );
    const result = await createLiveQuoteStayDriver({
      runtime: fixture.runtime,
      transportId: 'transport-centurion',
      auditSpecFor: () => auditSpec,
    }).observeExactQuote(auth(), c, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.evidence.kind).toBe('hms');
    if (result.evidence.kind === 'hms') {
      expect(result.evidence.expiresAt).toBe(receiptExpiry);
    }
  });

  it('does not bind a quote to a mismatched or unsuccessful finalized receipt', async () => {
    const c = candidate();
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-receipt-negative',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
      requestBranchId: 'quote_availability_search',
    };
    for (const receiptPatch of [
      { requestBranchId: 'wrong_branch', operationOutcome: 'succeeded' },
      { requestBranchId: 'quote_availability_search', operationOutcome: 'failed' },
    ]) {
      const fixture = mockRuntime(
        liveEnvelope([
          { date: '2026-09-10', rate: 100, avail: 1 },
          { date: '2026-09-11', rate: 110, avail: 1 },
        ]),
        {
          artifactId: `quote-negative-${receiptPatch.operationOutcome}`,
          operationId: auditSpec.operationId,
          toolId: auditSpec.toolId,
          toolVersion: auditSpec.toolVersion,
          executionClass: auditSpec.executionClass,
          inputClass: auditSpec.inputClass,
          ...receiptPatch,
          artifactState: 'complete',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      );
      const result = await createLiveQuoteStayDriver({
        runtime: fixture.runtime,
        transportId: 'transport-centurion',
        auditSpecFor: () => auditSpec,
      }).observeExactQuote(auth(), c, new AbortController().signal);
      expect(result.status).toBe('manual_required');
      expect(result.unresolvedFields).toContain('audit_capture_receipt');
      expect(result.evidence.kind).toBe('hms');
      if (result.evidence.kind === 'hms') expect(result.evidence.artifactRef).toBeUndefined();
    }
  });

  it('rejects a stale, wrong-version, empty-artifact, or branchless finalized receipt', async () => {
    const c = candidate();
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-receipt-freshness-negative',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
      requestBranchId: 'quote_availability_search',
    };
    const patches = [
      { toolVersion: '9.9.9' },
      { artifactId: '' },
      { expiresAt: '2000-01-01T00:00:00.000Z' },
      { requestBranchId: undefined },
    ];
    for (const [index, patch] of patches.entries()) {
      const fixture = mockRuntime(
        liveEnvelope([
          { date: '2026-09-10', rate: 100, avail: 1 },
          { date: '2026-09-11', rate: 110, avail: 1 },
        ]),
        {
          artifactId: `quote-freshness-negative-${index}`,
          operationId: auditSpec.operationId,
          toolId: auditSpec.toolId,
          toolVersion: auditSpec.toolVersion,
          executionClass: auditSpec.executionClass,
          inputClass: auditSpec.inputClass,
          requestBranchId: auditSpec.requestBranchId,
          operationOutcome: 'succeeded',
          artifactState: 'complete',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...patch,
        },
      );
      const result = await createLiveQuoteStayDriver({
        runtime: fixture.runtime,
        transportId: 'transport-centurion',
        auditSpecFor: () => auditSpec,
      }).observeExactQuote(auth(), c, new AbortController().signal);
      expect(result.status).toBe('manual_required');
      expect(result.draftReady).toBe(false);
      expect(result.unresolvedFields).toContain('audit_capture_receipt');
      expect(result.evidence.kind).toBe('hms');
      if (result.evidence.kind === 'hms') expect(result.evidence.artifactRef).toBeUndefined();
    }
  });

  it('rejects missing and malformed finalized receipt expiry independently', async () => {
    const c = candidate();
    const auditSpec: HmsBrowserAuditSpec = {
      operationId: 'quote-receipt-expiry-shape-negative',
      toolId: 'hms_quote_stay',
      toolVersion: '2.0.0',
      dependencyRevision: 'playwright-1.52.0-chromium-1169',
      executionClass: 'normal',
      inputClass: 'authorized_exact',
      requestBranchId: 'quote_availability_search',
    };
    for (const [label, expiresAt] of [
      ['missing', undefined],
      ['malformed', 'not-a-timestamp'],
    ] as const) {
      const fixture = mockRuntime(
        liveEnvelope([
          { date: '2026-09-10', rate: 100, avail: 1 },
          { date: '2026-09-11', rate: 110, avail: 1 },
        ]),
        {
          artifactId: `quote-expiry-shape-${label}`,
          operationId: auditSpec.operationId,
          toolId: auditSpec.toolId,
          toolVersion: auditSpec.toolVersion,
          executionClass: auditSpec.executionClass,
          inputClass: auditSpec.inputClass,
          requestBranchId: auditSpec.requestBranchId,
          operationOutcome: 'succeeded',
          artifactState: 'complete',
          expiresAt,
        },
      );
      const result = await createLiveQuoteStayDriver({
        runtime: fixture.runtime,
        transportId: 'transport-centurion',
        auditSpecFor: () => auditSpec,
      }).observeExactQuote(auth(), c, new AbortController().signal);
      expect(result.status, label).toBe('manual_required');
      expect(result.unresolvedFields, label).toContain('audit_capture_receipt');
    }
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

  it('keeps the reviewed static OSRRAV policy template byte-equivalent to the builder', () => {
    const c = candidate();
    const dynamic = buildExactOsrravSearchManifest(ORIGIN, c).rules.find(
      (rule) => rule.id === 'live-osrrav-search-exact',
    );
    const staticManifest = JSON.parse(
      readFileSync(
        new URL(
          '../src/hms/request-manifests/hms_quote_stay.availability.2.0.0.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { manifest?: { rules?: Array<Record<string, unknown>> } };
    const reviewed = staticManifest.manifest?.rules?.find(
      (rule) => rule.id === 'live-osrrav-search-exact',
    );
    expect(dynamic).toBeDefined();
    expect(reviewed).toBeDefined();
    expect({
      method: reviewed?.method,
      path: reviewed?.path,
      resourceTypes: reviewed?.resourceTypes,
      contentType: reviewed?.contentType,
      fixedBody: reviewed?.fixedBody,
      variableBody: reviewed?.variableBody,
      maxBodyBytes: reviewed?.maxBodyBytes,
      redirectPolicy: reviewed?.redirectPolicy,
    }).toEqual({
      method: dynamic?.method,
      path: dynamic?.path,
      resourceTypes: dynamic?.resourceTypes,
      contentType: dynamic?.contentType,
      fixedBody: dynamic?.fixedBody,
      variableBody: dynamic?.variableBody,
      maxBodyBytes: dynamic?.maxBodyBytes,
      redirectPolicy: dynamic?.redirectPolicy,
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, mkdtemp: (prefix: string) => fs.mkdtemp(prefix.replace('/var/tmp/', '/tmp/')) };
});
import { hmsReadTargetForProperty } from '../src/hms/hms-read-target.js';
import { projectCloudAvailability, runCloudAvailability } from '../src/ai/hms-cloud-availability-reader.js';
import { readQuoteRestAvailability } from '../tooling/hms-cloud/quote-rest-availability.mjs';
import { selectionFixture } from '../tooling/hms-cloud/fetch-quote-fixtures.mjs';

const session = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../tooling/hms-cloud/cloud-session.mjs', () => ({ withCloudReadSession: session.open }));

const target = hmsReadTargetForProperty('HRCEN');
const request = { kind: 'availability' as const, arrival: '2026-09-24', departure: '2026-09-27',
  rooms: [{ roomType: 'Standard', quantity: 2, adults: 1, childAges: [] }] };
const criteria = { propertyCode: 'HRCEN', arrivalDate: request.arrival, departureDate: request.departure,
  adults: 1, childAges: [], roomTypeCodes: [], ratePlanCodes: [] };
const cookies = vi.fn(async () => [
  { name: 'BSSTRT', value: 'http-only-session', httpOnly: true },
  { name: 'OTHER', value: 'session-cookie', httpOnly: false },
]);
const page = { context: () => ({ cookies }), evaluate: vi.fn(async () => 'booking-secret') };
const identity = { propertyCode: 'HRCEN', tenantId: 'THECENTURION_PRD', landingPropertyCode: 'HRCEN', origin: target.origin };
const fetchMock = vi.fn();

beforeEach(() => {
  session.open.mockReset();
  cookies.mockClear();
  page.evaluate.mockReset().mockResolvedValue('booking-secret');
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('HMS_QUOTE_REST_FAST_PATH', 'on');
  session.open.mockImplementation(async (operation, options) => {
    if (options.startScreen === 'OSRESS') return operation({}, { ...identity, propertyCode: 'HRDAV' });
    return operation(page, identity, { credentialVersionHmacSha256: 'a'.repeat(64), signal: options.signal ?? new AbortController().signal });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function validResponse(_url: string, options: RequestInit) {
  const body = JSON.parse(String(options.body));
  return new Response(JSON.stringify({ appliedCriteria: body, availabilitydata: selectionFixture().data }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('opt-in REST availability', () => {
  it.each(['', 'off', 'ON', 'true'])('does no REST session work for flag %s', async flag => {
    vi.stubEnv('HMS_QUOTE_REST_FAST_PATH', flag);
    await runCloudAvailability({ request, target });
    expect(session.open).toHaveBeenCalledTimes(1);
    expect(session.open.mock.calls[0]?.[1]).toMatchObject({ startScreen: 'OSRESS' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });

  it('captures HttpOnly cookies and projects only explicit REST evidence', async () => {
    fetchMock.mockImplementation(validResponse);
    const reads = await runCloudAvailability({ request, target, transportId: 'transport-centurion' });
    expect(session.open).toHaveBeenCalledTimes(1);
    expect(session.open.mock.calls[0]?.[1]).toMatchObject({ startScreen: 'BSSTRT', requireBoundCredentialVersion: true });
    expect(cookies).toHaveBeenCalledWith(target.origin);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${target.origin}/api/internalBooking/rateshop/inquiryForGrid?houseAvailabilityOnly=false`);
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual',
      headers: { cookie: 'BSSTRT=http-only-session; OTHER=session-cookie' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const result = projectCloudAvailability(request, reads);
    expect(result.outcome).toBe('read');
    if (result.outcome !== 'read') throw new Error('expected REST read');
    expect(result.priceEvidence).toMatchObject({ label: 'estimate', officialTotal: 'unknown' });
    expect(result.searchOutcome).toBe('partial');
    expect(result.groups[0]?.coverage).toMatchObject({ evidenceKind: 'rest_availability_read',
      criteriaEchoVerified: true, domCalendarVerified: false, screenshotsVerified: false,
      displayedRounding: 'unverified_no_dom', payableTotal: 'unverified',
      checkedCriteriaMatch: { roomTypes: null, ratePlans: null } });
    expect(result.groups[0]?.options[0]?.nightly[0]?.stockStatus).toBe('unknown');
    expect(result.groups[0]?.options[0]?.nightly[0]?.price).toMatchObject({ status: 'known', amount: '1780',
      source: 'rest_availability_read', displayedRounding: 'unverified_no_dom' });
    expect(JSON.stringify(result)).not.toContain('booking-secret');
    expect(JSON.stringify(result)).not.toContain('http-only-session');
  });

  it('projects property closures and missing rate flags without claiming available stock', async () => {
    fetchMock.mockImplementation((_url: string, options: RequestInit) => {
      const fixture = selectionFixture();
      fixture.data.children[0].columns = Object.fromEntries([1, 2, 3].map(i => [`col${i}`, { restricted: false }]));
      fixture.data.children[0].columns.col1.restricted = true;
      delete fixture.rate.columns.col1.israteavailable;
      delete fixture.rate.columns.col2.israteavailable;
      return new Response(JSON.stringify({ appliedCriteria: JSON.parse(String(options.body)), availabilitydata: fixture.data }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = projectCloudAvailability(request, await runCloudAvailability({ request, target }));
    if (result.outcome !== 'read') throw new Error('expected REST read');
    expect(result.groups[0]?.options[0]?.nightly[0]?.stockStatus).toBe('restricted');
    expect(result.groups[0]?.options[0]?.nightly[0]?.restrictionEvidence).toMatchObject({
      closedOrRestricted: true, unknownRestrictionFlags: expect.arrayContaining(['rateCell.israteavailable']),
    });
    expect(result.groups[0]?.options[0]?.nightly[1]?.stockStatus).toBe('unknown');
  });

  it('uses the existing browser path for full details or an unverified party', async () => {
    await runCloudAvailability({ request, target, details: 'full' });
    expect(session.open.mock.calls[0]?.[1]).toMatchObject({ startScreen: 'OSRESS' });
    session.open.mockClear();
    const scoped = { ...request, rooms: [{ ...request.rooms[0]!, roomType: 'STQN' }],
      rateParties: { organization: { nativeId: '123', name: 'Example Company' } },
      rateContext: { propertyCode: 'HRCEN', workflow: 'quote' as const, arrival: request.arrival, departure: request.departure,
        roomCode: 'STQN', quantity: 2, adults: 1, childAges: [], mealPlan: null, currency: 'ZAR',
        organizationId: '123', bookingAgencyId: null, guestProfileId: null, sourceOfBusiness: null, track: null,
        guaranteeType: null, typedRatePlan: null, savedTarget: null, retainRates: null } };
    await runCloudAvailability({ request: scoped, target });
    expect(session.open.mock.calls[0]?.[1]).toMatchObject({ startScreen: 'OSRESS' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://other.invalid' } })],
    ['unauthorized', () => new Response('denied', { status: 401 })],
    ['forbidden', () => new Response('denied', { status: 403 })],
    ['server error', () => new Response('denied', { status: 503 })],
    ['HTML shell', () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['malformed JSON', () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['missing echo', () => new Response(JSON.stringify({ availabilitydata: selectionFixture().data }),
      { status: 200, headers: { 'content-type': 'application/json' } })],
  ])('falls back after a %s response', async (_name, response) => {
    fetchMock.mockImplementation(response);
    const reads = await runCloudAvailability({ request, target });
    expect(session.open.mock.calls.map(call => call[1].startScreen)).toEqual(['BSSTRT', 'OSRESS']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([{ outcome: 'execution_failure', issue: 'CLOUD_SESSION_IDENTITY_MISMATCH' }]);
    expect(JSON.stringify(reads)).not.toContain('session-cookie');
  });

  it('does not send HTTP for missing booking session or unsafe cookies', async () => {
    page.evaluate.mockResolvedValueOnce('');
    const missing = await readQuoteRestAvailability({ propertyCode: 'HRCEN', criteria: [criteria] });
    expect(missing).toMatchObject({ outcome: 'unsupported_context', issue: 'REST_SESSION_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
    cookies.mockResolvedValueOnce([{ name: 'BSSTRT', value: 'bad;cookie', httpOnly: true }]);
    const unsafe = await readQuoteRestAvailability({ propertyCode: 'HRCEN', criteria: [criteria] });
    expect(unsafe).toMatchObject({ outcome: 'unsupported_context', issue: 'REST_SESSION_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the browser when REST session context is unavailable', async () => {
    page.evaluate.mockResolvedValueOnce('');
    const reads = await runCloudAvailability({ request, target });
    expect(session.open.mock.calls.map(call => call[1].startScreen)).toEqual(['BSSTRT', 'OSRESS']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reads).toEqual([{ outcome: 'execution_failure', issue: 'CLOUD_SESSION_IDENTITY_MISMATCH' }]);
  });

  it('evicts failed session material and captures new cookies on a subsequent invocation', async () => {
    fetchMock.mockRejectedValueOnce(new Error('secret-session-cookie')).mockImplementationOnce(validResponse);
    const first = await readQuoteRestAvailability({ propertyCode: 'HRCEN', criteria: [criteria] });
    const second = await readQuoteRestAvailability({ propertyCode: 'HRCEN', criteria: [criteria] });
    expect(first).toMatchObject({ outcome: 'execution_failure', issue: 'REST_AVAILABILITY_FAILED' });
    expect(JSON.stringify(first)).not.toContain('secret-session-cookie');
    expect(['partial', 'rest_observed']).toContain(second.outcome);
    expect(cookies).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized streamed response before reading the rest', async () => {
    const cancel = vi.fn();
    let sent = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
    const result = await readQuoteRestAvailability({ propertyCode: 'HRCEN', criteria: [criteria] });
    expect(result).toMatchObject({ outcome: 'execution_failure', issue: 'REST_AVAILABILITY_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates caller cancellation without falling back or retrying', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      controller.abort(new DOMException('cancelled', 'AbortError'));
    }));
    await expect(runCloudAvailability({ request, target, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.open).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

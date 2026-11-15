import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createExistingOwnerNativeQuoteReader } from '../src/ai/reservationist-evaluation-composition.js';
import type { QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';

const cloud = vi.hoisted(() => ({ fetchQuote: vi.fn(), capability: vi.fn() }));
vi.mock('../tooling/hms-cloud/fetch-quote.mjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tooling/hms-cloud/fetch-quote.mjs')>()),
  fetchQuote: cloud.fetchQuote,
}));
vi.mock('../src/hms/hms-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hms/hms-service.js')>()),
  nativeReadCapabilityAvailable: cloud.capability,
}));

const privateRoot = fileURLToPath(new URL('../../../.private/hms-cloud', import.meta.url));
const owner = { propertyCode: 'HRCEN', transportId: 'transport-centurion' };
const request: QuoteSourceRecord['request'] = {
  propertyCode: 'HRCEN', requestedCurrency: 'ZAR',
  arrivalDate: '2026-11-12', departureDate: '2026-11-14',
  rooms: [{ id: 'room-1', quantity: 1, adults: 2, children: 0, childAges: [] }],
};
let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
  vi.resetAllMocks();
});

async function savedCapture(result: Record<string, unknown>) {
  root = join(privateRoot, `test-${randomUUID()}`);
  const evidence = join(root, 'out', 'run');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result));
  cloud.capability.mockResolvedValue(true);
  cloud.fetchQuote.mockResolvedValue({ evidenceDirectory: evidence });
  return evidence;
}

function read() {
  return createExistingOwnerNativeQuoteReader({ owner, outputDir: join(root, 'out') });
}

describe('Cloud native quote reader', () => {
  it('dispatches the selected owner and reports the saved execution failure phase', async () => {
    const evidence = await savedCapture({ outcome: 'execution_failure', phase: 'hotel_availability' });
    const signal = new AbortController().signal;
    await expect(read()(request, signal)).rejects.toMatchObject({ code: 'EXECUTION_FAILURE', phase: 'hotel_availability' });
    expect(cloud.fetchQuote).toHaveBeenCalledWith(expect.objectContaining({
      propertyCode: 'HRCEN', transportId: 'transport-centurion', outputDir: join(root, 'out'), signal,
      request: expect.objectContaining({ schemaVersion: 2, propertyCode: 'HRCEN' }),
    }));
    expect(evidence.startsWith(join(root, 'out'))).toBe(true);
  });

  it('sanitizes an execution failure from Cloud evidence', async () => {
    await savedCapture({ outcome: 'execution_failure', phase: 'attach', error: {
      name: 'TimeoutError', message: 'browserType.connectOverCDP: Timeout 20000ms exceeded. http://127.0.0.1:19223',
    } });
    await expect(read()(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'EXECUTION_FAILURE', phase: 'attach', errorName: 'TimeoutError',
      errorMessage: expect.not.stringMatching(/http:|127\.0\.0\.1/),
    });
  });

  it('rejects output and owner outside the authenticated Cloud scope', () => {
    expect(() => createExistingOwnerNativeQuoteReader({ owner, outputDir: '/tmp/quote' }))
      .toThrow('native_cloud_quote_scope_or_private_output_invalid');
    expect(() => createExistingOwnerNativeQuoteReader({ owner, outputDir: join(privateRoot, '..', 'playwright-quote', 'out') }))
      .toThrow('native_cloud_quote_scope_or_private_output_invalid');
    expect(() => createExistingOwnerNativeQuoteReader({ owner: { propertyCode: 'HRDAVS', transportId: owner.transportId },
      outputDir: join(privateRoot, 'out') })).toThrow('hms_property_switch_unauthorized');
    expect(cloud.fetchQuote).not.toHaveBeenCalled();
  });

  it('refuses evidence outside the requested output and capability denial', async () => {
    await savedCapture({ outcome: 'execution_failure' });
    cloud.fetchQuote.mockResolvedValue({ evidenceDirectory: join(privateRoot, 'other', 'run') });
    await expect(read()(request, new AbortController().signal)).rejects.toThrow('native_quote_capture_unavailable');
    cloud.capability.mockResolvedValue(false);
    await expect(read()(request, new AbortController().signal)).rejects.toThrow('native_quote_capability_unavailable');
  });

  it('rejects a request for a different property before fetching', async () => {
    await savedCapture({ outcome: 'execution_failure' });
    await expect(read()({ ...request, propertyCode: 'HRDAVS' }, new AbortController().signal))
      .rejects.toThrow('native_quote_owner_scope_mismatch');
    expect(cloud.fetchQuote).not.toHaveBeenCalled();
  });
});

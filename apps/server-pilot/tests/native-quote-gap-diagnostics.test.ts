import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  createExistingOwnerNativeQuoteReader,
  nativeQuoteGapDetail,
} from '../src/ai/reservationist-evaluation-composition.js';
import { ReservationistTaskEvidenceUnavailable } from '../src/ai/reservationist-execution.js';
import {
  SHARED_INVENTORY_GAP_MESSAGE,
  staffQuoteFailureLog,
  staffQuoteFailureMessage,
} from '../src/trpc/routes/workstation.js';

/**
 * A staff quote with two room rows: HMS prices both, but every room option has buildingCode null, so composeAllocation
 * cannot build a shared pool id and the capture stays partial. The block is deliberate; these tests pin only what the
 * failure says about itself.
 */

const contractPath = fileURLToPath(new URL('../tooling/playwright-quote/quote-contract.mjs', import.meta.url));
const privateRoot = fileURLToPath(new URL('../../../.private/playwright-quote', import.meta.url));
const owner = {
  cdpUrl: 'http://127.0.0.1:9222',
  browserOwnership: 'borrowed' as const,
  propertyCode: 'HRCEN',
  secretPath: '/srv/owner/secret.json',
};
const request = {
  propertyCode: 'HRCEN',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  requestedCurrency: 'ZAR',
  details: 'full',
  rooms: [
    { id: 'room-1', quantity: 15, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BAR'] } },
    { id: 'room-2', quantity: 15, adults: 2, children: 0, childAges: [], required: { roomCodes: ['STWN'], rateCodes: ['BAR'] } },
  ],
};

type Contract = {
  normalizeQuoteRequest: (input: unknown) => { ok: boolean; request: { rooms: Array<{ id: string }> } };
  composeAllocation: (groups: unknown[], propertyCode: string) => { status: string; reason: string };
};

function option(room: string, building: string | null) {
  return {
    id: `HRCEN:${room}:BAR`,
    room: { code: room, label: `Standard ${room}`, buildingCode: building },
    rate: { code: 'BAR', label: 'Best Available' },
    board: 'Bed & Breakfast',
    held: false,
    eligibility: 'verified',
    availability: 'available',
    matchStatus: 'match',
    issues: [],
    details: { status: 'complete' },
    nightly: ['2026-11-12', '2026-11-13'].map((date) => ({ date, inventory: 40, price: { amount: '1543.21', currency: 'ZAR' } })),
  };
}

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

/** The capture fetch-quote leaves for this request: audited, complete, partial only because the allocation is unknown. */
async function jointInventoryCapture(building: string | null) {
  const contract = (await import(contractPath)) as Contract;
  const normalized = contract.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
  const groups = normalized.rooms.map((room, index) => ({
    id: room.id,
    request: room,
    outcome: 'quote',
    issues: [],
    completeness: { search: 'complete', requiredFacts: 'complete' },
    options: [option(index === 0 ? 'STQN' : 'STWN', building)],
  }));
  root = join(privateRoot, `test-${randomUUID()}`);
  const evidence = join(root, 'out', 'run-2026-11-12T08-00-00Z');
  await mkdir(evidence, { recursive: true });
  const capture = {
    schemaVersion: 2,
    outcome: 'partial',
    propertyCode: 'HRCEN',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    requested: normalized,
    groups,
    allocation: contract.composeAllocation(groups, 'HRCEN'),
    issues: [],
    searchCompleteness: { status: 'complete' },
    audit: { status: 'complete' },
    evidenceDirectory: evidence,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(capture));
  return { evidence, capture };
}

async function readerFailure(): Promise<unknown> {
  const { evidence } = await jointInventoryCapture(null);
  const read = createExistingOwnerNativeQuoteReader({
    owner,
    outputDir: join(root, 'out'),
    dispatch: async () => ({ stdout: `Evidence: ${evidence}\n` }),
  });
  return read(request as never, new AbortController().signal).then(
    () => null,
    (error: unknown) => error,
  );
}

describe('the joint-inventory block carries its diagnostics', () => {
  it('stays blocked, and says the allocation is unknown because HMS gave no building for each priced row', async () => {
    const error = await readerFailure();
    expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    const gap = error as ReservationistTaskEvidenceUnavailable;
    expect(gap.code).toBe('native_quote_business_evidence_unavailable');
    expect(gap.detail).toEqual({
      allocationStatus: 'unknown',
      allocationReason: 'Source did not prove a shared inventory-pool identity.',
      sharedInventoryPoolGap: true,
      rows: [
        { row: 1, outcome: 'quote', roomCode: 'STQN', rateCode: 'BAR', buildingCode: 'null' },
        { row: 2, outcome: 'quote', roomCode: 'STWN', rateCode: 'BAR', buildingCode: 'null' },
      ],
      evidenceRun: 'run-2026-11-12T08-00-00Z',
    });
    // No prices and no full paths in the detail.
    expect(JSON.stringify(gap.detail)).not.toMatch(/1543|\/srv|\.private/);
  });

  it('logs phase qualification with the detail, and tells staff to quote each room type separately', async () => {
    const error = await readerFailure();
    const log = staffQuoteFailureLog(error);
    expect(log).toMatchObject({
      code: 'native_quote_business_evidence_unavailable',
      phase: 'qualification',
      detail: { allocationStatus: 'unknown', sharedInventoryPoolGap: true, evidenceRun: 'run-2026-11-12T08-00-00Z' },
    });
    expect(log.detail?.rows.map((row) => row.buildingCode)).toEqual(['null', 'null']);
    expect(staffQuoteFailureMessage(error)).toBe(SHARED_INVENTORY_GAP_MESSAGE);
    expect(SHARED_INVENTORY_GAP_MESSAGE).toBe(
      "HMS priced each room, but Nava can't yet confirm the rooms are available together (HMS gives no building). Quote each room type separately for now.",
    );
  });
});

describe('nativeQuoteGapDetail', () => {
  it('reports a building HMS gave as present, and no pool gap for another unknown allocation', async () => {
    const { capture, evidence } = await jointInventoryCapture('B1');
    const detail = nativeQuoteGapDetail(
      { ...capture, allocation: { status: 'unknown', reason: 'Same-pool observations disagree; sequential searches are not an atomic inventory check.' } },
      evidence,
    );
    expect(detail.rows.map((row) => row.buildingCode)).toEqual(['present', 'present']);
    expect(detail.sharedInventoryPoolGap).toBe(false);
  });

  it('drops values that are not plain codes', () => {
    const detail = nativeQuoteGapDetail(
      {
        allocation: { status: 'unknown', reason: 'Guest <script>' },
        groups: [{ outcome: 'Jane Doe called', options: [{ room: { code: 'STQN; DROP', buildingCode: null }, rate: { code: 'BAR' } }] }],
      },
      '/tmp/odd dir/with spaces',
    );
    expect(detail).toEqual({
      allocationStatus: 'unknown',
      allocationReason: '',
      sharedInventoryPoolGap: false,
      rows: [{ row: 1, outcome: 'unknown', roomCode: null, rateCode: 'BAR', buildingCode: 'null' }],
      evidenceRun: null,
    });
  });
});

describe('other evidence gaps keep their messages', () => {
  it('keeps the generic copy without the pool gap, and qualification as the phase', () => {
    const plain = new ReservationistTaskEvidenceUnavailable('native_quote_business_evidence_unavailable', ['x']);
    expect(staffQuoteFailureMessage(plain)).toBe('Verify rate eligibility and combined availability for these rooms.');
    expect(staffQuoteFailureLog(plain)).toEqual({ code: 'native_quote_business_evidence_unavailable', phase: 'qualification' });
    const noGap = new ReservationistTaskEvidenceUnavailable('native_quote_business_evidence_unavailable', ['x'], undefined, {
      allocationStatus: 'unknown',
      allocationReason: 'Pool supply is not comparable across the requested nights.',
      sharedInventoryPoolGap: false,
      rows: [],
      evidenceRun: null,
    });
    expect(staffQuoteFailureMessage(noGap)).toBe('Verify rate eligibility and combined availability for these rooms.');
  });

  it('keeps an HMS execution phase and unknown for plain errors', () => {
    const execution = Object.assign(new Error('EXECUTION_FAILURE'), { code: 'EXECUTION_FAILURE', phase: 'hotel_availability' });
    expect(staffQuoteFailureLog(execution)).toEqual({ code: 'EXECUTION_FAILURE', phase: 'hotel_availability' });
    expect(staffQuoteFailureLog(new Error('native_quote_capture_scope_or_completeness_invalid')).phase).toBe('unknown');
  });
});

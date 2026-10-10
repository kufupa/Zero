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
 * A staff quote with two room rows (STQN and STWN). HMS prices both and, at this property, gives buildingCode null for
 * every room. composeAllocation then pools each room type property-wide and flags that joint availability across the
 * types is for staff to check in HMS. Only a malformed building still leaves no pool and blocks with its diagnostics.
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

function option(room: string, building: unknown) {
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

/** The capture fetch-quote leaves for this request: audited and complete; partial only while the allocation is unknown. */
async function jointInventoryCapture(building: unknown, tamper?: (allocation: Record<string, unknown>) => void) {
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
  const allocation = contract.composeAllocation(groups, 'HRCEN') as unknown as Record<string, unknown>;
  tamper?.(allocation);
  const capture = {
    schemaVersion: 2,
    outcome: allocation.status === 'verified_at_observation' ? 'quote' : 'partial',
    propertyCode: 'HRCEN',
    observedAt: new Date(Date.now() - 1000).toISOString(),
    requested: normalized,
    groups,
    allocation,
    issues: [],
    searchCompleteness: { status: 'complete' },
    audit: { status: 'complete' },
    evidenceDirectory: evidence,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(capture));
  return { evidence, capture };
}

async function readCapture(building: unknown, tamper?: (allocation: Record<string, unknown>) => void) {
  const { evidence } = await jointInventoryCapture(building, tamper);
  const read = createExistingOwnerNativeQuoteReader({
    owner,
    outputDir: join(root, 'out'),
    dispatch: async () => ({ stdout: `Evidence: ${evidence}\n` }),
  });
  return read(request as never, new AbortController().signal);
}

async function readerFailure(building: unknown = ''): Promise<unknown> {
  return readCapture(building).then(
    () => null,
    (error: unknown) => error,
  );
}

describe('no HMS building: property-wide room-type pools', () => {
  it('admits the two-room-type quote, with the allocation flagged for a staff check', async () => {
    const { capture } = await jointInventoryCapture(null);
    expect(capture.allocation).toMatchObject({ status: 'verified_at_observation', poolBasis: 'property_room_type' });
    expect((capture.allocation.pools as Array<{ id: string }>).map((pool) => pool.id)).toEqual([
      'HRCEN:property:STQN',
      'HRCEN:property:STWN',
    ]);
    const record = await readCapture(null);
    expect(record.result.outcome).toBe('quote');
    expect(record.result.groups.map((group) => group.options[0]!.room.buildingCode)).toEqual([null, null]);
  });

  it('refuses a quote whose allocation is not the one the contract recomputes', async () => {
    await expect(
      readCapture(null, (allocation) => {
        delete allocation.poolBasis;
      }),
    ).rejects.toThrow('native_quote_capture_scope_or_completeness_invalid');
  });
});

describe('the joint-inventory block carries its diagnostics', () => {
  it('stays blocked when the building is malformed, and says the allocation is unknown for that reason', async () => {
    const error = await readerFailure();
    expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    const gap = error as ReservationistTaskEvidenceUnavailable;
    expect(gap.code).toBe('native_quote_business_evidence_unavailable');
    expect(gap.detail).toEqual({
      allocationStatus: 'unknown',
      allocationReason: 'Source did not prove a shared inventory-pool identity.',
      sharedInventoryPoolGap: true,
      rows: [
        { row: 1, outcome: 'quote', roomCode: 'STQN', rateCode: 'BAR', buildingCode: 'malformed' },
        { row: 2, outcome: 'quote', roomCode: 'STWN', rateCode: 'BAR', buildingCode: 'malformed' },
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
    expect(log.detail?.rows.map((row) => row.buildingCode)).toEqual(['malformed', 'malformed']);
    expect(staffQuoteFailureMessage(error)).toBe(SHARED_INVENTORY_GAP_MESSAGE);
    expect(SHARED_INVENTORY_GAP_MESSAGE).toBe(
      "HMS priced each room, but Nava can't confirm the rooms are available together (HMS gave an unreadable building). Quote each room type separately for now.",
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

  it('does not call a null building a pool gap: null buildings pool by room type', async () => {
    const { capture, evidence } = await jointInventoryCapture(null);
    const detail = nativeQuoteGapDetail(
      { ...capture, allocation: { status: 'unknown', reason: 'Source did not prove a shared inventory-pool identity.' } },
      evidence,
    );
    expect(detail.rows.map((row) => row.buildingCode)).toEqual(['null', 'null']);
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

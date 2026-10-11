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
 * A staff quote with two room rows: HMS prices both with buildingCode null. At inventory 40 the STQN row is above that
 * type's profile capacity (34), so the room profile does not hold, composeAllocation reports it out of date, and the
 * capture stays partial. The block is deliberate; these tests pin only what the failure says about itself.
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
  composeAllocation: (groups: unknown[], propertyCode: string) => { status: string; reason: string; pools: { id: string }[] };
  aggregateOutcome: (input: { groups: unknown[]; allocation: unknown }) => { outcome: string };
};

function option(room: string, building: string | null, inventory = 40) {
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
    nightly: ['2026-11-12', '2026-11-13'].map((date) => ({ date, inventory, price: { amount: '1543.21', currency: 'ZAR' } })),
  };
}

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

/** The capture fetch-quote leaves for this request: audited, complete, partial only because the allocation is unknown. */
async function jointInventoryCapture(building: string | null, inventory = 40) {
  const contract = (await import(contractPath)) as Contract;
  const normalized = contract.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
  const groups = normalized.rooms.map((room, index) => ({
    id: room.id,
    request: room,
    outcome: 'quote',
    issues: [],
    completeness: { search: 'complete', requiredFacts: 'complete' },
    options: [option(index === 0 ? 'STQN' : 'STWN', building, inventory)],
  }));
  root = join(privateRoot, `test-${randomUUID()}`);
  const evidence = join(root, 'out', 'run-2026-11-12T08-00-00Z');
  await mkdir(evidence, { recursive: true });
  const allocation = contract.composeAllocation(groups, 'HRCEN');
  const capture = {
    schemaVersion: 2,
    outcome: contract.aggregateOutcome({ groups, allocation }).outcome,
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

function readFrom(evidence: string) {
  const read = createExistingOwnerNativeQuoteReader({
    owner,
    outputDir: join(root, 'out'),
    dispatch: async () => ({ stdout: `Evidence: ${evidence}\n` }),
  });
  return read(request as never, new AbortController().signal);
}

async function readerFailure(): Promise<unknown> {
  const { evidence } = await jointInventoryCapture(null);
  return readFrom(evidence).then(
    () => null,
    (error: unknown) => error,
  );
}

describe('a capture inside the verified room profile', () => {
  it('reads through as a quote', async () => {
    const { evidence } = await jointInventoryCapture(null, 30);
    const source = await readFrom(evidence);
    expect(source.ref).toMatch(/^native-quote:[0-9a-f]{64}$/);
    expect(source.result.outcome).toBe('quote');
    expect(source.result.groups).toHaveLength(2);
  });

  it('is rejected when its allocation pool id is not what the contract recomputes from the rows', async () => {
    const { evidence, capture } = await jointInventoryCapture(null, 30);
    const tampered = structuredClone(capture);
    tampered.allocation.pools[0].id = 'HRCEN:B9:STQN';
    await writeFile(join(evidence, 'result.json'), JSON.stringify(tampered));
    await expect(readFrom(evidence)).rejects.toThrow('native_quote_capture_scope_or_completeness_invalid');
  });
});

describe('the joint-inventory block carries its diagnostics', () => {
  it('stays blocked, and says the room profile is out of date because STQN is above its capacity and HMS gave no building', async () => {
    const error = await readerFailure();
    expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    const gap = error as ReservationistTaskEvidenceUnavailable;
    expect(gap.code).toBe('native_quote_business_evidence_unavailable');
    expect(gap.detail).toEqual({
      allocationStatus: 'unknown',
      allocationReason: 'Room profile out of date: observed HMS room types, inventory or building codes no longer match the verified property profile.',
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
      'Room profile out of date or missing — check HMS room types. Quote each room type separately for now.',
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

/** A one-type request for 40 rooms, and a two-row request that needs 20 + 20 of the same type. */
const shortRequest = {
  propertyCode: 'HRCEN',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  requestedCurrency: 'ZAR',
  details: 'full',
  rooms: [{ id: 'room-1', quantity: 40, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BAR'] } }],
};
const sharedTypeRequest = {
  ...shortRequest,
  rooms: [
    { id: 'room-1', quantity: 20, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BAR'] } },
    { id: 'room-2', quantity: 20, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BARRO'] } },
  ],
};
const standardQueen = { code: 'STQN', label: 'Standard Queen', buildingCode: null };

function rowFor(room: { code: string; label?: string; buildingCode: string | null }, inventory: number, availability: string, rate = 'BAR') {
  return {
    id: `HRCEN:${room.code}:${rate}`,
    room,
    rate: { code: rate, label: 'Best Available' },
    board: 'Bed & Breakfast',
    held: false,
    eligibility: 'verified',
    availability,
    matchStatus: 'match',
    issues: [],
    details: { status: 'complete' },
    nightly: ['2026-11-12', '2026-11-13'].map((date) => ({ date, inventory, price: { amount: '1543.21', currency: 'ZAR' } })),
  };
}

/** Writes the capture fetch-quote leaves for `req`: groups built from the normalized rooms, outcome and allocation recomputed. */
async function captureFor(
  req: { propertyCode: string } & Record<string, unknown>,
  makeGroups: (rooms: unknown[]) => unknown[],
  patch: Record<string, unknown> = {},
) {
  const contract = (await import(contractPath)) as Contract;
  const normalized = contract.normalizeQuoteRequest({ schemaVersion: 2, ...req }).request;
  const groups = makeGroups(normalized.rooms);
  root = join(privateRoot, `test-${randomUUID()}`);
  const evidence = join(root, 'out', 'run-2026-11-12T08-00-00Z');
  await mkdir(evidence, { recursive: true });
  const allocation = contract.composeAllocation(groups, req.propertyCode);
  const capture = {
    schemaVersion: 2,
    outcome: contract.aggregateOutcome({ groups, allocation }).outcome,
    propertyCode: req.propertyCode,
    observedAt: new Date(Date.now() - 1000).toISOString(),
    requested: normalized,
    groups,
    allocation,
    issues: [],
    searchCompleteness: { status: 'complete' },
    audit: { status: 'complete' },
    evidenceDirectory: evidence,
    ...patch,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(capture));
  return evidence;
}

function readerFor(evidence: string, req: { propertyCode: string }) {
  const read = createExistingOwnerNativeQuoteReader({
    owner: { ...owner, propertyCode: req.propertyCode },
    outputDir: join(root, 'out'),
    dispatch: async () => ({ stdout: `Evidence: ${evidence}\n` }),
  });
  return read(req as never, new AbortController().signal);
}

async function failureOf(evidence: string, req: { propertyCode: string }): Promise<unknown> {
  return readerFor(evidence, req).then(
    () => null,
    (error: unknown) => error,
  );
}

const oneRow = (rooms: unknown[]) => [
  { id: 'room-1', request: rooms[0], outcome: 'unavailable', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 34, 'unavailable')] },
];

describe('a short-supply capture is insufficient, and says which room type and night is short', () => {
  it('names the room type, the first short night and the supply for one row asking for more rooms than HMS holds', async () => {
    const evidence = await captureFor(shortRequest, oneRow, { outcome: 'unavailable' });
    const error = await failureOf(evidence, shortRequest);
    expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    expect((error as ReservationistTaskEvidenceUnavailable).code).toBe('native_quote_insufficient_inventory');
    expect((error as ReservationistTaskEvidenceUnavailable).detail).toEqual({
      shortfall: { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2026-11-12', demand: 40, supply: 34 },
    });
    expect(staffQuoteFailureMessage(error)).toBe('Only 34 Standard Queen free on 12 Nov — quote fewer or split');
    expect(staffQuoteFailureLog(error)).toEqual({ code: 'native_quote_insufficient_inventory', phase: 'qualification' });
  });

  it('names the shared type when two rows of it add up to more than the profile holds, not a scope error', async () => {
    const evidence = await captureFor(sharedTypeRequest, (rooms) => [
      { id: 'room-1', request: rooms[0], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 34, 'available')] },
      { id: 'room-2', request: rooms[1], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 34, 'available', 'BARRO')] },
    ]);
    const error = await failureOf(evidence, sharedTypeRequest);
    expect((error as ReservationistTaskEvidenceUnavailable).code).toBe('native_quote_insufficient_inventory');
    expect((error as ReservationistTaskEvidenceUnavailable).detail).toEqual({
      shortfall: { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2026-11-12', demand: 40, supply: 34 },
    });
  });

  it('names the short group, not the room type of a group that another option satisfies', async () => {
    const acceptsEither = {
      ...shortRequest,
      rooms: [
        { id: 'room-1', quantity: 2, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN', 'SKNG'], rateCodes: ['BAR'] } },
        { id: 'room-2', quantity: 2, adults: 1, children: 0, childAges: [], required: { roomCodes: ['SUITE'], rateCodes: ['BAR'] } },
      ],
    };
    const evidence = await captureFor(acceptsEither, (rooms) => [
      { id: 'room-1', request: rooms[0], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 1, 'unavailable'), rowFor({ code: 'SKNG', label: 'Standard King', buildingCode: null }, 5, 'available')] },
      { id: 'room-2', request: rooms[1], outcome: 'unavailable', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor({ code: 'SUITE', label: 'Suite', buildingCode: null }, 1, 'unavailable')] },
    ]);
    const error = await failureOf(evidence, acceptsEither);
    expect((error as ReservationistTaskEvidenceUnavailable).code).toBe('native_quote_insufficient_inventory');
    expect((error as ReservationistTaskEvidenceUnavailable).detail).toEqual({
      shortfall: { roomCode: 'SUITE', roomLabel: 'Suite', date: '2026-11-12', demand: 2, supply: 1 },
    });
    expect(staffQuoteFailureMessage(error)).toBe('Only 1 Suite free on 12 Nov — quote fewer or split');
  });

  it('stays fail closed when the capture is not complete, even though HMS said unavailable', async () => {
    const withIssue = await captureFor(shortRequest, oneRow, { outcome: 'unavailable', issues: [{ code: 'OPTION_LIMIT' }] });
    expect((await failureOf(withIssue, shortRequest)) as Error).toHaveProperty('message', 'native_quote_capture_scope_or_completeness_invalid');
    const partialSearch = await captureFor(shortRequest, (rooms) => [
      { ...oneRow(rooms)[0] as object, completeness: { search: 'partial', requiredFacts: 'complete' } },
    ], { outcome: 'unavailable' });
    expect((await failureOf(partialSearch, shortRequest)) as Error).toHaveProperty('message', 'native_quote_capture_scope_or_completeness_invalid');
  });

  it('keeps an incomplete capture with a short allocation on the business-evidence gap, with the availability copy', async () => {
    const evidence = await captureFor(sharedTypeRequest, (rooms) => [
      { id: 'room-1', request: rooms[0], outcome: 'partial', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 34, 'available')] },
      { id: 'room-2', request: rooms[1], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 34, 'available', 'BARRO')] },
    ], { outcome: 'partial' });
    const error = await failureOf(evidence, sharedTypeRequest);
    expect((error as ReservationistTaskEvidenceUnavailable).code).toBe('native_quote_business_evidence_unavailable');
    expect(staffQuoteFailureMessage(error)).toBe('Verify rate eligibility and combined availability for these rooms.');
  });

  it('gives the room-profile copy when the property has no profile and HMS gave no building', async () => {
    const otherRequest = {
      ...shortRequest,
      propertyCode: 'OTHER',
      rooms: [
        { id: 'room-1', quantity: 15, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BAR'] } },
        { id: 'room-2', quantity: 15, adults: 2, children: 0, childAges: [], required: { roomCodes: ['STWN'], rateCodes: ['BAR'] } },
      ],
    };
    const evidence = await captureFor(otherRequest, (rooms) => [
      { id: 'room-1', request: rooms[0], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor(standardQueen, 40, 'available')] },
      { id: 'room-2', request: rooms[1], outcome: 'quote', issues: [], completeness: { search: 'complete', requiredFacts: 'complete' }, options: [rowFor({ code: 'STWN', label: 'Standard Twin', buildingCode: null }, 40, 'available')] },
    ]);
    const error = await failureOf(evidence, otherRequest);
    expect(staffQuoteFailureMessage(error)).toBe(SHARED_INVENTORY_GAP_MESSAGE);
  });
});

describe('a sell restriction on a night names the room type and the night, not the generic combination copy', () => {
  // The AE1 shape: HMS answered both room types, but every matching row of each group is closed to sale on 18 Nov, so no row is offered.
  const restrictedRequest = {
    propertyCode: 'HRCEN',
    arrivalDate: '2027-11-17',
    departureDate: '2027-11-19',
    requestedCurrency: 'ZAR',
    details: 'summary',
    rooms: [
      { id: 'room-1', quantity: 1, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STQN'], rateCodes: ['BAR'] } },
      { id: 'room-2', quantity: 1, adults: 1, children: 0, childAges: [], required: { roomCodes: ['STWN'], rateCodes: ['BAR'] } },
    ],
  };
  const closedOn18 = (roomCode: string, roomLabel: string) => ({ roomCode, roomLabel, date: '2027-11-18' });
  const group = (id: string, request: unknown, nights: unknown[] | undefined, outcome = 'partial') => ({
    id,
    request,
    outcome,
    issues: [],
    completeness: { search: 'complete', requiredFacts: 'complete' },
    options: [],
    ...(nights ? { restrictedNights: nights } : {}),
  });

  it('names each restricted room type and its night, and quotes nothing', async () => {
    const evidence = await captureFor(restrictedRequest, (rooms) => [
      group('room-1', rooms[0], [closedOn18('STQN', 'Standard Queen')]),
      group('room-2', rooms[1], [closedOn18('STWN', 'Standard Twin')]),
    ]);
    const error = await failureOf(evidence, restrictedRequest);
    expect(error).toBeInstanceOf(ReservationistTaskEvidenceUnavailable);
    expect((error as ReservationistTaskEvidenceUnavailable).code).toBe('native_quote_restricted_nights');
    expect((error as ReservationistTaskEvidenceUnavailable).detail).toEqual({
      restrictedNights: [closedOn18('STQN', 'Standard Queen'), closedOn18('STWN', 'Standard Twin')],
    });
    expect(staffQuoteFailureMessage(error)).toBe(
      'HMS restricts sale on 18 Nov 2027 for Standard Queen and Standard Twin. Choose other dates or quote this in HMS.',
    );
    expect(staffQuoteFailureLog(error)).toEqual({ code: 'native_quote_restricted_nights', phase: 'qualification' });
  });

  it('stays on the generic capture error when a group is neither a quote nor restricted, or the capture has an issue', async () => {
    const plainPartial = await captureFor(restrictedRequest, (rooms) => [
      group('room-1', rooms[0], [closedOn18('STQN', 'Standard Queen')]),
      group('room-2', rooms[1], undefined),
    ]);
    expect((await failureOf(plainPartial, restrictedRequest)) as Error).toHaveProperty(
      'message',
      'native_quote_capture_scope_or_completeness_invalid',
    );
    const withIssue = await captureFor(
      restrictedRequest,
      (rooms) => [
        group('room-1', rooms[0], [closedOn18('STQN', 'Standard Queen')]),
        group('room-2', rooms[1], [closedOn18('STWN', 'Standard Twin')]),
      ],
      { issues: [{ code: 'OPTION_LIMIT' }] },
    );
    expect((await failureOf(withIssue, restrictedRequest)) as Error).toHaveProperty(
      'message',
      'native_quote_capture_scope_or_completeness_invalid',
    );
  });
});

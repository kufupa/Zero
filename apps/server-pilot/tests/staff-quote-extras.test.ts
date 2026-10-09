import { describe, expect, it } from 'vitest';
import {
  buildStaffProposalFacts,
  prepareStaffQuote,
  staffQuoteInput,
  type StaffQuoteInput,
} from '../src/ai/staff-quote-workflow.js';
import { deriveAuthorizedExtraLines } from '../src/quote-proposal/quote-lines.js';
import { renderRevisionProposalHtml } from '../src/quote-proposal/proposal-pdf.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const scope = { messageId: 'message-1', sourceHash: 'a'.repeat(64) };

function baseInput(overrides: Partial<StaffQuoteInput> = {}): StaffQuoteInput {
  return staffQuoteInput.parse({
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [
      {
        id: 'stay',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 1,
        adults: 2,
        childrenAges: [],
        board: 'bb',
      },
    ],
    ...overrides,
  });
}

describe('buildStaffProposalFacts', () => {
  it('charges dinner allowance across 2 adults and 3 nights as 6 person-service units', async () => {
    const revision = await syntheticRevision();
    const input = baseInput({ dinnerAllowanceMinor: 12_500 });
    const built = buildStaffProposalFacts(input, scope, { authorizationId: revision.authorizationId }, revision);
    expect(built.factRefs).toEqual(['extras']);
    expect(built.facts?.extras).toHaveLength(1);
    expect(built.facts?.extras[0]).toMatchObject({
      label: 'Dinner allowance',
      unitKind: 'person_service',
      quantity: 1,
      units: 6,
      unitMinor: 12_500,
    });
    const lines = deriveAuthorizedExtraLines(revision, built.facts!);
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toContain('Dinner allowance');
    expect(lines[0].totalMinor).toBe(12_500 * 6);
  });

  it('charges the dinner allowance only to the groups that took the B&B fallback, never to the other guests', async () => {
    const revision = await syntheticRevision();
    const groups = [
      { id: 'dinner', arrivalDate: '2026-10-12', departureDate: '2026-10-15', quantity: 1, adults: 2, childrenAges: [], board: 'bb' as const },
      { id: 'room', arrivalDate: '2026-10-12', departureDate: '2026-10-15', quantity: 1, adults: 1, childrenAges: [], board: 'room_only' as const },
    ];
    const onDinner = buildStaffProposalFacts(
      baseInput({ groups, dinnerAllowanceMinor: 12_500, dinnerAllowanceGroupIds: ['dinner'] }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(onDinner.facts?.extras[0]).toMatchObject({ units: 6 });
    const onOtherDates = buildStaffProposalFacts(
      baseInput({ groups, dinnerAllowanceMinor: 12_500, dinnerAllowanceGroupIds: ['elsewhere'] }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(onOtherDates.factRefs).toEqual([]);
  });

  it('adds a shuttle review item without an extras line when shuttle has no amount', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ shuttleRequested: true }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts).toBeNull();
    expect(built.factRefs).toEqual([]);
    expect(built.extrasReviewItems).toEqual([
      'Shuttle requested — add a price or answer in the reply',
    ]);
  });

  it('adds a shuttle trip line when staff typed an amount', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ shuttleRequested: true, shuttleMinor: 45_000 }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.factRefs).toEqual(['extras']);
    expect(built.facts?.extras[0]).toMatchObject({
      unitKind: 'trip',
      quantity: 1,
      units: 1,
      unitMinor: 45_000,
      persons: [],
      dates: ['2026-10-12'],
    });
    expect(built.extrasReviewItems).toEqual([]);
  });

  it('returns no proposal facts when no extras were confirmed', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput(),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts).toBeNull();
    expect(built.factRefs).toEqual([]);
    expect(built.extrasReviewItems).toEqual([]);
  });

  it('puts dinner and shuttle labels on the staff proposal HTML', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ dinnerAllowanceMinor: 12_500, shuttleRequested: true, shuttleMinor: 45_000 }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts?.extras).toHaveLength(2);
    const html = renderRevisionProposalHtml(
      revision,
      {
        attention: 'Staff',
        company: 'Test',
        clientEmail: 'test@example.invalid',
        clientTelephone: '',
        agency: 'Test',
        signerName: 'Test',
        signerEmail: 'test@example.invalid',
      },
      built.facts!,
    );
    expect(html).toContain('Dinner allowance');
    expect(html).toContain('Shuttle');
  });

  it('keeps staffQuoteInput strict and rejects model-priced fields', () => {
    expect(() => baseInput({ rate: 1700 } as StaffQuoteInput)).toThrow();
    expect(() =>
      staffQuoteInput.parse({ ...baseInput(), dinnerAllowanceMinor: 100, modelTotal: 99 }),
    ).toThrow();
  });
});

const pdfHeader = {
  attention: 'Staff',
  company: 'Test',
  clientEmail: 'test@example.invalid',
  clientTelephone: '',
  agency: 'Test',
  signerName: 'Test',
  signerEmail: 'test@example.invalid',
};
/** The PDF groups thousands with a space; compare without whitespace. */
const compact = (html: string) => html.replace(/\s/g, '');

async function staffExtras(overrides: Partial<StaffQuoteInput> = {}) {
  const revision = await syntheticRevision();
  const built = buildStaffProposalFacts(
    baseInput(overrides),
    scope,
    { authorizationId: revision.authorizationId },
    revision,
  );
  const lines = built.facts ? deriveAuthorizedExtraLines(revision, built.facts) : [];
  return { revision, built, lines };
}

describe('staff extras: separate dinner, lunch, office transfer, shuttle, other and notes', () => {
  it('prices 2 guests x 3 nights x R450 dinner as one R2,700 line with QTY 2 and NIGHTS 3', async () => {
    const { revision, built, lines } = await staffExtras({ dinnerAllowanceMinor: 45_000 });
    expect(lines).toEqual([
      expect.objectContaining({
        description: 'Dinner allowance',
        quantity: 2,
        nights: 3,
        rateMinor: 45_000,
        totalMinor: 270_000,
      }),
    ]);
    const html = compact(renderRevisionProposalHtml(revision, pdfHeader, built.facts!));
    expect(html).toContain(compact('<td>2</td><td>Dinner allowance</td><td>3</td><td>R450.00</td><td>R2 700.00</td>'));
  });

  it('prints lunch and dinner as two separate lines', async () => {
    const { lines } = await staffExtras({ dinnerAllowanceMinor: 45_000, lunchAllowanceMinor: 20_000 });
    expect(lines.map((line) => [line.description, line.quantity, line.nights, line.totalMinor])).toEqual([
      ['Dinner allowance', 2, 3, 270_000],
      ['Lunch allowance', 2, 3, 120_000],
    ]);
  });

  it('prices the shuttle as trips x R per trip: 2 x R600 = R1,200', async () => {
    const { lines } = await staffExtras({ shuttleRequested: true, shuttleMinor: 60_000, shuttleTrips: 2 });
    expect(lines).toEqual([
      expect.objectContaining({ description: 'Shuttle', quantity: 1, nights: 2, rateMinor: 60_000, totalMinor: 120_000 }),
    ]);
  });

  it('keeps a requested shuttle with no price as a review item, never an R0 line', async () => {
    const { built, lines } = await staffExtras({ shuttleRequested: true, shuttleTrips: 2 });
    expect(lines).toEqual([]);
    expect(built.facts).toBeNull();
    expect(built.extrasReviewItems).toEqual(['Shuttle requested — add a price or answer in the reply']);
  });

  it('prices an other item with unit item as one line', async () => {
    const { lines } = await staffExtras({ other: { label: 'Parking', amountMinor: 30_000, unit: 'item' } });
    expect(lines).toEqual([
      expect.objectContaining({ description: 'Parking', quantity: 1, nights: 1, totalMinor: 30_000 }),
    ]);
  });

  it('multiplies other charges by guests and nights, or by trips, as the unit says', async () => {
    const perNight = await staffExtras({ other: { label: 'Laundry', amountMinor: 10_000, unit: 'per_person_night' } });
    expect(perNight.lines[0]).toMatchObject({ quantity: 2, nights: 3, totalMinor: 60_000 });
    const perPerson = await staffExtras({ other: { label: 'Welcome', amountMinor: 10_000, unit: 'per_person' } });
    expect(perPerson.lines[0]).toMatchObject({ quantity: 2, nights: 1, totalMinor: 20_000 });
    const perTrip = await staffExtras({ other: { label: 'Airport run', amountMinor: 10_000, unit: 'per_trip' } });
    expect(perTrip.lines[0]).toMatchObject({ quantity: 1, nights: 1, totalMinor: 10_000, unitKind: 'trip' });
  });

  it('prices office transfer per guest per day, with days defaulting to the nights of the stay', async () => {
    const byNights = await staffExtras({ officeTransferMinor: 20_000 });
    expect(byNights.lines[0]).toMatchObject({ description: 'Office transfer', quantity: 2, nights: 3, totalMinor: 120_000 });
    const byDays = await staffExtras({ officeTransferMinor: 20_000, officeTransferDays: 4 });
    expect(byDays.lines[0]).toMatchObject({ quantity: 2, nights: 4, totalMinor: 160_000 });
    expect(byDays.built.facts?.extras[0]?.dates).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
  });

  it('adds the staff qualifier to the dinner and lunch labels', async () => {
    const { lines } = await staffExtras({
      dinnerAllowanceMinor: 45_000,
      dinnerAllowanceLabel: 'food only',
      lunchAllowanceMinor: 20_000,
      lunchAllowanceLabel: 'incl. R40 gratuity',
    });
    expect(lines.map((line) => line.description)).toEqual([
      'Dinner allowance (food only)',
      'Lunch allowance (incl. R40 gratuity)',
    ]);
  });

  it('totals the PDF as room plus every extra, prints the note once, and never prints person_service', async () => {
    const { revision, built, lines } = await staffExtras({
      dinnerAllowanceMinor: 45_000,
      lunchAllowanceMinor: 20_000,
      officeTransferMinor: 20_000,
      shuttleRequested: true,
      shuttleMinor: 60_000,
      shuttleTrips: 2,
      other: { label: 'Parking', amountMinor: 30_000, unit: 'item' },
      notes: 'Dinner is served at 19:00.',
    });
    const extraTotal = lines.reduce((sum, line) => sum + line.totalMinor, 0);
    expect(extraTotal).toBe(270_000 + 120_000 + 120_000 + 120_000 + 30_000);
    const html = renderRevisionProposalHtml(revision, { ...pdfHeader, notes: 'Dinner is served at 19:00.' }, built.facts!);
    expect(html).toContain(`data-proposal-total="${revision.totalMinor + extraTotal}"`);
    expect(html).not.toContain('person_service');
    expect(html.split('<strong>Note:</strong>').length - 1).toBe(1);
    expect(html).toContain('Dinner is served at 19:00.');
  });

  it('rejects zero, negative and unknown extras in the schema', () => {
    const base = baseInput();
    for (const bad of [
      { dinnerAllowanceMinor: -45_000 },
      { dinnerAllowanceMinor: 0 },
      { lunchAllowanceMinor: -1 },
      { officeTransferMinor: 0 },
      { officeTransferDays: 0 },
      { shuttleMinor: -1 },
      { shuttleTrips: 0 },
      { shuttleTrips: 21 },
      { other: { label: 'Parking', amountMinor: -100, unit: 'item' } },
      { other: { label: 'Parking', amountMinor: 100, unit: 'per_night' } },
    ]) {
      expect(() => staffQuoteInput.parse({ ...base, ...bad })).toThrow();
    }
  });

  it('raises a review item, never a line, for an other amount with no label', async () => {
    for (const label of ['', '   ']) {
      const { built, lines } = await staffExtras({ other: { label, amountMinor: 30_000, unit: 'item' } });
      expect(lines).toEqual([]);
      expect(built.facts).toBeNull();
      expect(built.extrasReviewItems).toEqual([
        'Other charge R300.00 has no label — add a label or answer in the reply',
      ]);
    }
    const { built, lines } = await staffExtras({
      dinnerAllowanceMinor: 45_000,
      other: { label: '', amountMinor: 30_000, unit: 'per_person_night' },
    });
    expect(lines.map((line) => line.description)).toEqual(['Dinner allowance']);
    expect(built.extrasReviewItems).toHaveLength(1);
  });

  it('caps the staff note at 1000 characters', () => {
    expect(() => staffQuoteInput.parse({ ...baseInput(), notes: 'x'.repeat(1001) })).toThrow();
    expect(staffQuoteInput.parse({ ...baseInput(), notes: 'x'.repeat(1000) }).notes).toHaveLength(1000);
  });

  it('reads a legacy shuttle price as one trip and keeps the legacy dinner amount', async () => {
    const legacy = staffQuoteInput.parse({
      ...baseInput(),
      dinnerAllowanceMinor: 12_500,
      shuttleRequested: true,
      shuttleMinor: 45_000,
    });
    expect(legacy.shuttleTrips).toBeUndefined();
    const { lines } = await staffExtras({ dinnerAllowanceMinor: 12_500, shuttleRequested: true, shuttleMinor: 45_000 });
    expect(lines.map((line) => [line.description, line.totalMinor])).toEqual([
      ['Dinner allowance', 75_000],
      ['Shuttle', 45_000],
    ]);
  });

  it('renders a stored legacy dinner row as guests x nights, not as one unit', async () => {
    const revision = await syntheticRevision();
    const stored = {
      revisionId: revision.id,
      authorizationId: revision.authorizationId,
      sourceRef: 'message:message-1',
      sourceHash: scope.sourceHash,
      extras: [
        {
          id: 'dinner-allowance',
          label: 'Dinner allowance',
          quantity: 1,
          units: 6,
          unitKind: 'person_service' as const,
          unitMinor: 12_500,
          service: 'dinner_allowance',
          persons: [
            { id: 'stay-r0-a0', age: 18 },
            { id: 'stay-r0-a1', age: 18 },
          ],
          dates: ['2026-10-12', '2026-10-13', '2026-10-14'],
        },
      ],
      includedEntitlements: [],
    };
    const html = compact(renderRevisionProposalHtml(revision, pdfHeader, stored));
    expect(html).toContain(compact('<td>2</td><td>Dinner allowance</td><td>3</td><td>R125.00</td><td>R750.00</td>'));
  });

  it('covers the new extras and the note in the input digest', async () => {
    const revision = await syntheticRevision();
    const digestOf = (overrides: Partial<StaffQuoteInput>) =>
      prepareStaffQuote(
        baseInput(overrides),
        {
          transportId: 'transport-1',
          userId: 'user-1',
          threadId: 'thread-1',
          messageId: scope.messageId,
          sourceHash: scope.sourceHash,
          messageAt: '2026-10-09T08:00:00Z',
          messageText: 'Please quote',
          propertyCode: 'HRCEN',
        },
        { signerName: 'Signer', signerEmail: 'signer@example.invalid' },
        new AbortController().signal,
      ).inputDigest;
    const base = digestOf({});
    expect(digestOf({ lunchAllowanceMinor: 20_000 })).not.toBe(base);
    expect(digestOf({ notes: 'Late check-in' })).not.toBe(base);
    expect(digestOf({ other: { label: 'Parking', amountMinor: 30_000, unit: 'item' } })).not.toBe(base);
    expect(revision.id).toBeTruthy();
  });
});

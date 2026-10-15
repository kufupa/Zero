import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHmsTodoCard } from '../src/ai/hms-todo-card.js';
import {
  analyseCachePath,
  analyseSyncedSelection,
  hashSyncedQuoteSelection,
} from '../src/ai/quote-workflow-analyse-selection.js';
import type { ModelAdapter } from '../src/ai/bedrock/adapter.js';
import type { SyncedQuoteSelection } from '../src/ai/quote-workflow-synced-selection.js';

vi.mock('../src/ai/bedrock/luna.js', () => ({
  createAzureLunaModel: () => {
    throw new Error('tests inject the model adapter');
  },
  LunaModelAdapter: class LunaModelAdapter {},
}));

function labelsOf(card: NonNullable<ReturnType<typeof buildHmsTodoCard>>): string[] {
  return card.steps.map((step) => step.label);
}

function stepValue(
  card: NonNullable<ReturnType<typeof buildHmsTodoCard>>,
  label: string,
): string | null | undefined {
  return card.steps.find((step) => step.label === label)?.value;
}

const emptyGroup = {
  dateEvidence: null as string | null,
  childAges: [] as number[],
  board: 'bb' as const,
  roomPreference: null,
  guestNames: [] as string[],
};

function lunaBooking(overrides: Record<string, unknown> = {}) {
  return {
    workflow: 'create_booking',
    flags: [] as string[],
    groups: [
      {
        ...emptyGroup,
        arrival: '2026-11-12',
        departure: '2026-11-14',
        rooms: 1,
        adultsPerRoom: 2,
        guestNames: ['Ann Example'],
      },
    ],
    party: { kind: null, name: null, reference: null },
    rateClaims: [] as unknown[],
    missing: [] as unknown[],
    evidence: [] as unknown[],
    tasks: [{ kind: 'create_booking' as const, groupIndexes: [0], note: 'book stay' }],
    ...overrides,
  };
}

function adapterReturning(output: Record<string, unknown>): ModelAdapter & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => ({
    modelId: 'gpt-6-luna',
    output,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      latencyMs: 1,
      estimatedCostUsd: 0,
      rateTableVersion: 't',
    },
  }));
  return { invoke };
}

function todoCardOf(payload: Record<string, unknown>) {
  return payload.hmsTodoCard as ReturnType<typeof buildHmsTodoCard>;
}

describe('buildHmsTodoCard', () => {
  it('builds a new_booking card from a full stay ask', () => {
    const card = buildHmsTodoCard({
      workflow: 'create_booking',
      stayAsk: {
        arrivalDate: '2026-11-12',
        departureDate: '2026-11-14',
        adults: 2,
        children: 0,
        rooms: 1,
      },
      guestLastName: 'Example',
    });

    expect(card).toEqual({
      kind: 'new_booking',
      title: 'Key into HMS',
      writesEnabled: false,
      missing: [],
      steps: [
        { label: 'Arrival', value: '2026-11-12', source: 'mail' },
        { label: 'Departure', value: '2026-11-14', source: 'mail' },
        { label: 'Rooms', value: '1', source: 'mail' },
        { label: 'Adults', value: '2', source: 'mail' },
        { label: 'Guest last name', value: 'Example', source: 'mail' },
      ],
    });
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  it('builds an amend card with confirmation number and requested change', () => {
    const card = buildHmsTodoCard({
      workflow: 'amend',
      confirmationNumber: '57291630-1',
      guestLastName: 'Example',
      requestedChange: 'Change departure from 15 Nov to 17 Nov',
    });

    expect(card).toMatchObject({
      kind: 'amend',
      title: 'Key into HMS',
      writesEnabled: false,
      missing: [],
    });
    expect(card!.steps).toEqual([
      { label: 'Confirmation number', value: '57291630-1', source: 'mail' },
      { label: 'Guest last name', value: 'Example', source: 'mail' },
      { label: 'Requested change', value: 'Change departure from 15 Nov to 17 Nov', source: 'mail' },
    ]);
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  it('lists a missing confirmation number on cancel', () => {
    const card = buildHmsTodoCard({ workflow: 'cancel' });

    expect(card).toMatchObject({
      kind: 'cancel',
      title: 'Key into HMS',
      writesEnabled: false,
    });
    expect(card!.missing).toEqual(['Confirmation number']);
    expect(card!.steps).toEqual([
      { label: 'Confirmation number', value: null, source: 'missing' },
    ]);
  });

  it('returns null for payment_proof workflows until classification exists', () => {
    expect(
      buildHmsTodoCard({
        workflow: 'voucher_pop',
        confirmationNumber: '57291630-1',
        attachmentFilenames: ['receipt.pdf'],
      }),
    ).toBeNull();
  });

  it('returns null for quote', () => {
    expect(
      buildHmsTodoCard({
        workflow: 'quote',
        stayAsk: {
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          adults: 2,
          rooms: 1,
        },
      }),
    ).toBeNull();
  });

  it('emits one labelled block per booking group and marks adults as per room', () => {
    const card = buildHmsTodoCard({
      workflow: 'create_booking',
      groups: [
        {
          arrival: '2026-11-12',
          departure: '2026-11-14',
          rooms: 2,
          adultsPerRoom: 2,
          guestNames: ['Ann Example', 'Bob Example'],
        },
        {
          arrival: '2026-12-01',
          departure: '2026-12-03',
          rooms: 1,
          adultsPerRoom: 1,
          guestNames: ['Cara Example'],
        },
      ],
    });

    expect(card).toMatchObject({ kind: 'new_booking', missing: [], writesEnabled: false });
    expect(card!.steps).toEqual([
      { label: 'Group 1 Arrival', value: '2026-11-12', source: 'mail' },
      { label: 'Group 1 Departure', value: '2026-11-14', source: 'mail' },
      { label: 'Group 1 Rooms', value: '2', source: 'mail' },
      { label: 'Group 1 Adults per room', value: '2', source: 'mail' },
      { label: 'Group 1 Guests', value: 'Ann Example, Bob Example', source: 'mail' },
      { label: 'Group 2 Arrival', value: '2026-12-01', source: 'mail' },
      { label: 'Group 2 Departure', value: '2026-12-03', source: 'mail' },
      { label: 'Group 2 Rooms', value: '1', source: 'mail' },
      { label: 'Group 2 Adults per room', value: '1', source: 'mail' },
      { label: 'Group 2 Guests', value: 'Cara Example', source: 'mail' },
    ]);
    expect(labelsOf(card!)).not.toContain('Adults');
    expect(new Set(labelsOf(card!)).size).toBe(card!.steps.length);
  });

  const codes = {
    roomType: 'STQN',
    ratePlan: 'BAR',
    track: 'BAR',
    sourceOfBusiness: 'Travel Agent',
    guaranteeType: 'Guaranteed By Agent',
    agency: 'Northwind Travel',
    billingReference: '9999901-1',
  };
  const prefillOut = (
    requests: Record<string, unknown>[],
    missing: Array<{ field: string; question: string }> = [],
  ) => ({
    requests,
    missing,
    schemaErrors: requests.map(() => [] as string[]),
    todoNextStep: 'Key into HMS',
  });

  it('shows HMS codes on new_booking only, once each, with stillNeeded deduped', () => {
    const prefill = prefillOut(
      [{ arrival: '2026-11-12', departure: '2026-11-14', adults: 2, ...codes }],
      [
        { field: 'track', question: 'Track for this booking?' },
        { field: 'track', question: 'Track for this booking?' },
        { field: 'arrival', question: 'Arrival date for this booking?' },
        { field: 'ratePlan', question: 'Rate plan code for this booking?' },
      ],
    );
    const booking = buildHmsTodoCard({
      workflow: 'create_booking',
      stayAsk: { arrivalDate: null, departureDate: '2026-11-14', adults: 2, rooms: 1 },
      guestLastName: 'Labtest',
      prefill,
    });
    expect(booking).toMatchObject({ kind: 'new_booking', writesEnabled: false, missing: ['Arrival'] });
    expect(booking!.prefill).toEqual({
      fields: [
        { label: 'Room type', value: 'STQN' },
        { label: 'Rate plan', value: 'BAR' },
        { label: 'Track', value: 'BAR' },
        { label: 'Source of business', value: 'Travel Agent' },
        { label: 'Guarantee', value: 'Guaranteed By Agent' },
        { label: 'Agency', value: 'Northwind Travel' },
        { label: 'Billing reference', value: '9999901-1' },
      ],
      stillNeeded: ['Track for this booking?', 'Rate plan code for this booking?'],
    });
    expect(booking!.prefill!.fields.some((row) => /arrival|departure|adults|children|guests/i.test(row.label))).toBe(
      false,
    );

    const rooms = buildHmsTodoCard({
      workflow: 'create_booking',
      stayAsk: { arrivalDate: '2026-11-12', departureDate: '2026-11-14', adults: 2, rooms: 2 },
      prefill: prefillOut([
        { roomType: 'STQN', track: 'BAR' },
        { roomType: 'STWN', track: 'BAR' },
      ]),
    });
    expect(rooms!.prefill?.fields).toEqual([
      { label: 'Room type', value: 'STQN' },
      { label: 'Track', value: 'BAR' },
      { label: 'Room 2 room type', value: 'STWN' },
    ]);

    for (const workflow of ['amend', 'cancel'] as const) {
      const card = buildHmsTodoCard({
        workflow,
        confirmationNumber: '9999901-1',
        requestedChange: 'Change departure to 17 Nov',
        prefill,
      });
      expect(card).toMatchObject({ writesEnabled: false });
      expect(card).not.toHaveProperty('prefill');
    }
  });
});

describe('analyseSyncedSelection hmsTodoCard', () => {
  const promptVersion = 'hms-todo-card-test';
  const transportId = 'transport-todo';
  let cacheDir: string | null = null;

  afterEach(async () => {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    cacheDir = null;
  });

  function options(adapter: ModelAdapter, extras: { cacheDir?: string; internetMessageId?: string } = {}) {
    return {
      selectionEpoch: 1,
      cacheDir: extras.cacheDir ?? null,
      promptVersion,
      transportId,
      llmEnabled: () => true,
      adapter,
      ...(extras.internetMessageId ? { internetMessageId: extras.internetMessageId } : {}),
    };
  }

  it('builds the card from date-corrected luna dates, not the raw model year', async () => {
    const selection: SyncedQuoteSelection = {
      subject: 'Please confirm',
      bodyText: 'Please confirm 12-14 March for Ann Example.',
      receivedAt: '2026-12-20T12:00:00.000Z',
      preceding: [],
      attachments: [],
    };
    const { payload } = await analyseSyncedSelection(
      selection,
      options(
        adapterReturning(
          lunaBooking({
            groups: [
              {
                ...emptyGroup,
                arrival: '2026-03-12',
                departure: '2026-03-15',
                dateEvidence: '12-14 March',
                rooms: 1,
                adultsPerRoom: 2,
                guestNames: ['Ann Example'],
              },
            ],
          }),
        ),
      ),
    );

    const card = todoCardOf(payload);
    expect(card).toMatchObject({ kind: 'new_booking', writesEnabled: false });
    expect(stepValue(card!, 'Arrival')).toBe('2027-03-12');
    expect(stepValue(card!, 'Departure')).toBe('2027-03-15');
    expect(stepValue(card!, 'Arrival')).not.toBe('2026-03-12');
    expect((payload.luna as { groups: Array<{ arrival: string }> }).groups[0]?.arrival).toBe(
      '2027-03-12',
    );
  });

  it('keeps every booking group on the card, labelled per room', async () => {
    const selection: SyncedQuoteSelection = {
      subject: 'Please confirm two stays',
      bodyText: 'Please confirm 12-14 November for Ann and Bob, then 1-3 December for Cara.',
      receivedAt: '2026-10-06T08:00:00.000Z',
      preceding: [],
      attachments: [],
    };
    const { payload } = await analyseSyncedSelection(
      selection,
      options(
        adapterReturning(
          lunaBooking({
            groups: [
              {
                ...emptyGroup,
                arrival: '2026-11-12',
                departure: '2026-11-14',
                dateEvidence: '12-14 November',
                rooms: 2,
                adultsPerRoom: 2,
                guestNames: ['Ann Example', 'Bob Example'],
              },
              {
                ...emptyGroup,
                arrival: '2026-12-01',
                departure: '2026-12-03',
                dateEvidence: '1-3 December',
                rooms: 1,
                adultsPerRoom: 1,
                guestNames: ['Cara Example'],
              },
            ],
            tasks: [
              { kind: 'create_booking', groupIndexes: [0], note: 'first stay' },
              { kind: 'create_booking', groupIndexes: [1], note: 'second stay' },
            ],
          }),
        ),
      ),
    );

    const card = todoCardOf(payload);
    expect(card).toMatchObject({ kind: 'new_booking', missing: [] });
    expect(stepValue(card!, 'Group 1 Arrival')).toBe('2026-11-12');
    expect(stepValue(card!, 'Group 1 Rooms')).toBe('2');
    expect(stepValue(card!, 'Group 1 Adults per room')).toBe('2');
    expect(stepValue(card!, 'Group 1 Guests')).toBe('Ann Example, Bob Example');
    expect(stepValue(card!, 'Group 2 Arrival')).toBe('2026-12-01');
    expect(stepValue(card!, 'Group 2 Rooms')).toBe('1');
    expect(stepValue(card!, 'Group 2 Adults per room')).toBe('1');
    expect(stepValue(card!, 'Group 2 Guests')).toBe('Cara Example');
    expect(labelsOf(card!)).not.toContain('Arrival');
    expect(labelsOf(card!)).not.toContain('Adults');
  });

  it('rebuilds a missing card on cache read without calling the model', async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'hms-todo-cache-'));
    const internetMessageId = '<todo-cache@x>';
    const selection: SyncedQuoteSelection = {
      subject: 'Please confirm',
      bodyText: 'Please confirm 12-14 November for Ann Example.',
      receivedAt: '2026-10-06T08:00:00.000Z',
      preceding: [],
      attachments: [{ id: 'att-1', filename: 'request.pdf', bytesPresent: false }],
    };
    const luna = lunaBooking({
      guestLastName: 'Example',
      groups: [
        {
          ...emptyGroup,
          arrival: '2026-11-12',
          departure: '2026-11-14',
          rooms: 1,
          adultsPerRoom: 2,
          guestNames: ['Ann Example'],
        },
      ],
    });
    const cacheFile = analyseCachePath({
      internetMessageId,
      sourceHash: hashSyncedQuoteSelection(selection),
      promptVersion,
      cacheDir,
      transportId,
    });
    await writeFile(
      cacheFile,
      JSON.stringify({
        status: 'ready',
        source: 'luna',
        intent: 'other',
        groups: [],
        luna,
      }),
    );
    const adapter = adapterReturning(lunaBooking());
    const { payload, outcome } = await analyseSyncedSelection(
      selection,
      options(adapter, { cacheDir, internetMessageId }),
    );

    expect(outcome).toEqual({ kind: 'cache_hit' });
    expect(adapter.invoke).not.toHaveBeenCalled();
    const card = todoCardOf(payload);
    expect(card).toMatchObject({
      kind: 'new_booking',
      writesEnabled: false,
      missing: [],
    });
    expect(stepValue(card!, 'Arrival')).toBe('2026-11-12');
    expect(stepValue(card!, 'Adults per room')).toBe('2');
    expect(stepValue(card!, 'Attachments')).toBe('request.pdf');
  });
});

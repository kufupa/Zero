import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeStaffQuote,
  quoteWithPartyFallback,
  partyContractReviewNote,
  partyNoContractNote,
  partyRateContext,
  prepareStaffQuote,
  staffQuoteInput,
  type StaffQuoteParties,
} from '../src/ai/staff-quote-workflow.js';
import {
  createReservationistBusinessServices,
  partyContractChoice,
} from '../src/ai/reservationist-business-services.js';
import { occupiedDates } from '../src/quote-proposal/quote-revision.js';
import { availabilityBoardOf } from '../src/ai/hms-availability.js';
import { otherBoardContractNotes, type RateOption } from '../src/ai/rate-options.js';
import { panePartyLookupLoaders, verifyPartyPick } from '../src/ai/pane-party-lookup.js';
import { suggestPartiesFor } from '../src/ai/party-aliases.js';
import {
  PARTY_NO_CONTRACT_CODE,
  PARTY_SEARCH_INCOMPLETE_CODE,
  PartyRateFailure,
  isPartyRateFailure,
  partyReadingOf,
} from '../src/ai/party-rate-failure.js';

// The Rate Shop helpers the runner uses, for the runner-input checks.
type RunnerSeams = {
  pickerFilter: (kind: string, reference: Record<string, unknown>) => { name: string; value: string };
};
const runner = (await import('../tooling/playwright-quote/fetch-quote.mjs' as string)) as RunnerSeams;
const normalizer = (await import('../tooling/playwright-quote/quote-contract.mjs' as string)) as {
  normalizeQuoteRequest: (input: unknown) => { ok: boolean; request: any };
};

const ARRIVAL = '2026-10-12';
const DEPARTURE = '2026-10-15';
const signer = { signerName: 'Staff', signerEmail: 'staff@example.test' };
const scope = {
  transportId: 'transport',
  userId: 'staff',
  threadId: 'thread',
  messageId: 'message',
  sourceHash: 'a'.repeat(64),
  propertyCode: 'HRCEN',
  messageAt: '2026-09-30T12:00:00Z',
  messageText: 'Booking for Woolworths employees',
};

afterEach(() => {
  vi.unstubAllEnvs();
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
});

// Fixture rows, named the way HMS names them. The names are test labels, not live data.
type Rate = {
  code: string;
  label: string;
  rateScope: 'public' | 'contextual' | 'unknown';
  amounts: string[];
  room?: string;
  board?: 'room_only' | 'breakfast';
  availability?: 'available' | 'unavailable';
};
const BAR: Rate = { code: 'BARRO', label: 'Room Only', rateScope: 'public', amounts: ['500.00'] };
const WOOLWORTHS_FLAGGED: Rate = { code: 'BCO1B', label: 'Woolworths Negotiated', rateScope: 'contextual', amounts: ['520.00'] };
const AGENCY_FLAGGED: Rate = { code: 'WSF2B', label: 'Agency Negotiated', rateScope: 'contextual', amounts: ['610.00'] };
// Named after the party but not flagged by HMS: it must never be offered as a contract, however cheap it is.
const NAME_ONLY: Rate = { code: 'NGD10B', label: 'Woolworths Corporate', rateScope: 'unknown', amounts: ['100.00'] };
// A flagged contract on the B&B board only: a room-only request must not take it, but it is listed beside the quote.
const BB_FLAGGED: Rate = { code: 'BCO2B', label: 'Woolworths Negotiated B&B', rateScope: 'contextual', amounts: ['640.00'], board: 'breakfast' };

function rateOption(rate: Rate, context: Record<string, unknown>) {
  const dates = occupiedDates(ARRIVAL, DEPARTURE);
  return {
    id: `${rate.room ?? 'SKNG'}:${rate.code}`,
    room: { code: rate.room ?? 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
    rate: { code: rate.code, label: rate.label },
    board: rate.board === 'breakfast' ? 'Bed & Breakfast R' : 'Room Only R',
    appliedContext: context,
    rateScope: rate.rateScope,
    // Verified on purpose: the contract rule must hold by flag alone, not because some other check filtered the row.
    eligibility: 'verified',
    availability: rate.availability ?? 'available',
    matchStatus: 'match',
    held: false,
    totals: { taxInclusive: true },
    nightly: dates.map((date, i) => ({
      date,
      inventory: 8,
      price: { amount: rate.amounts[i] ?? rate.amounts.at(-1)!, currency: 'ZAR' },
    })),
  };
}

/**
 * The rows one Rate Shop read returns, as fetch-quote.mjs marks them under a party context. A flagged row and a public row are
 * bookable matches (the public row is the BAR it is). A name-only row is unresolved. A row off the requested board, room or
 * rate is an alternative, which the staff read keeps for the rate cards.
 */
function rateShopRows(request: any, rates: Rate[], context: Record<string, unknown>) {
  const partyRequested = Object.keys(request.rateContext ?? {}).length > 0;
  const ask = request.rooms[0]?.required ?? {};
  const boardOf = (rate: Rate) => (rate.board === 'breakfast' ? 'breakfast' : 'room_only');
  return rates.map((rate) => {
    const off =
      (ask.boardBases?.length && !ask.boardBases.includes(boardOf(rate))) ||
      (ask.roomCodes?.length && !ask.roomCodes.includes(rate.room ?? 'SKNG')) ||
      (ask.rateCodes?.length && !ask.rateCodes.includes(rate.code));
    return {
      ...rateOption(rate, context),
      eligibility: rate.rateScope === 'unknown' ? 'conditional' : 'verified',
      matchStatus: off ? 'alternative' : partyRequested && rate.rateScope === 'unknown' ? 'unresolved' : 'match',
    };
  });
}

const policy = {
  ref: 'policy',
  propertyCode: 'HRCEN',
  sourceHashes: ['c'.repeat(64)],
  authoredDates: ['2026-09-08'],
  families: [
    { rateCode: 'BARRO', board: 'room_only' as const },
    { rateCode: 'BCO1B', board: 'room_only' as const },
    { rateCode: 'WSF2B', board: 'room_only' as const },
    { rateCode: 'NGD10B', board: 'room_only' as const },
    ...['ACM1B', 'ACM2B', 'ALH1B', 'BLU1B', 'OBK1B', 'SIG1B', 'NOR1B'].map((rateCode) => ({ rateCode, board: 'room_only' as const })),
  ],
  vat: 'included' as const,
  levy: 'included' as const,
};

function groupInput(
  parties?: StaffQuoteParties,
  text: { company?: string; agency?: string } = {},
  group: { pin?: string; roomCodes?: string[] } = {},
) {
  return staffQuoteInput.parse({
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: 3,
    inputRevision: 2,
    groups: [
      {
        id: 'single',
        arrivalDate: ARRIVAL,
        departureDate: DEPARTURE,
        quantity: 1,
        adults: 1,
        childrenAges: [],
        board: 'room_only',
        ...(group.roomCodes ? { roomCodes: group.roomCodes } : {}),
        ...(group.pin ? { rateCode: group.pin } : {}),
      },
    ],
    ...text,
    ...(parties ? { parties } : {}),
  });
}

/** HMS's own display name for an id, when it differs from the name staff or Nava typed (e.g. "Woolworths Holdings"). */
const hmsDisplayName: Record<string, string> = {};

/** What HMS resolves each requested context to: the id the picker found, and HMS's own name for it. */
function resolvedContext(rateContext: Record<string, { nativeId: string; name: string }> | undefined) {
  return Object.fromEntries(
    Object.entries(rateContext ?? {}).map(([kind, ref]) => [
      kind,
      { id: ref.nativeId, name: hmsDisplayName[ref.nativeId] ?? ref.name },
    ]),
  );
}

/**
 * What HMS returns for a read's codes. Staff reads keep alternatives on, so off-rate and off-room rows come back marked as
 * alternatives, as the runner's visibility rule does. With alternatives off, an exact rate filter returns only those rows.
 * A room-type filter with no rate named hides the flagged rows. That is why a party's summary read must not carry a room type.
 */
function hmsVisibleRows(request: any, rates: Rate[]): Rate[] {
  const required = request.rooms[0]?.required ?? {};
  const wantedRates: string[] = required.rateCodes ?? [];
  if (wantedRates.length && !request.search?.includeAlternatives) return rates.filter((rate) => wantedRates.includes(rate.code));
  if (required.roomCodes?.length && !wantedRates.length) return rates.filter((rate) => rate.rateScope !== 'contextual');
  return rates;
}

/** The Rate Shop services for one staff attempt: every read is answered from the rows, under the attempt's context. */
function rateShopServices(
  prepared: ReturnType<typeof prepareStaffQuote>,
  rates: Rate[],
  sent: any[],
  flags: {
    readParty?: any;
    incompleteParty?: boolean;
    truncatedParty?: boolean;
    contextChangedInFullRead?: boolean;
    onRateOptions?: (options: RateOption[]) => void;
  } = {},
) {
  const context = resolvedContext(prepared.request.rateContext);
  return createReservationistBusinessServices(
    {
      authorizationId: prepared.authorizationId,
      authorizeContext: async () => true,
      signer,
      readQuote: async (request: any) => {
        sent.push(request);
        const normalized = normalizer.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
        // As the runner returns them: matches first, at most maxOptionsPerGroup rows. A cut row that is not an alternative
        // marks the list cut.
        const rank: Record<string, number> = { match: 0, alternative: 1, unresolved: 2 };
        const ordered = rateShopRows(request, hmsVisibleRows(request, rates), context).sort(
          (a, b) => rank[a.matchStatus]! - rank[b.matchStatus]!,
        );
        const rows = ordered.slice(0, normalized.maxOptionsPerGroup).map((row) =>
          flags.contextChangedInFullRead && request.rateContext && request.details === 'full' && row.rateScope === 'contextual'
            ? { ...row, rateScope: 'public' as const } : row);
        const cut = ordered.slice(normalized.maxOptionsPerGroup).some((row) => row.matchStatus !== 'alternative');
        // As the runner reads it: an unfiltered full read of more than five rows has no detail rows, so it is partial.
        const unfilteredFull =
          request.details === 'full' &&
          !request.rooms.some((room: any) => room.required?.roomCodes?.length || room.required?.rateCodes?.length);
        // A party read whose calendar pages did not all load, or whose list was cut: its groups report it, as the runner does.
        const incomplete = Boolean(flags.incompleteParty && request.rateContext);
        const truncated = Boolean(flags.truncatedParty && request.rateContext) || cut;
        const completeness = incomplete
          ? { search: 'partial', requiredFacts: 'partial' }
          : truncated
            ? { search: 'truncated', requiredFacts: 'complete' }
            : { search: 'complete', requiredFacts: 'complete' };
        return {
          ref: 'source:1',
          sha256: 'b'.repeat(64),
          toolVersion: 'fixture',
          observedAt: new Date().toISOString(),
          request: normalized,
          result: {
            outcome: incomplete || truncated || (unfilteredFull && rows.length > 5) ? 'partial' : 'quote',
            propertyCode: 'HRCEN',
            groups: normalized.rooms.map((r: any) => ({
              id: r.id,
              request: r,
              completeness,
              options: rows,
            })),
          },
        };
      },
      resolvePolicy: async () => policy,
      ...(flags.readParty ? { readParty: flags.readParty } : {}),
    },
    { ...prepared.approval, ...(flags.onRateOptions ? { onRateOptions: flags.onRateOptions } : {}) },
  );
}

/** One quote through the staff path, as the workstation runs it: the picked parties first, public rates if HMS flags none. */
async function quoteWith(
  parties: StaffQuoteParties | undefined,
  rates: Rate[],
  options: {
    header?: { company?: string; agency?: string };
    readParty?: any;
    incompleteParty?: boolean;
    truncatedParty?: boolean;
    contextChangedInFullRead?: boolean;
    pin?: string;
    roomCodes?: string[];
  } = {},
) {
  const confirmed = groupInput(parties, options.header, { pin: options.pin, roomCodes: options.roomCodes });
  const first = prepareStaffQuote(confirmed, scope, signer, new AbortController().signal);
  const sent: any[] = [];
  // The rate cards of the attempt that priced; a failed attempt never publishes any.
  const cards: RateOption[][] = [];
  const onRateOptions = (published: RateOption[]) => {
    cards.push(published);
  };
  const attempt = await quoteWithPartyFallback({
    input: confirmed,
    first,
    retry: () => prepareStaffQuote(confirmed, scope, signer, new AbortController().signal, 'public'),
    run: (prepared) =>
      executeStaffQuote(prepared, rateShopServices(prepared, rates, sent, { ...options, onRateOptions }), async () => true),
  });
  return {
    prepared: first,
    revision: attempt.result,
    note: attempt.note,
    fellBack: attempt.fellBack,
    sent,
    cards: cards.at(-1) ?? [],
  };
}

const company = (nativeId: string, name: string) => ({ kind: 'company' as const, nativeId, name });
const agency = (nativeId: string, name: string) => ({ kind: 'agency' as const, nativeId, name });

describe('contract rates from the picked company or agency', () => {
  it('a company pick sends its HMS id as the organization context, and the Rate Shop reads that id', async () => {
    const { prepared } = await quoteWith({ company: company('49', 'Woolworths') }, [BAR]);
    expect(prepared.request.rateContext).toEqual({ organization: { nativeId: '49', name: 'Woolworths' } });
    expect(runner.pickerFilter('organization', { nativeId: '49', name: 'Woolworths' })).toEqual({
      name: 'ff_companyid',
      value: '49',
    });
  });

  it('an agency pick alone sends the agency id; flagged rows if any, otherwise BAR', async () => {
    const flagged = await quoteWith({ agency: agency('569', 'Woolworths Agency') }, [BAR, AGENCY_FLAGGED]);
    expect(flagged.prepared.request.rateContext).toEqual({ agency: { nativeId: '569', name: 'Woolworths Agency' } });
    expect(flagged.revision.groups[0]!.rateCode).toBe('WSF2B');

    const none = await quoteWith({ agency: agency('113', '360 degrees Travel') }, [BAR]);
    expect(none.revision.groups[0]!.rateCode).toBe('BARRO');
    expect(partyContractReviewNote({ agency: agency('113', '360 degrees Travel') }, none.revision.groups)).toBe(
      'No contract rate found for 360 degrees Travel; this quote uses our best available rate.',
    );
  });

  it('both picks send both ids, and only the flagged rows are offered as contracts', async () => {
    const parties = { company: company('49', 'Woolworths'), agency: agency('569', 'Woolworths Agency') };
    const { prepared, revision } = await quoteWith(parties, [NAME_ONLY, WOOLWORTHS_FLAGGED, AGENCY_FLAGGED, BAR]);
    expect(prepared.request.rateContext).toEqual({
      organization: { nativeId: '49', name: 'Woolworths' },
      agency: { nativeId: '569', name: 'Woolworths Agency' },
    });
    // The cheapest flagged row is priced. The cheaper unflagged name match is not.
    expect(revision.groups[0]!.rateCode).toBe('BCO1B');
    const offered = partyContractChoice(
      prepared.request.rateContext,
      [NAME_ONLY, WOOLWORTHS_FLAGGED, AGENCY_FLAGGED, BAR].map((rate) => rateOption(rate, {})),
    ).map((option) => option.rate.code);
    expect(offered).toEqual(['BCO1B', 'WSF2B']);
  });

  it('nothing flagged prices BAR and says so in plain copy', async () => {
    const { revision } = await quoteWith({ company: company('49', 'Woolworths') }, [BAR]);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(partyNoContractNote(['Woolworths'])).toBe(
      'No contract rate found for Woolworths; this quote uses our best available rate.',
    );
    expect(partyContractReviewNote({ company: company('49', 'Woolworths') }, revision.groups)).toBe(
      'No contract rate found for Woolworths; this quote uses our best available rate.',
    );
    expect(partyContractReviewNote({ company: company('49', 'Woolworths') }, [{ rateCode: 'BCO1B' }])).toBeNull();
  });

  it('a verified party with only public rows reads the party once, then quotes BAR the public way, with the review copy', async () => {
    const agency360 = { agency: agency('113', '360 degrees Travel') };
    const { revision, fellBack, note, sent } = await quoteWith(agency360, [BAR]);
    expect(fellBack).toBe(true);
    expect(note).toBe('No matching contract rate was found for 360 degrees Travel for at least one requested room; check the selected fallback rate in HMS.');
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(partyContractReviewNote(agency360, revision.groups)).toBe(
      'No contract rate found for 360 degrees Travel; this quote uses our best available rate.',
    );
    // The party read stops at its summary. The public retry reads without any party context.
    const withContext = sent.filter((request) => request.rateContext);
    expect(withContext).toHaveLength(1);
    expect(withContext[0]!.details).toBe('summary');
    expect(sent.at(-1)).not.toHaveProperty('rateContext');
  });

  it('more than five unflagged rows never get an unfiltered full read; the public quote prices the cheapest row', async () => {
    const rooms = ['SKNG', 'STWN', 'STQN', 'DLXQN', 'DLXKN', 'STKNG'];
    const unflagged: Rate[] = rooms.map((room, i) => ({
      code: 'BARRO',
      label: 'Room Only',
      rateScope: 'public',
      amounts: [`${500 + i * 10}.00`],
      room,
    }));
    const { revision, fellBack, sent } = await quoteWith({ agency: agency('113', '360 degrees Travel') }, unflagged);
    expect(fellBack).toBe(true);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(revision.groups[0]!.roomCode).toBe('SKNG');
    // The only full read under the party context is none: the party read stops at its summary.
    expect(sent.filter((request) => request.rateContext && request.details === 'full')).toHaveLength(0);
    // Every full read the quote sends names its room, so none is unfiltered.
    expect(
      sent
        .filter((request) => request.details === 'full')
        .every((request) => request.rooms.every((room: any) => room.required?.roomCodes?.length)),
    ).toBe(true);
  });

  it('an incomplete party search still falls back to public, with the honest copy, never the no-contract copy', async () => {
    const agency360 = { agency: agency('113', '360 degrees Travel') };
    const { revision, fellBack, note } = await quoteWith(agency360, [BAR], { incompleteParty: true });
    expect(fellBack).toBe(true);
    expect(note).toBe(
      "Nava couldn't confirm contract rates for 360 degrees Travel; check the selected fallback rate in HMS before sending.",
    );
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
  });

  it('a verified party with a flagged row prices that contract row, not the public one', async () => {
    const agencyWoolworths = { agency: agency('569', 'Woolworths Agency') };
    const { revision } = await quoteWith(agencyWoolworths, [BAR, AGENCY_FLAGGED]);
    expect(revision.groups[0]!.rateCode).toBe('WSF2B');
    expect(partyContractReviewNote(agencyWoolworths, revision.groups)).toBeNull();
  });

  it('does not label a price as contracted when its full read disagrees with the summary', async () => {
    const parties = { agency: agency('569', 'Woolworths Agency') };
    const { revision, note, fellBack, cards } = await quoteWith(parties, [BAR, AGENCY_FLAGGED], { contextChangedInFullRead: true });
    expect(fellBack).toBe(true);
    expect(note).toContain("couldn't confirm contract rates");
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(cards.some((card) => card.contract)).toBe(false);
  });

  it('matches the party by HMS id, so a shorter name ("Woolworths" vs "Woolworths Holdings") still gets the contract row', async () => {
    hmsDisplayName['569'] = 'Woolworths Agency (Pty) Ltd';
    try {
      const picked = { agency: agency('569', 'Woolworths') };
      const { revision } = await quoteWith(picked, [BAR, AGENCY_FLAGGED]);
      expect(revision.groups[0]!.rateCode).toBe('WSF2B');
      expect(partyContractReviewNote(picked, revision.groups)).toBeNull();
    } finally {
      delete hmsDisplayName['569'];
    }
  });

  it('a plan named after the party is not offered as a contract unless HMS flags it', async () => {
    const { revision, note } = await quoteWith({ company: company('49', 'Woolworths') }, [NAME_ONLY, BAR]);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(revision.groups[0]!.rateCode).not.toBe('NGD10B');
    expect(note).toContain("couldn't confirm contract rates");
  });

  it('with the switch off, no party context is sent and the request is public', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    const prepared = prepareStaffQuote(
      groupInput({ company: company('49', 'Woolworths') }),
      scope,
      signer,
      new AbortController().signal,
    );
    expect(prepared.request).not.toHaveProperty('rateContext');
    expect(prepared.approval.rates).toBe('public');
  });

  it('an unverified alias id, which is null, is never sent as a party', () => {
    expect(() =>
      staffQuoteInput.parse({
        messageId: scope.messageId,
        sourceHash: scope.sourceHash,
        selectionEpoch: 3,
        inputRevision: 2,
        groups: groupInput().groups,
        parties: { company: { kind: 'company', nativeId: null, name: 'Tourvest' } },
      }),
    ).toThrow();
  });

  it('the rate context carries the organization and agency only, so no commission or A/R account is sent', () => {
    const context = partyRateContext({ company: company('49', 'Woolworths'), agency: agency('569', 'Agency') });
    expect(Object.keys(context ?? {}).sort()).toEqual(['agency', 'organization']);
    expect(partyRateContext(undefined)).toBeUndefined();
  });
});

describe('availability board overlay from the existing read', () => {
  it('carries rateScope onto board rows and never treats a public or unknown code as contextual', () => {
    const board = availabilityBoardOf({
      outcome: 'quote',
      groups: [
        {
          id: 'group-1',
          options: [
            {
              room: { code: 'STQN', label: 'Standard Queen' },
              rate: { code: 'BARRO', label: 'Room Only' },
              rateScope: 'public',
              board: 'Room Only R',
              availability: 'available',
            },
            {
              room: { code: 'STQN', label: 'Standard Queen' },
              rate: { code: 'BCO1B', label: 'Negotiated' },
              rateScope: 'contextual',
              board: 'Room Only R',
              availability: 'available',
            },
            {
              room: { code: 'STQN', label: 'Standard Queen' },
              rate: { code: 'NCORRO', label: 'Named plan' },
              rateScope: 'unknown',
              board: 'Room Only R',
              availability: 'available',
            },
          ],
        },
      ],
    });
    expect(board.rows.map((row) => [row.rateCode, row.rateScope])).toEqual([
      ['BARRO', 'public'],
      ['BCO1B', 'contextual'],
      ['NCORRO', 'unknown'],
    ]);
  });

  it('omits rateScope when the reader did not send one', () => {
    const board = availabilityBoardOf({
      outcome: 'quote',
      groups: [
        {
          id: 'group-1',
          options: [
            {
              room: { code: 'STQN', label: 'Standard Queen' },
              rate: { code: 'BAR', label: 'Best available' },
              board: 'Bed & Breakfast R',
              availability: 'available',
            },
          ],
        },
      ],
    });
    expect(board.rows[0]).not.toHaveProperty('rateScope');
  });
});

describe('staff rate cards: the quoted option first, other boards labelled, a pin re-runs the quote', () => {
  it('(a) a room-only request with only a B&B contract quotes the public room-only rate, lists the contract second, and says so', async () => {
    const { revision, fellBack, cards } = await quoteWith({ company: company('49', 'Woolworths') }, [BAR, BB_FLAGGED]);
    expect(fellBack).toBe(false);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ rateCode: 'BARRO', board: 'room_only', contract: false, matchesRequest: true, selected: true, priced: 'full' });
    expect(cards[1]).toMatchObject({ rateCode: 'BCO2B', board: 'bb', boardLabel: 'Bed & Breakfast R', contract: true, onlyContract: true, matchesRequest: false, selected: false, priced: 'summary' });
    expect(otherBoardContractNotes(['Woolworths'], cards)).toEqual([
      "Woolworths's contract rate is Bed & Breakfast R only (BCO2B). Quoted room only at the public rate as asked. Pick the contract option to switch.",
    ]);
  });

  it('(b) a room-only contract is quoted first, with the public room-only rate listed beside it', async () => {
    const { revision, cards } = await quoteWith({ company: company('49', 'Woolworths') }, [BAR, WOOLWORTHS_FLAGGED]);
    expect(revision.groups[0]!.rateCode).toBe('BCO1B');
    expect(cards.map((card) => card.rateCode)).toEqual(['BCO1B', 'BARRO']);
    expect(cards[0]).toMatchObject({ contract: true, matchesRequest: true, selected: true, priced: 'full' });
    expect(cards[1]).toMatchObject({ contract: false, matchesRequest: true, selected: false, priced: 'summary' });
    expect(otherBoardContractNotes(['Woolworths'], cards)).toEqual([]);
  });

  it('(c) with no flagged row on any board, the first attempt is PARTY_NO_CONTRACT and the public retry has no contract card', async () => {
    const parties = { company: company('49', 'Woolworths') };
    const first = prepareStaffQuote(groupInput(parties), scope, signer, new AbortController().signal);
    await expect(executeStaffQuote(first, rateShopServices(first, [BAR], []), async () => true)).rejects.toMatchObject({
      code: PARTY_NO_CONTRACT_CODE,
    });
    const { fellBack, note, cards } = await quoteWith(parties, [BAR]);
    expect(fellBack).toBe(true);
    expect(note).toBe('No matching contract rate was found for Woolworths for at least one requested room; check the selected fallback rate in HMS.');
    expect(cards.some((card) => card.contract)).toBe(false);
  });

  it('reports a missing contract from the retry outcome even for a public rate code the heuristic does not recognize', async () => {
    const parties = { company: company('49', 'Woolworths') };
    const attempt = await quoteWithPartyFallback({
      input: groupInput(parties),
      first: 'party',
      retry: () => 'fallback',
      run: async (kind) => {
        if (kind === 'party') throw new PartyRateFailure(PARTY_NO_CONTRACT_CODE);
        return { groups: [{ rateCode: 'WAL' }] };
      },
    });
    expect(partyContractReviewNote(parties, attempt.result.groups)).toBeNull();
    expect(attempt.note).toBe('No matching contract rate was found for Woolworths for at least one requested room; check the selected fallback rate in HMS.');
  });

  it('(d) a sold-out requested room still fails as before, and no rate cards are published for that quote', async () => {
    const first = prepareStaffQuote(
      groupInput({ company: company('49', 'Woolworths') }, {}, { roomCodes: ['SKNG'] }),
      scope,
      signer,
      new AbortController().signal,
    );
    const cards: RateOption[][] = [];
    const rates: Rate[] = [{ ...BAR, availability: 'unavailable' }, { ...BAR, room: 'STQN' }];
    await expect(
      executeStaffQuote(first, rateShopServices(first, rates, [], { onRateOptions: (published) => cards.push(published) }), async () => true),
    ).rejects.toMatchObject({ code: 'business_selected_price_unavailable' });
    expect(cards).toEqual([]);
  });

  it('(f) a pinned rate code re-runs the quote with only that rate priced in full', async () => {
    const pinnedBar = await quoteWith({ company: company('49', 'Woolworths') }, [BAR, WOOLWORTHS_FLAGGED], { pin: 'BARRO' });
    expect(pinnedBar.prepared.request.rooms[0]!.required?.rateCodes).toEqual(['BARRO']);
    expect(pinnedBar.revision.groups[0]!.rateCode).toBe('BARRO');
    expect(pinnedBar.cards.filter((card) => card.priced === 'full').map((card) => card.rateCode)).toEqual(['BARRO']);
    expect(pinnedBar.cards.find((card) => card.rateCode === 'BCO1B')).toMatchObject({ matchesRequest: false, selected: false, priced: 'summary' });

    const pinnedContract = await quoteWith({ company: company('49', 'Woolworths') }, [BAR, WOOLWORTHS_FLAGGED], { pin: 'BCO1B' });
    expect(pinnedContract.revision.groups[0]!.rateCode).toBe('BCO1B');
    expect(pinnedContract.cards[0]).toMatchObject({ rateCode: 'BCO1B', selected: true, priced: 'full' });
  });

  it('the pin and the alternatives flag reach the native request, and a malformed pin is refused', () => {
    const prepared = prepareStaffQuote(
      groupInput({ company: company('49', 'Woolworths') }, {}, { pin: 'BCO1B' }),
      scope,
      signer,
      new AbortController().signal,
    );
    expect(prepared.request.search.includeAlternatives).toBe(true);
    expect(prepared.request.rooms[0]!.required).toMatchObject({ rateCodes: ['BCO1B'], boardBases: ['room_only'] });
    expect(() => groupInput(undefined, {}, { pin: 'bco1b!' })).toThrow();
  });
});

describe('re-checking a picked id in HMS before it is bound', () => {
  it('binds the HMS name for a pick HMS returns with the same id and name', async () => {
    panePartyLookupLoaders.lock = { withLock: async (fn) => fn() };
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'resolved',
      candidates: [{ nativeId: '49', displayName: 'Woolworths Holdings', kind: 'organization', matchedOn: ['store'] }],
      truncated: false,
    });
    await expect(verifyPartyPick({ kind: 'company', nativeId: '49', name: 'woolworths holdings' })).resolves.toEqual({
      ok: true,
      party: { kind: 'company', nativeId: '49', name: 'Woolworths Holdings' },
    });
  });

  it('refuses an id HMS does not return for that name, so a made-up id is never bound', async () => {
    panePartyLookupLoaders.lock = { withLock: async (fn) => fn() };
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'resolved',
      candidates: [{ nativeId: '49', displayName: 'Woolworths', kind: 'organization', matchedOn: ['store'] }],
      truncated: false,
    });
    await expect(verifyPartyPick({ kind: 'company', nativeId: '999', name: 'Woolworths' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('refuses with the switch off before any lock or lookup', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    const spawn = vi.fn();
    panePartyLookupLoaders.spawn = spawn;
    await expect(verifyPartyPick({ kind: 'company', nativeId: '49', name: 'Woolworths' })).resolves.toEqual({
      ok: false,
      reason: 'refused_flag_off',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('suggestions for the picker', () => {
  it('a sender alias carries no HMS id, so it is unverified until staff find it in HMS; body names never carry one', () => {
    const suggestions = suggestPartiesFor({
      sender: 'ops@mycwt.co.za',
      body: 'Travel Agency Details: RENNIES TRAVEL (PTY) LTD\nOrganization Details: Tourvest',
    });
    expect(suggestions).toEqual([
      { source: 'body', kind: 'agency', name: 'RENNIES TRAVEL (PTY) LTD', nativeId: null, idStatus: 'unverified' },
      { source: 'body', kind: 'company', name: 'Tourvest', nativeId: null, idStatus: 'unverified' },
      { source: 'sender', kind: 'agency', name: 'CWT JNB', nativeId: null, idStatus: 'unverified' },
    ]);
  });
});

describe('a party-rate failure falls back to public rates, and only a typed failure does', () => {
  it('classifies by type: our PartyRateFailure and the business evidence error with a party code; never a plain Error', async () => {
    const { PartyRateFailure, isPartyRateFailure } = await import('../src/ai/party-rate-failure.js');
    const { ReservationistTaskEvidenceUnavailable } = await import('../src/ai/reservationist-execution.js');
    expect(isPartyRateFailure(new PartyRateFailure('staff_quote_party_unavailable'))).toBe(true);
    expect(isPartyRateFailure(new ReservationistTaskEvidenceUnavailable('business_party_identity_unavailable', []))).toBe(true);
    expect(isPartyRateFailure(new ReservationistTaskEvidenceUnavailable('native_quote_no_matching_rate', []))).toBe(false);
    // A plain Error with a party code as its message is not judged by that text.
    expect(isPartyRateFailure(new Error('staff_quote_party_unavailable'))).toBe(false);
    expect(isPartyRateFailure(Object.assign(new Error('x'), { code: 'business_party_identity_unavailable' }))).toBe(false);
  });

  it('when HMS cannot price the picked company, the quote retries at public rates and says so in plain copy', async () => {
    const { quoteWithPartyFallback, partyRateFallbackNote, prepareStaffQuote, executeStaffQuote } = await import(
      '../src/ai/staff-quote-workflow.js'
    );
    const { PartyRateFailure } = await import('../src/ai/party-rate-failure.js');
    const parties = { company: company('49', 'Woolworths') };
    const normalizer2 = normalizer;
    const readFor = (request: any) => {
      const normalized = normalizer2.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
      // The party's rate is not priceable (only an unflagged plan). The public request has BAR.
      const rates = request.rateContext ? [NAME_ONLY] : [BAR];
      return {
        ref: 'source:1',
        sha256: 'b'.repeat(64),
        toolVersion: 'fixture',
        observedAt: new Date().toISOString(),
        request: normalized,
        result: {
          outcome: 'quote',
          propertyCode: 'HRCEN',
          groups: normalized.rooms.map((r: any) => ({
            id: r.id,
            request: r,
            completeness: { search: 'complete', requiredFacts: 'complete' },
            options: rates.map((rate) => rateOption(rate, resolvedContext(request.rateContext))),
          })),
        },
      };
    };
    const runAttempt = async (attempt: ReturnType<typeof prepareStaffQuote>) =>
      executeStaffQuote(
        attempt,
        createReservationistBusinessServices(
          {
            authorizationId: attempt.authorizationId,
            authorizeContext: async () => true,
            signer,
            readQuote: async (request: any) => readFor(request),
            resolvePolicy: async () => policy,
          },
          attempt.approval,
        ),
        async () => true,
      );
    const confirmed = groupInput(parties);
    const outcome = await quoteWithPartyFallback({
      input: confirmed,
      first: prepareStaffQuote(confirmed, scope, signer, new AbortController().signal),
      retry: () => prepareStaffQuote(confirmed, scope, signer, new AbortController().signal, 'public'),
      run: runAttempt,
    });
    expect(outcome.fellBack).toBe(true);
    expect(outcome.result.groups[0]!.rateCode).toBe('BARRO');
    expect(outcome.note).toBe(partyRateFallbackNote(['Woolworths']));
    expect(outcome.note).toBe("HMS couldn't apply the contract rate for Woolworths; check the selected fallback rate in HMS.");
    // A plain Error is not a party-rate failure, so it is not swallowed by the fallback.
    await expect(
      quoteWithPartyFallback({
        input: confirmed,
        first: prepareStaffQuote(confirmed, scope, signer, new AbortController().signal),
        retry: () => prepareStaffQuote(confirmed, scope, signer, new AbortController().signal, 'public'),
        run: async () => {
          throw new Error('staff_quote_party_unavailable');
        },
      }),
    ).rejects.toThrow('staff_quote_party_unavailable');
    expect(new PartyRateFailure('staff_quote_party_invalid').code).toBe('staff_quote_party_invalid');
  });
});

describe('an unpicked company or agency is text only: it is never looked up and never adds an id', () => {
  // A lookup here is a failure: staff picked nothing for it, so there is nothing to look up.
  const noLookup = () =>
    vi.fn(async (): Promise<never> => {
      throw new Error('unexpected party lookup');
    });

  it('company picked, agency typed: only the organization is sent, and the typed agency is not looked up', async () => {
    const readParty = noLookup();
    const { prepared, sent } = await quoteWith({ company: company('49', 'Woolworths') }, [WOOLWORTHS_FLAGGED, BAR], {
      header: { company: 'Woolworths', agency: 'Typed Agency Ltd' },
      readParty,
    });
    expect(readParty).not.toHaveBeenCalled();
    expect(prepared.request.rateContext).toEqual({ organization: { nativeId: '49', name: 'Woolworths' } });
    expect(sent.at(-1)?.rateContext).toEqual({ organization: { nativeId: '49', name: 'Woolworths' } });
  });

  it('agency picked, company typed: only the agency is sent, and the typed company is not looked up', async () => {
    const readParty = noLookup();
    const { prepared, sent } = await quoteWith({ agency: agency('569', 'Woolworths Agency') }, [AGENCY_FLAGGED, BAR], {
      header: { company: 'Typed Company', agency: 'Woolworths Agency' },
      readParty,
    });
    expect(readParty).not.toHaveBeenCalled();
    expect(prepared.request.rateContext).toEqual({ agency: { nativeId: '569', name: 'Woolworths Agency' } });
    expect(sent.at(-1)?.rateContext).toEqual({ agency: { nativeId: '569', name: 'Woolworths Agency' } });
  });

  it('nothing picked: both typed names are text only, with no lookup and no rate context', async () => {
    const readParty = noLookup();
    const { prepared, sent } = await quoteWith(undefined, [BAR], {
      header: { company: 'Typed Company', agency: 'Typed Agency Ltd' },
      readParty,
    });
    expect(readParty).not.toHaveBeenCalled();
    expect(prepared.request.rateContext).toBeUndefined();
    expect(sent.at(-1)?.rateContext).toBeUndefined();
  });
});

describe('a public-only party read is no contract only when its search covered every group', () => {
  const withContext = { agency: { nativeId: '113', name: '360 degrees Travel' } };
  const row = (rateScope: string) => ({
    id: 'SKNG:BARRO',
    rateScope,
    matchStatus: 'unresolved',
    eligibility: 'verified',
    availability: 'available',
  });
  const group = (rows: unknown[], completeness = { search: 'complete', requiredFacts: 'complete' }, issues: unknown[] = []) => ({
    id: 'room-1',
    completeness,
    issues,
    options: rows,
  });

  it('unknown rate scope leaves the party search incomplete', () => {
    expect(partyReadingOf([group([row('public'), row('unknown')])], withContext)).toBe('incomplete');
    expect(partyReadingOf([group([row('public'), {}])], withContext)).toBe('incomplete');
    expect(partyReadingOf([group([row('public')])], withContext)).toBe('no_contract');
  });

  it('a group whose search is partial is incomplete, so no contract is never concluded from it', () => {
    expect(partyReadingOf([group([row('public')], { search: 'partial', requiredFacts: 'partial' })], withContext)).toBe(
      'incomplete',
    );
  });

  it('a missing calendar page is incomplete even when its group reports complete', () => {
    expect(partyReadingOf([group([row('public')], undefined, [{ code: 'NULL_OR_INVALID_CALENDAR' }])], withContext)).toBe(
      'incomplete',
    );
  });

  it('a flagged row, or no party context, is neither: the contract path or the plain quote decides', () => {
    expect(partyReadingOf([group([row('public'), row('contextual')])], withContext)).toBeNull();
    expect(partyReadingOf([group([row('public')])], undefined)).toBeNull();
  });

  it('PARTY_RATES_NOT_CHECKED is incomplete, never no_contract', () => {
    expect(
      partyReadingOf(
        [group([row('public')], { search: 'complete', requiredFacts: 'complete' }, [{ code: 'PARTY_RATES_NOT_CHECKED' }])],
        withContext,
      ),
    ).toBe('incomplete');
  });

  it('both reasons are party-rate failures, so the public retry runs', () => {
    expect(isPartyRateFailure(new PartyRateFailure(PARTY_NO_CONTRACT_CODE))).toBe(true);
    expect(isPartyRateFailure(new PartyRateFailure(PARTY_SEARCH_INCOMPLETE_CODE))).toBe(true);
    expect(isPartyRateFailure(new Error(PARTY_SEARCH_INCOMPLETE_CODE))).toBe(false);
  });
});

/** A flagged (HMS-negotiated) row, optionally for one room type. */
const flagged = (code: string, room?: string): Rate => ({
  code,
  label: `${code} Negotiated`,
  rateScope: 'contextual',
  amounts: ['520.00'],
  ...(room ? { room } : {}),
});

// Picked names as staff type them, each with the display name HMS gives its id. The parties are made up: these cases pin the
// matching rule (the HMS id, never the name), not any real company.
const PARTY_CASES = [
  { picked: 'Acme Holdings (Pty) Ltd', hms: 'ACME HOLDINGS (PTY) LTD', kind: 'company', nativeId: '201', flagged: 'ACM1B' },
  { picked: 'Acme Holdings', hms: 'Acme Holdings (Pty) Ltd', kind: 'company', nativeId: '201', flagged: 'ACM1B' },
  { picked: 'ACME Holdings Pty Ltd', hms: 'ACME HOLDINGS (PTY) LTD', kind: 'company', nativeId: '201', flagged: 'ACM1B' },
  { picked: 'Acme Holdings Logistics (Pty) Ltd', hms: 'Acme Holdings Logistics', kind: 'company', nativeId: '211', flagged: 'ALH1B' },
  { picked: 'Acme', hms: 'Acme Trading', kind: 'company', nativeId: '203', flagged: 'ACM2B' },
  { picked: 'Bluebird Travel & Tours', hms: 'Bluebird Travel & Tours', kind: 'agency', nativeId: '204', flagged: 'BLU1B' },
  { picked: "O'Brien-Kent Pty. Ltd.", hms: "O'Brien-Kent (Pty) Ltd", kind: 'company', nativeId: '205', flagged: 'OBK1B' },
  { picked: 'Sigma  Trading   (Pty)  Ltd', hms: 'Sigma Trading (Pty) Ltd', kind: 'company', nativeId: '206', flagged: 'SIG1B' },
  { picked: 'Nordic Tours & Travel (Pty) Ltd.', hms: 'NORDIC TOURS & TRAVEL', kind: 'agency', nativeId: '207', flagged: 'NOR1B' },
  // HMS holds no negotiated row for these: public rates, with the no-contract reason.
  { picked: 'Zeta Mining (Pty) Ltd', hms: 'Zeta Mining (Pty) Ltd', kind: 'company', nativeId: '208', flagged: null },
  { picked: 'Quill Travel Services (Pty) Ltd', hms: 'Quill Travel Services', kind: 'agency', nativeId: '209', flagged: null },
  { picked: 'Helix Retail', hms: 'Helix Retail Holdings (Pty) Ltd', kind: 'company', nativeId: '210', flagged: null },
] as const;

describe('a picked party is matched by its HMS id, whatever its name looks like', () => {
  it.each(PARTY_CASES)(
    '"$picked" (HMS id $nativeId, named "$hms" there) prices $flagged, or says there is no contract',
    async (c) => {
      hmsDisplayName[c.nativeId] = c.hms;
      try {
        const parties =
          c.kind === 'company' ? { company: company(c.nativeId, c.picked) } : { agency: agency(c.nativeId, c.picked) };
        // The staff request names a room type, as a real quote does, so the room filter is in play for every case.
        const { revision, fellBack, note, sent } = await quoteWith(
          parties,
          c.flagged ? [BAR, flagged(c.flagged)] : [BAR],
          { roomCodes: ['SKNG'] },
        );
        // The party read names the party by its id, and asks HMS for every room type.
        const field = c.kind === 'company' ? 'organization' : 'agency';
        expect(sent[0]!.rateContext).toEqual({ [field]: { nativeId: c.nativeId, name: c.picked } });
        expect(sent[0]!.rooms[0].required).not.toHaveProperty('roomCodes');
        if (c.flagged) {
          expect(fellBack).toBe(false);
          expect(revision.groups[0]!.rateCode).toBe(c.flagged);
          expect(partyContractReviewNote(parties, revision.groups)).toBeNull();
        } else {
          expect(fellBack).toBe(true);
          expect(note).toBe(`No matching contract rate was found for ${c.picked} for at least one requested room; check the selected fallback rate in HMS.`);
          expect(revision.groups[0]!.rateCode).toBe('BARRO');
          expect(partyContractReviewNote(parties, revision.groups)).toBe(partyNoContractNote([c.picked]));
        }
      } finally {
        delete hmsDisplayName[c.nativeId];
      }
    },
  );
});

describe('a picked party is read once for every room type, and priced for the room the staff asked for', () => {
  // The rows one room type returned from the rate shop: a flagged row, a public row and a conditional row.
  const STQN_ROWS: Rate[] = [
    { code: 'BARRO', label: 'Room Only', rateScope: 'public', amounts: ['1750.00'], room: 'STQN' },
    { code: 'BCO1B', label: 'Woolworths Negotiated', rateScope: 'contextual', amounts: ['1520.00'], room: 'STQN' },
    { code: 'NCOR2B', label: 'Corporate Negotiated', rateScope: 'contextual', amounts: ['1600.00'], room: 'STQN' },
    { code: 'NCORRO', label: 'Corporate Conditional', rateScope: 'unknown', amounts: ['1400.00'], room: 'STQN' },
  ];
  const woolworths = { company: company('49', 'Woolworths') };
  const copy = 'No contract rate found for Woolworths; this quote uses our best available rate.';

  it('prices the cheapest flagged row for the requested room, read without a room-type filter, then names that room and rate', async () => {
    const { revision, fellBack, sent } = await quoteWith(woolworths, STQN_ROWS, { roomCodes: ['STQN'] });
    expect(fellBack).toBe(false);
    expect(revision.groups[0]!.rateCode).toBe('BCO1B');
    expect(partyContractReviewNote(woolworths, revision.groups)).toBeNull();
    // The summary read asks HMS for every room type, up to the Rate Shop's maximum, so the flagged rows come back.
    expect(sent[0]!.rateContext).toEqual({ organization: { nativeId: '49', name: 'Woolworths' } });
    expect(sent[0]!.rooms[0].required).not.toHaveProperty('roomCodes');
    expect(sent[0]!.maxOptionsPerGroup).toBe(200);
    // The detail read is for the requested room type and the chosen rate, under the party context.
    const detail = sent.find((request) => request.details === 'full');
    expect(detail?.rateContext).toEqual({ organization: { nativeId: '49', name: 'Woolworths' } });
    expect(detail?.rooms[0].required).toMatchObject({ roomCodes: ['STQN'], rateCodes: ['BCO1B'] });
  });

  it('a flagged row for another room type does not price the requested room: public, with the copy', async () => {
    const otherRoom: Rate[] = [
      { code: 'BARRO', label: 'Room Only', rateScope: 'public', amounts: ['1750.00'], room: 'STQN' },
      { code: 'BCO1B', label: 'Woolworths Negotiated', rateScope: 'contextual', amounts: ['1100.00'], room: 'DLXQN' },
    ];
    const { revision, fellBack, note } = await quoteWith(woolworths, otherRoom, { roomCodes: ['STQN'] });
    expect(fellBack).toBe(true);
    expect(note).toBe('No matching contract rate was found for Woolworths for at least one requested room; check the selected fallback rate in HMS.');
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(partyContractReviewNote(woolworths, revision.groups)).toBe(copy);
  });

  it('an incomplete read says HMS could not confirm, never that there is no contract, even when another room is flagged', async () => {
    const rates: Rate[] = [{ ...BAR, room: 'STQN' }, { ...flagged('BCO1B'), room: 'DLXQN' }];
    const { revision, fellBack, note } = await quoteWith(woolworths, rates, { roomCodes: ['STQN'], incompleteParty: true });
    expect(fellBack).toBe(true);
    expect(note).toBe(
      "Nava couldn't confirm contract rates for Woolworths; check the selected fallback rate in HMS before sending.",
    );
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
  });

  it('the requested rooms keep the list a room-filtered read returns, so a wider read never fails the quote by its size', async () => {
    // 30 room-only rows (the flagged one first) and 30 B&B alternatives for the requested rooms: 60 rows, more than one group
    // may carry. The list keeps its first 50, as HMS would for the room filter, and only alternatives are left out.
    const matches: Rate[] = [
      { ...flagged('BCO1B'), room: 'STQN' },
      ...Array.from({ length: 29 }, (_, i) => ({ ...BAR, code: `P${i}`, amounts: [`${700 + i}.00`], room: 'SKNG' })),
    ];
    const alternatives: Rate[] = Array.from({ length: 30 }, (_, i) => ({
      ...BAR,
      code: `B${i}`,
      board: 'breakfast' as const,
      amounts: [`${900 + i}.00`],
      room: 'STQN',
    }));
    const { revision, fellBack } = await quoteWith(woolworths, [...matches, ...alternatives], { roomCodes: ['STQN', 'SKNG'] });
    expect(fellBack).toBe(false);
    expect(revision.groups[0]!.rateCode).toBe('BCO1B');
  });

  it('a cut read falls back with the same honest copy, never as a hard failure, even when the requested room is flagged', async () => {
    const rates: Rate[] = [{ ...BAR, room: 'STQN' }, { ...flagged('BCO1B'), room: 'STQN' }];
    const { revision, fellBack, note } = await quoteWith(woolworths, rates, { roomCodes: ['STQN'], truncatedParty: true });
    expect(fellBack).toBe(true);
    expect(note).toBe(
      "Nava couldn't confirm contract rates for Woolworths; check the selected fallback rate in HMS before sending.",
    );
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
  });
});

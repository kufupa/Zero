import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeStaffQuote,
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
import { panePartyLookupLoaders, verifyPartyPick } from '../src/ai/pane-party-lookup.js';
import { suggestPartiesFor } from '../src/ai/party-aliases.js';

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
type Rate = { code: string; label: string; rateScope: 'public' | 'contextual' | 'unknown'; amounts: string[] };
const BAR: Rate = { code: 'BARRO', label: 'Room Only', rateScope: 'public', amounts: ['500.00'] };
const WOOLWORTHS_FLAGGED: Rate = { code: 'BCO1B', label: 'Woolworths Negotiated', rateScope: 'contextual', amounts: ['520.00'] };
const AGENCY_FLAGGED: Rate = { code: 'WSF2B', label: 'Agency Negotiated', rateScope: 'contextual', amounts: ['610.00'] };
// Named after the party but not flagged by HMS: it must never be offered as a contract, however cheap it is.
const NAME_ONLY: Rate = { code: 'NGD10B', label: 'Woolworths Corporate', rateScope: 'unknown', amounts: ['100.00'] };

function rateOption(rate: Rate, context: Record<string, unknown>) {
  const dates = occupiedDates(ARRIVAL, DEPARTURE);
  return {
    id: `SKNG:${rate.code}`,
    room: { code: 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
    rate: { code: rate.code, label: rate.label },
    board: 'Room Only R',
    appliedContext: context,
    rateScope: rate.rateScope,
    // Verified on purpose: the contract rule must hold by flag alone, not because some other check filtered the row.
    eligibility: 'verified',
    availability: 'available',
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
 * The rows one Rate Shop read returns, as fetch-quote.mjs marks them. Under a party context, a public row is accepted
 * only in an unfiltered read (no exact room or rate code, Preset or no strategy) with no flagged row in the read. Any
 * other row under the context is unresolved, which is how the runner rejects the capture.
 */
function rateShopRows(request: any, rates: Rate[], context: Record<string, unknown>) {
  const partyRequested = Object.keys(request.rateContext ?? {}).length > 0;
  const filtered = request.rooms.some((room: any) => room.required?.roomCodes?.length || room.required?.rateCodes?.length);
  const strategy = String(request.search?.salesStrategy ?? '').toUpperCase();
  const unfiltered = !filtered && (strategy === '' || strategy === 'PRESET');
  const noSpecialRates =
    partyRequested && unfiltered && rates.some((r) => r.rateScope === 'public') && rates.every((r) => r.rateScope !== 'contextual');
  return rates.map((rate) => ({
    ...rateOption(rate, context),
    eligibility: rate.rateScope === 'unknown' ? 'conditional' : 'verified',
    matchStatus:
      partyRequested && rate.rateScope !== 'contextual' && !(noSpecialRates && rate.rateScope === 'public')
        ? 'unresolved'
        : 'match',
  }));
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
  ],
  vat: 'included' as const,
  levy: 'included' as const,
};

function groupInput(parties?: StaffQuoteParties, text: { company?: string; agency?: string } = {}) {
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
      },
    ],
    ...text,
    ...(parties ? { parties } : {}),
  });
}

/** What HMS resolves each requested context to: the id and name the picker found. */
function resolvedContext(rateContext: Record<string, { nativeId: string; name: string }> | undefined) {
  return Object.fromEntries(
    Object.entries(rateContext ?? {}).map(([kind, ref]) => [kind, { id: ref.nativeId, name: ref.name }]),
  );
}

/** One quote through the staff path, with a Rate Shop read that offers the given rows under the requested context. */
async function quoteWith(
  parties: StaffQuoteParties | undefined,
  rates: Rate[],
  options: { header?: { company?: string; agency?: string }; readParty?: any } = {},
) {
  const confirmed = groupInput(parties, options.header);
  const prepared = prepareStaffQuote(confirmed, scope, signer, new AbortController().signal);
  const context = resolvedContext(prepared.request.rateContext);
  const sent: any[] = [];
  const services = createReservationistBusinessServices(
    {
      authorizationId: prepared.authorizationId,
      authorizeContext: async () => true,
      signer,
      readQuote: async (request: any) => {
        sent.push(request);
        const normalized = normalizer.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
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
              options: rateShopRows(request, rates, context),
            })),
          },
        };
      },
      resolvePolicy: async () => policy,
      ...(options.readParty ? { readParty: options.readParty } : {}),
    },
    prepared.approval,
  );
  const revision = await executeStaffQuote(prepared, services, async () => true);
  return { prepared, revision, sent };
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

  it('a verified party with only public rows quotes BAR in a clean read, and the review copy says so', async () => {
    const agency360 = { agency: agency('113', '360 degrees Travel') };
    const { revision, sent } = await quoteWith(agency360, [BAR]);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(partyContractReviewNote(agency360, revision.groups)).toBe(
      'No contract rate found for 360 degrees Travel; this quote uses our best available rate.',
    );
    // The summary read finds the public row. The full read keeps the party context and adds no exact code filter.
    expect(sent).toHaveLength(2);
    expect(sent[1].rateContext).toEqual({ agency: { nativeId: '113', name: '360 degrees Travel' } });
    expect(sent[1].rooms[0].required).not.toHaveProperty('roomCodes');
    expect(sent[1].rooms[0].required).not.toHaveProperty('rateCodes');
  });

  it('a verified party with a flagged row prices that contract row, not the public one', async () => {
    const agencyWoolworths = { agency: agency('569', 'Woolworths Agency') };
    const { revision } = await quoteWith(agencyWoolworths, [BAR, AGENCY_FLAGGED]);
    expect(revision.groups[0]!.rateCode).toBe('WSF2B');
    expect(partyContractReviewNote(agencyWoolworths, revision.groups)).toBeNull();
  });

  it('a plan named after the party is not offered as a contract unless HMS flags it', async () => {
    const { revision } = await quoteWith({ company: company('49', 'Woolworths') }, [NAME_ONLY, BAR]);
    expect(revision.groups[0]!.rateCode).toBe('BARRO');
    expect(revision.groups[0]!.rateCode).not.toBe('NGD10B');
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
  it('a sender alias carries its HMS id only where listed; body names never carry one', () => {
    const suggestions = suggestPartiesFor({
      sender: 'ops@mycwt.co.za',
      body: 'Travel Agency Details: RENNIES TRAVEL (PTY) LTD\nOrganization Details: Tourvest',
    });
    expect(suggestions).toEqual([
      { source: 'sender', kind: 'agency', name: 'CWT JNB', nativeId: '290', idStatus: 'listed' },
      { source: 'body', kind: 'agency', name: 'RENNIES TRAVEL (PTY) LTD', nativeId: null, idStatus: 'unverified' },
      { source: 'body', kind: 'company', name: 'Tourvest', nativeId: null, idStatus: 'unverified' },
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
    expect(outcome.note).toBe("HMS couldn't apply the contract rate for Woolworths, so these are public rates. Check in HMS.");
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

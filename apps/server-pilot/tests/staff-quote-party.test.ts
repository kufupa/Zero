import {
  executeStaffQuote,
  isPartyRateFailure,
  partyRateFallbackNote,
  prepareStaffQuote,
  quoteWithPartyFallback,
  staffQuoteInput,
} from '../src/ai/staff-quote-workflow.js';
import { createReservationistBusinessServices } from '../src/ai/reservationist-business-services.js';
import { occupiedDates } from '../src/quote-proposal/quote-revision.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scope = {
  transportId: 'transport',
  userId: 'staff',
  threadId: 'thread',
  messageId: 'message',
  sourceHash: 'a'.repeat(64),
  propertyCode: 'HRCEN',
  messageAt: '2026-09-30T12:00:00Z',
  messageText: 'Original email for a single room',
};
const signer = { signerName: 'Staff', signerEmail: 'staff@example.test' };
const ABC = 'ABC Travel (Pty) Ltd';

const baseInput = () => ({
  messageId: scope.messageId,
  sourceHash: scope.sourceHash,
  selectionEpoch: 3,
  inputRevision: 2,
  groups: [
    {
      id: 'single',
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      quantity: 2,
      adults: 1,
      childrenAges: [],
      board: 'room_only',
      roomCodes: ['SKNG'],
    },
  ],
});

const withParty = (kind: 'company' | 'agency' = 'company') =>
  staffQuoteInput.parse({
    ...baseInput(),
    company: kind === 'company' ? ABC : '',
    agency: kind === 'agency' ? ABC : '',
    party: { kind, nativeId: '4411', name: ABC },
  });

const prepare = (input: ReturnType<typeof staffQuoteInput.parse>, rates?: 'party' | 'public') =>
  rates
    ? prepareStaffQuote(input, scope, signer, new AbortController().signal, rates)
    : prepareStaffQuote(input, scope, signer, new AbortController().signal);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('staffQuoteInput party', () => {
  it('is optional, and accepts one picked company or agency with a plain native id', () => {
    expect(staffQuoteInput.parse(baseInput())).not.toHaveProperty('party');
    expect(withParty('agency').party).toEqual({ kind: 'agency', nativeId: '4411', name: ABC });
  });

  it('refuses a native id outside the plain id shape, an unknown kind, and any extra key in the party', () => {
    const bad = (party: unknown) => () => staffQuoteInput.parse({ ...baseInput(), party });
    expect(bad({ kind: 'company', nativeId: '44 11; drop', name: ABC })).toThrow();
    expect(bad({ kind: 'organization', nativeId: '4411', name: ABC })).toThrow();
    expect(bad({ kind: 'company', nativeId: '4411', name: '' })).toThrow();
    expect(bad({ kind: 'company', nativeId: '4411', name: ABC, extra: 1 })).toThrow();
  });
});

describe('prepareStaffQuote without a party', () => {
  it('sends exactly the request it sent before: no rateContext key, BAR, public rates', () => {
    const prepared = prepare(staffQuoteInput.parse(baseInput()));
    expect(prepared.request).toStrictEqual({
      propertyCode: 'HRCEN',
      arrivalDate: '2026-10-12',
      departureDate: '2026-10-15',
      requestedCurrency: 'ZAR',
      rooms: [
        {
          id: 'single',
          quantity: 2,
          adults: 1,
          children: 0,
          childAges: [],
          required: { boardBases: ['room_only'], roomCodes: ['SKNG'] },
        },
      ],
      search: { includeRestricted: false, includeAlternatives: false, salesStrategy: 'BAR' },
      details: 'full',
      maxOptionsPerGroup: 50,
    });
    expect(prepared.approval.rates).toBe('party');
  });

  it('keeps the input digest the same whether party is absent or the stay names none', () => {
    const plain = prepare(staffQuoteInput.parse(baseInput()));
    const again = prepare(staffQuoteInput.parse({ ...baseInput(), party: undefined }));
    expect(again.inputDigest).toBe(plain.inputDigest);
  });
});

describe('prepareStaffQuote with a picked party', () => {
  it('sends the company as the organization rate context and the agency as the agency rate context', () => {
    expect(prepare(withParty('company')).request.rateContext).toStrictEqual({
      organization: { nativeId: '4411', name: ABC },
    });
    expect(prepare(withParty('agency')).request.rateContext).toStrictEqual({
      agency: { nativeId: '4411', name: ABC },
    });
  });

  it('sends no rate context with QUOTE_RATE_CONTEXT=off, so the request is the public one', () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    const prepared = prepare(withParty('company'));
    expect(prepared.request).not.toHaveProperty('rateContext');
    expect(prepared.request.search.salesStrategy).toBe('BAR');
  });

  it('sends no rate context on the public-rate retry, and marks the approval public', () => {
    const prepared = prepare(withParty('company'), 'public');
    expect(prepared.request).not.toHaveProperty('rateContext');
    expect(prepared.approval.rates).toBe('public');
    expect(prepared.inputDigest).toBe(prepare(withParty('company')).inputDigest);
  });
});

describe('executeStaffQuote with a picked party', () => {
  // A native reader that prices the stay only when the request carries the company's rate context, as HMS does.
  function nativeReader(calls: any[]) {
    return async (request: any) => {
      calls.push(structuredClone(request));
      const normalize = await import('../tooling/playwright-quote/quote-contract.mjs' as string);
      const normalized = normalize.normalizeQuoteRequest({ schemaVersion: 2, ...request }).request;
      const applied = request.rateContext?.organization
        ? { organization: { id: '4411', name: ABC } }
        : {};
      return {
        ref: 'source:' + calls.length,
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
            options: [
              {
                id: 'option',
                room: { code: 'SKNG', label: 'Standard King', buildingCode: 'MAIN' },
                rate: { code: 'BARRO', label: 'Room Only' },
                board: 'Room Only R',
                appliedContext: applied,
                eligibility: 'verified',
                availability: 'available',
                matchStatus: 'match',
                held: false,
                totals: { taxInclusive: true },
                nightly: occupiedDates(normalized.arrivalDate, normalized.departureDate).map(
                  (date, i) => ({
                    date,
                    inventory: 8,
                    price: {
                      amount: ['100.01', '500.00', '500.00'][i] ?? '500.00',
                      currency: 'ZAR',
                    },
                  }),
                ),
              },
            ],
          })),
        },
      };
    };
  }

  const optionsFor = (prepared: ReturnType<typeof prepare>, calls: any[]) => ({
    authorizationId: prepared.authorizationId,
    authorizeContext: async () => true,
    signer,
    readQuote: nativeReader(calls),
    resolvePolicy: async () => ({
      ref: 'policy',
      propertyCode: 'HRCEN',
      sourceHashes: ['c'.repeat(64)],
      authoredDates: ['2026-09-08'],
      families: [{ rateCode: 'BARRO', board: 'room_only' as const }],
      vat: 'included' as const,
      levy: 'included' as const,
    }),
  });

  it('quotes the picked party by its native id without a name lookup, and prices it at the party rate', async () => {
    const prepared = prepare(withParty('company'));
    const calls: any[] = [];
    const readParty = vi.fn(async () => {
      throw new Error('name lookup must not run for a picked party');
    });
    const services = createReservationistBusinessServices(
      { ...optionsFor(prepared, calls), readParty },
      prepared.approval,
    );
    const revision = await executeStaffQuote(prepared, services, async () => true);
    expect(readParty).not.toHaveBeenCalled();
    expect(calls[0].rateContext).toStrictEqual({ organization: { nativeId: '4411', name: ABC } });
    expect(calls[0].search.salesStrategy).toBe('Preset');
    expect(revision.totalMinor).toBe(220002);
  });

  it('a public-rate retry looks up no party, even though the header names one, and quotes at BAR', async () => {
    const prepared = prepare(withParty('company'), 'public');
    const calls: any[] = [];
    const services = createReservationistBusinessServices(
      optionsFor(prepared, calls),
      prepared.approval,
    );
    await executeStaffQuote(prepared, services, async () => true);
    expect(calls[0]).not.toHaveProperty('rateContext');
    expect(calls[0].search.salesStrategy).toBe('BAR');
  });
});

describe('party rate fallback', () => {
  it('treats only party and unpriced-party failures as a reason to quote at public rates', () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    for (const code of [
      'business_party_identity_unavailable',
      'business_party_lookup_unavailable',
      'business_selected_price_unavailable',
      'staff_quote_party_unavailable',
    ]) {
      expect(isPartyRateFailure(coded(code))).toBe(true);
    }
    for (const code of [
      'business_quote_source_expired',
      'staff_quote_source_changed',
      'business_context_unauthorized',
    ]) {
      expect(isPartyRateFailure(coded(code))).toBe(false);
    }
    expect(isPartyRateFailure(new Error('no code'))).toBe(false);
  });

  it('says in plain English which party could not be applied, and that the rates are public', () => {
    expect(partyRateFallbackNote(ABC)).toBe(
      "HMS couldn't apply ABC Travel (Pty) Ltd's rate, so these are public rates. Check in HMS.",
    );
  });
});

describe('quoteWithPartyFallback', () => {
  // HMS prices only a request that carries the party's rate context. Any other request gets public rates.
  const priced = (attempt: ReturnType<typeof prepare>, code: string) => {
    if (attempt.request.rateContext) throw Object.assign(new Error(code), { code });
    return 'public-revision';
  };

  it('quotes the picked party once and gives no note when HMS prices it', async () => {
    const first = prepare(withParty('company'));
    const run = vi.fn(async () => 'party-revision');
    const out = await quoteWithPartyFallback({
      input: withParty('company'),
      first,
      retry: () => prepare(withParty('company'), 'public'),
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ prepared: first, result: 'party-revision', note: null });
  });

  it('retries once at public rates when HMS cannot price the picked party, and says so in the note', async () => {
    const first = prepare(withParty('company'));
    const run = vi.fn(async (attempt: ReturnType<typeof prepare>) =>
      priced(attempt, 'business_selected_price_unavailable'),
    );
    const out = await quoteWithPartyFallback({
      input: withParty('company'),
      first,
      retry: () => prepare(withParty('company'), 'public'),
      run,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(out.result).toBe('public-revision');
    expect(out.prepared.request).not.toHaveProperty('rateContext');
    expect(out.note).toBe(partyRateFallbackNote(ABC));
  });

  it('fails as before when no party was picked, even for a party-shaped code', async () => {
    const plain = staffQuoteInput.parse(baseInput());
    const retry = vi.fn(() => prepare(plain, 'public'));
    const run = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'business_selected_price_unavailable' });
    });
    await expect(
      quoteWithPartyFallback({ input: plain, first: prepare(plain), retry, run }),
    ).rejects.toMatchObject({ code: 'business_selected_price_unavailable' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('fails with the original error for a picked party when the failure is not about the party', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'business_quote_source_expired' });
    });
    await expect(
      quoteWithPartyFallback({
        input: withParty('agency'),
        first: prepare(withParty('agency')),
        retry: () => prepare(withParty('agency'), 'public'),
        run,
      }),
    ).rejects.toMatchObject({ code: 'business_quote_source_expired' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

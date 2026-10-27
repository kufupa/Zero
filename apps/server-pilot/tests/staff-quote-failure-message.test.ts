import { describe, expect, it } from 'vitest';
import { isReservationistCleanNoMatch } from '../src/ai/reservationist-evaluation-composition.js';
import type { QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';
import { ReservationistTaskEvidenceUnavailable } from '../src/ai/reservationist-execution.js';
import {
  staffQuoteFailureLog,
  staffQuoteFailureMessage,
} from '../src/trpc/routes/workstation.js';
import { unverifiedContextualRatesNeedAgency } from '../src/ai/reservationist-evaluation-composition.js';

const HMS_RETRY =
  "HMS didn't respond as expected. Try again; if it fails twice, quote in HMS directly.";
const GENERIC =
  'The requested allocation or rate could not be qualified; review stay inputs and party/rate evidence';
const COMBINATION =
  "HMS couldn't price this exact combination of rooms, guests and meals. Try one room type or B&B first, or quote this one in HMS.";

function coded(code: string, phase?: string): Error {
  return Object.assign(new Error(code), { code, ...(phase ? { phase } : {}) });
}

describe('staffQuoteFailureMessage', () => {
  it('gives plain copy for a party rate HMS could not verify, never the generic allocation message', () => {
    expect(staffQuoteFailureMessage(coded('staff_quote_party_invalid'))).toBe(
      "Nava couldn't verify the company or agency rate from HMS. Try again, or quote at public rates.",
    );
    expect(staffQuoteFailureMessage(coded('staff_quote_party_changed'))).toBe(
      'The HMS company or agency result changed while Nava read it. Try again.',
    );
  });

  it('maps execution and browser failures to the HMS retry message', () => {
    expect(staffQuoteFailureMessage(coded('EXECUTION_FAILURE', 'hotel_availability'))).toBe(
      HMS_RETRY,
    );
    expect(staffQuoteFailureMessage(coded('EXECUTION_FAILURE', 'login'))).toBe(HMS_RETRY);
    expect(staffQuoteFailureMessage(new Error('staff_quote_native_unavailable'))).toBe(HMS_RETRY);
    const timeout = new Error('locator.click: Timeout 3000ms exceeded.');
    timeout.name = 'TimeoutError';
    expect(staffQuoteFailureMessage(timeout)).toBe(HMS_RETRY);
  });

  it('keeps the existing business-code messages', () => {
    expect(staffQuoteFailureMessage(coded('business_quote_policy_unavailable'))).toBe(
      'Verify VAT and tourism levy inclusion for the selected rate.',
    );
    expect(staffQuoteFailureMessage(coded('staff_quote_source_changed'))).toBe(
      'The selected email or approved inputs changed; rerun the current quote.',
    );
  });

  it('maps native capture scope and completeness failures to the plain combination message', () => {
    expect(
      staffQuoteFailureMessage(new Error('native_quote_capture_scope_or_completeness_invalid')),
    ).toBe(COMBINATION);
    expect(staffQuoteFailureMessage(new Error('native_quote_capture_oversized'))).toBe(COMBINATION);
  });

  it('tells staff to confirm the agency when wholesale rows stayed conditional because no party was requested', () => {
    expect(staffQuoteFailureMessage(new Error('native_quote_party_context_required'))).toBe(
      'Wholesale/contract rates need the agency confirmed. Pick the agency in step 1, then Get rates.',
    );
  });
});

describe('unverifiedContextualRatesNeedAgency', () => {
  const row = (rateScope: string, eligibility: string) => ({ rateScope, eligibility });
  const capture = (options: { rateScope: string; eligibility: string }[]) => ({
    groups: [{ completeness: { search: 'complete' }, issues: [], options }],
  });

  it('is true only when every row is contextual and conditional and no rateContext was requested', () => {
    expect(
      unverifiedContextualRatesNeedAgency(capture([row('contextual', 'conditional')]), {}),
    ).toBe(true);
    expect(
      unverifiedContextualRatesNeedAgency(capture([row('contextual', 'conditional')]), {
        rateContext: undefined,
      }),
    ).toBe(true);
  });

  it('is false when a party was requested, a row is public or verified, or there are no rows', () => {
    expect(
      unverifiedContextualRatesNeedAgency(capture([row('contextual', 'conditional')]), {
        rateContext: { agency: { nativeId: '838' } },
      }),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(capture([row('public', 'conditional')]), {}),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(capture([row('contextual', 'verified')]), {}),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        capture([row('contextual', 'conditional'), row('public', 'verified')]),
        {},
      ),
    ).toBe(false);
    expect(unverifiedContextualRatesNeedAgency({ groups: [{ options: [] }] }, {})).toBe(false);
    expect(unverifiedContextualRatesNeedAgency({ groups: [] }, {})).toBe(false);
  });

  it('is false unless every group search is complete with no coverage issues', () => {
    const rows = [row('contextual', 'conditional')];
    expect(unverifiedContextualRatesNeedAgency({ groups: [{ options: rows }] }, {})).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          groups: [
            { completeness: { search: 'complete' }, issues: [], options: rows },
            { options: rows },
          ],
        },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          groups: [
            {
              completeness: { search: 'complete' },
              issues: [{ code: 'STALE_CALENDAR_PAGE' }],
              options: rows,
            },
          ],
        },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          groups: [
            {
              completeness: { search: 'complete' },
              issues: [{ code: 'NOT_A_COVERAGE_CODE' }],
              options: rows,
            },
          ],
        },
        {},
      ),
    ).toBe(true);
  });

  it('is false when the search is incomplete or carries search issues', () => {
    const rows = [row('contextual', 'conditional')];
    const covered = { completeness: { search: 'complete' as const }, issues: [] as { code: string }[] };
    expect(
      unverifiedContextualRatesNeedAgency(
        { searchCompleteness: { status: 'partial' }, groups: [{ ...covered, options: rows }] },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          searchCompleteness: { status: 'complete' },
          issues: [{ code: 'OPTION_LIMIT' }],
          groups: [{ ...covered, options: rows }],
        },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          searchCompleteness: { status: 'complete' },
          issues: [],
          groups: [{ completeness: { search: 'complete' }, issues: [{ code: 'OPTION_LIMIT' }], options: rows }],
        },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          searchCompleteness: { status: 'complete' },
          issues: [],
          groups: [{ completeness: { search: 'truncated' }, options: rows }],
        },
        {},
      ),
    ).toBe(false);
    expect(
      unverifiedContextualRatesNeedAgency(
        {
          searchCompleteness: { status: 'complete' },
          issues: [],
          groups: [{ ...covered, options: rows }],
        },
        {},
      ),
    ).toBe(true);
  });
});

describe('staffQuoteFailureMessage no-match and native capture copy', () => {
  it('names the strategy and the dinner fallback for a clean HMS no-match on dinner', () => {
    expect(
      staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'), {
        salesStrategy: 'BAR',
        dinnerRequested: true,
      }),
    ).toBe(
      'HMS has no rate for this meal plan under BAR. Nava retries dinner requests on Bed & Breakfast with a separate dinner add-on. If no B&B rate is available, choose an available room option below or check the Government rate only if the guest is entitled.',
    );
    expect(
      staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'), {
        salesStrategy: 'Government',
        dinnerRequested: true,
      }),
    ).toBe(
      'HMS has no rate for this meal plan under Government. Nava retries dinner requests on Bed & Breakfast with a separate dinner add-on. If no B&B rate is available, choose an available room option below or check the Government rate only if the guest is entitled.',
    );
  });

  it('keeps the no-match message free of the dinner fallback when dinner was not requested', () => {
    const message = staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'), {
      salesStrategy: 'BAR',
      dinnerRequested: false,
    });
    expect(message).toBe(
      'HMS has no rate for this meal plan under BAR. Try another meal plan or rate type.',
    );
    expect(message).not.toContain('dinner allowance');
    expect(staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'))).toBe(
      'HMS has no rate for this meal plan under the selected rate type. Try another meal plan or rate type.',
    );
  });

  it('keeps the PR #40 HMS retry message for native capture unavailable', () => {
    expect(staffQuoteFailureMessage(new Error('native_quote_capture_unavailable'))).toBe(HMS_RETRY);
  });

  it('falls back to the generic message for unrecognised codes', () => {
    expect(staffQuoteFailureMessage(new Error('native_quote_owner_scope_mismatch'))).toBe(GENERIC);
    expect(staffQuoteFailureMessage(new Error('toString'))).toBe(GENERIC);
  });
});

describe('the short room type copy', () => {
  it('names the room type, the night and what is free, so staff quote fewer or split', () => {
    const error = new ReservationistTaskEvidenceUnavailable('native_quote_insufficient_inventory', ['room inventory'], undefined, {
      shortfall: { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2026-10-26', demand: 40, supply: 34 },
    });
    expect(staffQuoteFailureMessage(error)).toBe('Only 34 Standard Queen free on 26 Oct — quote fewer or split');
  });

  it('falls back to the availability copy when the shortfall is missing or has no usable date', () => {
    const availability = 'Verify combined availability for the requested rooms and dates.';
    expect(staffQuoteFailureMessage(new Error('native_quote_insufficient_inventory'))).toBe(availability);
    const malformed = new ReservationistTaskEvidenceUnavailable('native_quote_insufficient_inventory', ['room inventory'], undefined, {
      shortfall: { roomLabel: 'Standard Queen', date: '26 Oct', supply: 34 },
    });
    expect(staffQuoteFailureMessage(malformed)).toBe(availability);
  });
});

describe('staffQuoteFailureLog', () => {
  it('logs only the code and phase, never the free-text message', () => {
    const error = Object.assign(new Error('Guest Jane Doe room 12 at https://pms.example'), {
      code: 'EXECUTION_FAILURE',
      phase: 'hotel_availability',
    });
    expect(staffQuoteFailureLog(error)).toEqual({
      code: 'EXECUTION_FAILURE',
      phase: 'hotel_availability',
    });
    expect(staffQuoteFailureLog(new Error('Guest Jane Doe'))).toEqual({
      code: 'unknown',
      phase: 'unknown',
    });
  });

  it('logs a sanitized attach-phase name and message, never URLs or guest copy', () => {
    const error = Object.assign(new Error('EXECUTION_FAILURE'), {
      code: 'EXECUTION_FAILURE',
      phase: 'attach',
      errorName: 'TimeoutError',
      errorMessage: 'browserType.connectOverCDP: Timeout 20000ms exceeded. ws://127.0.0.1:19223/devtools/browser/x user:pass',
    });
    expect(staffQuoteFailureLog(error)).toEqual({
      code: 'EXECUTION_FAILURE',
      phase: 'attach',
      errorName: 'TimeoutError',
      errorMessage: expect.stringMatching(/Timeout 20000ms exceeded/),
    });
    expect(staffQuoteFailureLog(error).errorMessage).not.toMatch(/ws:|http:|user:pass|127\.0\.0\.1/);
    const guest = Object.assign(new Error('Guest Jane Doe room 12 at https://pms.example'), {
      code: 'EXECUTION_FAILURE',
      phase: 'attach',
    });
    expect(staffQuoteFailureLog(guest)).toEqual({
      code: 'EXECUTION_FAILURE',
      phase: 'attach',
    });
  });
});

describe('isReservationistCleanNoMatch', () => {
  const room = {
    id: 'g1',
    quantity: 1,
    adults: 2,
    children: 0,
    childAges: [],
    required: { boardBases: ['dinner_bed_breakfast'] },
  };
  const request = {
    propertyCode: 'CEN',
    arrivalDate: '2026-11-01',
    departureDate: '2026-11-03',
    requestedCurrency: 'ZAR',
    rooms: [room],
    search: { includeRestricted: false, includeAlternatives: false, salesStrategy: 'BAR' },
    details: 'full',
    maxOptionsPerGroup: 50,
  } as unknown as QuoteSourceRecord['request'];
  const capture = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    outcome: 'no_match',
    propertyCode: 'CEN',
    observedAt: '2026-11-01T00:00:00.000Z',
    requested: request,
    audit: { status: 'complete' },
    searchCompleteness: { status: 'complete' },
    issues: [],
    allocation: { status: 'not_selected' },
    groups: [
      {
        id: 'g1',
        outcome: 'no_match',
        request: room,
        completeness: { search: 'complete', requiredFacts: 'complete' },
        issues: [],
        options: [],
      },
    ],
    ...overrides,
  });

  it('admits only an audited complete no-match bound to the exact request', () => {
    expect(isReservationistCleanNoMatch(capture(), request)).toBe(true);
    expect(isReservationistCleanNoMatch(capture({ outcome: 'partial' }), request)).toBe(false);
    expect(isReservationistCleanNoMatch(capture({ audit: { status: 'incomplete' } }), request)).toBe(
      false,
    );
    expect(isReservationistCleanNoMatch(capture({ issues: [{ code: 'x' }] }), request)).toBe(false);
    expect(isReservationistCleanNoMatch(capture({ groups: [] }), request)).toBe(false);
    expect(
      isReservationistCleanNoMatch(
        capture({ groups: [{ ...capture().groups[0], outcome: 'quote' }] }),
        request,
      ),
    ).toBe(false);
    expect(
      isReservationistCleanNoMatch(
        capture({ requested: { ...request, arrivalDate: '2026-11-02' } }),
        request,
      ),
    ).toBe(false);
    expect(isReservationistCleanNoMatch(null, request)).toBe(false);
  });
});

describe('the restricted night copy', () => {
  it('names the night and each room type HMS restricts on it, so staff choose other dates or quote in HMS', () => {
    const error = new ReservationistTaskEvidenceUnavailable('native_quote_restricted_nights', ['room sale on the restricted nights'], undefined, {
      restrictedNights: [
        { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2027-11-18' },
        { roomCode: 'STWN', roomLabel: 'Standard Twin', date: '2027-11-18' },
      ],
    });
    expect(staffQuoteFailureMessage(error)).toBe(
      'HMS restricts sale on 18 Nov 2027 for Standard Queen and Standard Twin. Choose other dates or quote this in HMS.',
    );
  });

  it('gives each night its own room types, and falls back to plain copy when the detail is missing or malformed', () => {
    const mixed = new ReservationistTaskEvidenceUnavailable('native_quote_restricted_nights', ['room sale on the restricted nights'], undefined, {
      restrictedNights: [
        { roomCode: 'STQN', roomLabel: 'Standard Queen', date: '2027-11-17' },
        { roomCode: 'STWN', roomLabel: 'Standard Twin', date: '2027-11-18' },
      ],
    });
    expect(staffQuoteFailureMessage(mixed)).toBe(
      'HMS restricts sale on 17 Nov 2027 for Standard Queen; 18 Nov 2027 for Standard Twin. Choose other dates or quote this in HMS.',
    );
    const plain = 'HMS restricts sale on some of these nights. Choose other dates or quote this in HMS.';
    expect(staffQuoteFailureMessage(new Error('native_quote_restricted_nights'))).toBe(plain);
    const malformed = new ReservationistTaskEvidenceUnavailable('native_quote_restricted_nights', ['room sale on the restricted nights'], undefined, {
      restrictedNights: [{ roomLabel: 'Standard Queen', date: '18 Nov' }],
    });
    expect(staffQuoteFailureMessage(malformed)).toBe(plain);
  });
});

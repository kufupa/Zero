import { describe, expect, it } from 'vitest';
import { isReservationistCleanNoMatch } from '../src/ai/reservationist-evaluation-composition.js';
import type { QuoteSourceRecord } from '../src/quote-proposal/quote-revision.js';
import {
  staffQuoteFailureLog,
  staffQuoteFailureMessage,
} from '../src/trpc/routes/workstation.js';

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

  it('names the strategy and the dinner fallback for a clean HMS no-match on dinner', () => {
    expect(
      staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'), {
        salesStrategy: 'BAR',
        dinnerRequested: true,
      }),
    ).toBe(
      'HMS has no rate for this meal plan under BAR. For dinner, quote Bed & Breakfast and add a dinner allowance (button below), or use the Government rate if the guest is entitled.',
    );
    expect(
      staffQuoteFailureMessage(new Error('native_quote_no_matching_rate'), {
        salesStrategy: 'Government',
        dinnerRequested: true,
      }),
    ).toBe(
      'HMS has no rate for this meal plan under Government. For dinner, quote Bed & Breakfast and add a dinner allowance (button below), or use the Government rate if the guest is entitled.',
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

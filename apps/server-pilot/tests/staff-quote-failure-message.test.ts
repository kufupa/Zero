import { describe, expect, it } from 'vitest';
import {
  staffQuoteFailureLog,
  staffQuoteFailureMessage,
} from '../src/trpc/routes/workstation.js';

const HMS_RETRY =
  "HMS didn't respond as expected. Try again; if it fails twice, quote in HMS directly.";
const GENERIC =
  'The requested allocation or rate could not be qualified; review stay inputs and party/rate evidence';

function coded(code: string, phase?: string): Error {
  return Object.assign(new Error(code), { code, ...(phase ? { phase } : {}) });
}

describe('staffQuoteFailureMessage', () => {
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

  it('falls back to the generic message for unrecognised codes', () => {
    expect(staffQuoteFailureMessage(new Error('native_quote_capture_scope_or_completeness_invalid'))).toBe(
      GENERIC,
    );
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

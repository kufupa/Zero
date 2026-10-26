import { afterEach, describe, expect, it } from 'vitest';
import {
  HMS_OUTAGE_FAILURE_CLASS,
  HMS_OUTAGE_MAX_MS,
  HMS_OUTAGE_PROBE_MS,
  HMS_OUTAGE_STAFF_COPY,
  classifyHmsLoginOutage,
  clearPropertyOutage,
  decidePropertyReadJob,
  noteLoginOutage,
  resetPropertyOutageMarkersForTests,
} from '../src/hms/property-outage.js';

const NOW = 1_700_000_000_000;
const HOTEL_A = 'PROP_A';
const HOTEL_B = 'PROP_B';

function loginPhaseFailure(phase: 'attach' | 'login'): Error {
  return Object.assign(new Error('EXECUTION_FAILURE'), {
    code: 'EXECUTION_FAILURE',
    phase,
    errorMessage: 'AUTHENTICATED_SHELL_TIMEOUT',
  });
}

afterEach(() => {
  resetPropertyOutageMarkersForTests();
});

describe('property HMS outage pause', () => {
  it('classifies login-phase failures as outage and leaves mid-session and unknown codes closed', () => {
    expect(classifyHmsLoginOutage(loginPhaseFailure('attach'))).toBe(true);
    expect(classifyHmsLoginOutage(loginPhaseFailure('login'))).toBe(true);
    expect(
      classifyHmsLoginOutage(
        Object.assign(new Error('AUTHENTICATED_SHELL_TIMEOUT'), {
          code: 'AUTHENTICATED_SHELL_TIMEOUT',
        }),
      ),
    ).toBe(true);
    expect(
      classifyHmsLoginOutage({
        code: 'EXECUTION_FAILURE',
        phase: 'hotel_availability',
      }),
    ).toBe(false);
    expect(
      classifyHmsLoginOutage({
        outcome: 'execution_failure',
        error: 'AUTHENTICATED_SHELL_TIMEOUT',
      }),
    ).toBe(true);
    expect(
      classifyHmsLoginOutage({
        outcome: 'execution_failure',
        reason: 'AUTHENTICATED_SHELL_TIMEOUT',
      }),
    ).toBe(true);
    expect(classifyHmsLoginOutage(new Error('ECONNRESET'))).toBe(false);
    expect(classifyHmsLoginOutage({ code: 'EXECUTION_FAILURE' })).toBe(false);
    expect(HMS_OUTAGE_FAILURE_CLASS).toBe('HMS_OUTAGE');
    expect(HMS_OUTAGE_STAFF_COPY).toBe(
      "HMS is down right now (often planned maintenance). Nava will finish this automatically when it's back.",
    );
  });

  it('parks the next job for the outage property without burning attempts', () => {
    expect(classifyHmsLoginOutage(loginPhaseFailure('attach'))).toBe(true);
    const attempts = 2;
    const parked = noteLoginOutage(HOTEL_A, NOW);
    expect(parked).toEqual({ kind: 'park', delayMs: HMS_OUTAGE_PROBE_MS });
    const next = decidePropertyReadJob(HOTEL_A, NOW + 1_000);
    expect(next).toEqual({ kind: 'park', delayMs: expect.any(Number) });
    if (next.kind === 'park') {
      expect(next.delayMs).toBeGreaterThan(0);
      expect(next.delayMs).toBeLessThanOrEqual(HMS_OUTAGE_PROBE_MS);
    }
    expect(attempts).toBe(2);
    expect(decidePropertyReadJob(HOTEL_A, NOW + HMS_OUTAGE_PROBE_MS)).toEqual({ kind: 'proceed' });
    expect(decidePropertyReadJob(HOTEL_A, NOW + HMS_OUTAGE_PROBE_MS + 1).kind).toBe('park');
  });

  it('leaves a second property free to run while the first is parked', () => {
    noteLoginOutage(HOTEL_A, NOW);
    expect(decidePropertyReadJob(HOTEL_A, NOW + 1_000).kind).toBe('park');
    expect(decidePropertyReadJob(HOTEL_B, NOW + 1_000)).toEqual({ kind: 'proceed' });
    expect(noteLoginOutage('', NOW).kind).toBe('fallback');
    expect(noteLoginOutage(null, NOW).kind).toBe('fallback');
    expect(decidePropertyReadJob(undefined, NOW)).toEqual({ kind: 'proceed' });
  });

  it('clears the marker on the first success so later jobs run', () => {
    noteLoginOutage(HOTEL_A, NOW);
    expect(decidePropertyReadJob(HOTEL_A, NOW + 1_000).kind).toBe('park');
    clearPropertyOutage(HOTEL_A);
    expect(decidePropertyReadJob(HOTEL_A, NOW + 2_000)).toEqual({ kind: 'proceed' });
  });

  it('falls back after 12 h instead of parking forever', () => {
    noteLoginOutage(HOTEL_A, NOW);
    const expiredAt = NOW + HMS_OUTAGE_MAX_MS + 1;
    expect(decidePropertyReadJob(HOTEL_A, expiredAt)).toEqual({ kind: 'expired' });
    expect(noteLoginOutage(HOTEL_A, expiredAt)).toEqual({ kind: 'fallback' });
  });
});

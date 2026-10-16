/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readTreatAs, rememberTreatAs } from '../lib/quote-workflow/treat-as-cache';

afterEach(() => {
  sessionStorage.clear();
});

describe('treat-as cache', () => {
  it('remembers a Treat-as choice per mail and returns it after a reset', () => {
    expect(readTreatAs('mail-a')).toBeNull();
    rememberTreatAs('mail-a', 'quote');
    rememberTreatAs('mail-b', 'create_booking');
    expect(readTreatAs('mail-a')).toBe('quote');
    expect(readTreatAs('mail-b')).toBe('create_booking');
  });
});

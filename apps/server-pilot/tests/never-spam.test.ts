import { describe, expect, it } from 'vitest';
import { isAutoTriageNeverSpam } from '../src/ai/never-spam.js';

describe('never-spam allowlist', () => {
  it('matches legacyhotels.co.za domain case-insensitively', () => {
    expect(isAutoTriageNeverSpam('Martha <marthamthembu@LegacyHotels.co.za>')).toBe(true);
  });

  it('matches aroransh17 and coleddofficial', () => {
    expect(isAutoTriageNeverSpam('aroransh17@gmail.com')).toBe(true);
    expect(isAutoTriageNeverSpam('Cole <coleddofficial@gmail.com>')).toBe(true);
  });

  it('does not match unrelated gmail', () => {
    expect(isAutoTriageNeverSpam('spam@gmail.com')).toBe(false);
  });

  it('matches only the exact ReserveCloud sender address', () => {
    expect(isAutoTriageNeverSpam('pmbobo@eu.mail.reservecloud.com')).toBe(true);
    expect(isAutoTriageNeverSpam('noreply@noreply.reservecloud.com')).toBe(false);
    expect(isAutoTriageNeverSpam('other@eu.mail.reservecloud.com')).toBe(false);
    expect(isAutoTriageNeverSpam('jvermaak@legacyhotels.co.za')).toBe(true);
  });
});

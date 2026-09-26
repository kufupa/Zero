import { describe, expect, it } from 'vitest';
import { channelDigestRowOk } from '../src/hms/channel-digest-honesty.js';

describe('channelDigestRowOk', () => {
  it('rejects envelope ok with all field checkers false', () => {
    expect(
      channelDigestRowOk({
        ok: true,
        fields: { guestName: false, confirmation: false, arrival: false, departure: false },
      }),
    ).toBe(false);
  });

  it('accepts ok when at least one required field is true', () => {
    expect(
      channelDigestRowOk({
        ok: true,
        fields: { guestName: false, confirmation: true, arrival: false, departure: false },
      }),
    ).toBe(true);
  });
});

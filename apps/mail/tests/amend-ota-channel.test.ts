import { describe, expect, it } from 'vitest';
import { otaBookingChannel } from '../lib/quote-workflow/ota-channel';

describe('otaBookingChannel', () => {
  it('identifies a platform from an exact or subdomain sender address', () => {
    expect(otaBookingChannel({ senderEmail: 'confirmation@booking.com' })).toBe('Booking.com');
    expect(otaBookingChannel({ senderEmail: 'noreply@messages.expedia.com' })).toBe('Expedia');
  });

  it('identifies the platform from the subject or body when the sender is a property', () => {
    expect(
      otaBookingChannel({
        senderEmail: 'reservations@guest.example',
        subject: 'Expedia booking confirmation',
      }),
    ).toBe('Expedia');
    expect(
      otaBookingChannel({
        senderEmail: 'reservations@guest.example',
        bodyText: 'This reservation was made through Agoda.',
      }),
    ).toBe('Agoda');
  });

  it('does not infer an OTA from ordinary direct-booking mail', () => {
    expect(
      otaBookingChannel({
        senderEmail: 'guest@example.com',
        subject: 'Booking request',
        bodyText: 'Please reserve a room directly with the hotel.',
      }),
    ).toBeNull();
  });

  it.each([
    ['notice@m.expediapartnercentral.com', 'Expedia Partner Central'],
    ['booking@webbeds.com', 'WebBeds'],
    ['booking@hotelbeds.com', 'Hotelbeds'],
    ['booking@get-e.com', 'Get-e'],
  ])('uses shared source rule for %s', (senderEmail, source) => {
    expect(otaBookingChannel({ senderEmail })).toBe(source);
  });
});

describe('otaBookingChannel false positives', () => {
  it('ignores a guest who only mentions an OTA or a look-alike domain', () => {
    expect(otaBookingChannel({ senderEmail: 'guest@example.test', bodyText: 'I saw your rate on Booking.com, can you match it?' })).toBeNull();
    expect(otaBookingChannel({ senderEmail: 'guest@example.test', bodyText: 'We found you on Airbnb and Expedia.' })).toBeNull();
    expect(otaBookingChannel({ senderEmail: 'guest@example.test', bodyText: 'See safari-hotels.com and africa-trip.com' })).toBeNull();
  });

  it('labels a channel phrase and prefers the sender domain', () => {
    expect(otaBookingChannel({ senderEmail: 'guest@example.test', bodyText: 'This was booked via Booking.com.' })).toBe('Booking.com');
    expect(otaBookingChannel({ senderEmail: 'guest@example.test', bodyText: 'Expedia reservation number: 123' })).toBe('Expedia');
    expect(otaBookingChannel({ senderEmail: 'noreply@expedia.com', bodyText: 'Booking.com' })).toBe('Expedia');
  });
});

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
});

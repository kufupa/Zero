import { describe, expect, it } from 'vitest';
import { classifyMailSource } from '../src/ai/mail-source.js';
import { mailSourceTriageOutput } from '../src/ai/triage.js';

const channelExamples = [
  {
    name: 'SynXis confirmation sender',
    input: {
      fromAddress: 'SynXis Reservations <noreply@emea.synxis.com>',
      subject: 'SynXis Res Confirmed (5940SH007118) (MODIFICATION)',
      bodyText: 'Reservation modified.',
    },
    kind: 'channel',
    source: 'SynXis',
    reason: 'sender_domain:synxis.com',
  },
  {
    name: 'Expedia Partner Central sender',
    input: {
      fromAddress: 'notifications@m.expediapartnercentral.com',
      subject: 'New booking notification',
      bodyText: 'A reservation was created.',
    },
    kind: 'channel',
    source: 'Expedia Partner Central',
    reason: 'sender_domain:m.expediapartnercentral.com',
  },
  {
    name: 'Expedia subdomain sender',
    input: { fromAddress: 'no-reply@messages.expedia.com', subject: 'Booking update', bodyText: '' },
    kind: 'channel',
    source: 'Expedia',
    reason: 'sender_domain:expedia.com',
  },
  {
    name: 'WebBeds sender',
    input: { fromAddress: 'hotel@bookings.webbeds.com', subject: 'New booking', bodyText: '' },
    kind: 'channel',
    source: 'WebBeds',
    reason: 'sender_domain:webbeds.com',
  },
  {
    name: 'Hotelbeds sender',
    input: { fromAddress: 'noreply@hotelbeds.com', subject: 'Reservation update', bodyText: '' },
    kind: 'channel',
    source: 'Hotelbeds',
    reason: 'sender_domain:hotelbeds.com',
  },
  {
    name: 'Booking.com guest subdomain sender',
    input: { fromAddress: 'message@guest.booking.com', subject: 'New reservation', bodyText: '' },
    kind: 'channel',
    source: 'Booking.com',
    reason: 'sender_domain:booking.com',
  },
  {
    name: 'Booking.com property subdomain sender',
    input: { fromAddress: 'notice@property.booking.com', subject: 'Booking modification', bodyText: '' },
    kind: 'channel',
    source: 'Booking.com',
    reason: 'sender_domain:booking.com',
  },
  {
    name: 'Get-e sender',
    input: { fromAddress: 'hotel@get-e.com', subject: 'Booking confirmation', bodyText: '' },
    kind: 'channel',
    source: 'Get-e',
    reason: 'sender_domain:get-e.com',
  },
] as const;

const systemExamples = [
  {
    name: 'ReviewPro sender',
    input: { fromAddress: 'digest@reviewpro.com', subject: 'Guest review alert', bodyText: '' },
    kind: 'system',
    source: 'ReviewPro',
    reason: 'sender_domain:reviewpro.com',
  },
  {
    name: 'TrustYou sender',
    input: { fromAddress: 'alerts@reviews.trustyou.com', subject: 'Review alert', bodyText: '' },
    kind: 'system',
    source: 'TrustYou',
    reason: 'sender_domain:trustyou.com',
  },
  {
    name: 'Revinate sender',
    input: { fromAddress: 'daily@revinate.com', subject: 'Daily hotel report', bodyText: '' },
    kind: 'system',
    source: 'Revinate',
    reason: 'sender_domain:revinate.com',
  },
  {
    name: 'Medallia subdomain sender',
    input: { fromAddress: 'notice@feedback.medallia.com', subject: 'Guest feedback', bodyText: '' },
    kind: 'system',
    source: 'Medallia',
    reason: 'sender_domain:medallia.com',
  },
  {
    name: 'Tripadvisor sender',
    input: { fromAddress: 'reviews@tripadvisor.com', subject: 'New review', bodyText: '' },
    kind: 'system',
    source: 'Tripadvisor',
    reason: 'sender_domain:tripadvisor.com',
  },
] as const;

const forwardedExamples = [
  {
    name: 'internal FW with original From header',
    input: {
      fromAddress: 'bongi@legacyhotels.co.za',
      subject: 'FW: SynXis Res Confirmed (5940SH007118) (MODIFICATION)',
      bodyText: [
        'Please note.',
        '---------- Forwarded message ----------',
        'From: SynXis Reservations <noreply@synxis.com>',
        'Subject: SynXis Res Confirmed',
      ].join('\n'),
    },
    kind: 'channel',
    source: 'SynXis',
    reason: 'forwarded_sender:synxis.com',
  },
  {
    name: 'internal forward with original Sender header',
    input: {
      fromAddress: 'reservations@legacyhotels.co.za',
      subject: 'Fwd: New reservation',
      bodyText: 'Forwarded message:\nSender: Guest Messaging <notice@property.booking.com>',
    },
    kind: 'channel',
    source: 'Booking.com',
    reason: 'forwarded_sender:booking.com',
  },
  {
    name: 'internal forward of review-system email',
    input: {
      fromAddress: 'ops@legacyhotels.co.za',
      subject: 'FW: New feedback',
      bodyText: 'From: TrustYou <alerts@trustyou.com>\nSubject: New feedback',
    },
    kind: 'system',
    source: 'TrustYou',
    reason: 'forwarded_sender:trustyou.com',
  },
  {
    name: 'internal FW with known channel subject template',
    input: {
      fromAddress: 'ops@legacyhotels.co.za',
      subject: 'FW: SynXis Res Confirmed (5940SH007118) (MODIFICATION)',
      bodyText: 'Please file this.',
    },
    kind: 'channel',
    source: 'SynXis',
    reason: 'forwarded_subject:synxis',
  },
] as const;

const directExamples = [
  {
    name: 'Gmail guest merely mentions Booking.com',
    input: {
      fromAddress: 'guest@gmail.com',
      subject: 'Question about my stay',
      bodyText: 'I booked via Booking.com. Can I add breakfast?',
    },
  },
  {
    name: 'travel agent mentions an OTA',
    input: {
      fromAddress: 'agent@travel-agency.example',
      subject: 'Please amend client booking',
      bodyText: 'The guest booked through Expedia; please move arrival by one night.',
    },
  },
  {
    name: 'lookalike sender domain',
    input: { fromAddress: 'guest@booking.com.attacker.example', subject: 'My stay', bodyText: '' },
  },
  {
    name: 'internal FW with no channel header or known template',
    input: {
      fromAddress: 'staff@legacyhotels.co.za',
      subject: 'FW: Guest request',
      bodyText: 'Booking.com was mentioned, but this is a staff note.',
    },
  },
  {
    name: 'unknown mail sender mentions review systems',
    input: {
      fromAddress: 'guest@example.net',
      subject: 'A question',
      bodyText: 'I saw reviews on ReviewPro and Tripadvisor.',
    },
  },
] as const;

describe('classifyMailSource', () => {
  it.each(channelExamples)('matches channel source: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(systemExamples)('matches system source: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(forwardedExamples)('matches forwarded source: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(directExamples)('keeps direct mail: $name', ({ input }) => {
    expect(classifyMailSource(input)).toEqual({
      kind: 'direct',
      source: null,
      reason: 'no_matching_sender_or_forward_header',
    });
  });
});

describe('mailSourceTriageOutput', () => {
  it('routes source-matched mail to automated-channel as non-spam with an auditable rationale', () => {
    const output = mailSourceTriageOutput({
      kind: 'channel',
      source: 'Expedia Partner Central',
      reason: 'forwarded_sender:expediapartnercentral.com',
    });

    expect(output).toMatchObject({
      primaryFolder: 'automated-channel',
      isSpam: false,
      suggestedTools: [],
      humanAction: 'none',
    });
    expect(output.rationale).toContain('Expedia Partner Central');
    expect(output.rationale).toContain('forwarded_sender:expediapartnercentral.com');
    expect(output.policyFlags).toContain('mail-source:channel');
    expect(output.policyFlags).not.toContain('mail-source:routed');
  });
});

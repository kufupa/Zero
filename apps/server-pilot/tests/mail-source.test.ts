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
  {
    name: 'Tiket.com sender',
    input: { fromAddress: 'noreply@tiket.com', subject: 'New reservation', bodyText: '' },
    kind: 'channel',
    source: 'Tiket.com',
    reason: 'sender_domain:tiket.com',
  },
  {
    name: 'Profitroom booking engine sender',
    input: { fromAddress: 'Profitroom <booking@profitroom.com>', subject: 'New booking', bodyText: '' },
    kind: 'channel',
    source: 'Profitroom',
    reason: 'sender_domain:profitroom.com',
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
  {
    name: 'H-Pay payment notice sender',
    input: {
      fromAddress: 'no-reply@hospitality.cloud',
      subject: 'The Centurion Hotel Booking Secure Payment Link',
      bodyText: '',
    },
    kind: 'system',
    source: 'H-Pay',
    reason: 'sender_domain:hospitality.cloud',
  },
] as const;

const forwardedExamples = [
  {
    name: 'internal forward of review-system email',
    input: {
      fromAddress: 'ops@legacyhotels.co.za',
      subject: 'FW: New feedback',
      bodyText: 'From: TrustYou <alerts@trustyou.com>\nSubject: New feedback',
      hasAttachments: false,
    },
    kind: 'direct',
    source: null,
    reason: 'no_matching_sender',
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
  {
    name: 'travel agent Travelit stays in scope',
    input: { fromAddress: 'reservations@travelit.co.za', subject: 'Booking request', bodyText: '' },
  },
  {
    name: 'travel agent TBO stays in scope',
    input: { fromAddress: 'hotels@tbo.com', subject: 'Booking request', bodyText: '' },
  },
  {
    name: 'TBO helpdesk stays in scope',
    input: { fromAddress: 'support@tbohelp.zendesk.com', subject: 'Booking query', bodyText: '' },
  },
  {
    name: 'look-alike host is not Tiket.com',
    input: { fromAddress: 'sales@mytiket.com', subject: 'Rates', bodyText: '' },
  },
] as const;

describe('classifyMailSource', () => {
  it('skips Profitroom exact-host mail regardless of subject, while a staff forward stays reviewable', () => {
    expect(
      classifyMailSource({ fromAddress: 'noreply@profitroom.com', subject: 'Default contact form', bodyText: '' }),
    ).toEqual({ kind: 'channel', source: 'Profitroom', reason: 'sender_domain:profitroom.com' });
    expect(
      classifyMailSource({
        fromAddress: 'reservations@legacyhotels.co.za',
        subject: 'FW: Default contact form',
        bodyText: 'From: Profitroom <noreply@profitroom.com>\nSent: today\nSubject: Default contact form',
        hasAttachments: false,
      }),
    ).toEqual({ kind: 'direct', source: null, reason: 'no_matching_sender' });
  });

  it('keeps a staff forward of a Profitroom contact form reviewable even with a rewritten subject', () => {
    expect(
      classifyMailSource({
        fromAddress: 'reservations@legacyhotels.co.za',
        subject: 'FW: Guest enquiry',
        bodyText:
          'From: Profitroom <noreply@profitroom.com>\nSent: Monday\nTo: reservations\nSubject: Default contact form\n\nHello',
      }),
    ).toEqual({ kind: 'direct', source: null, reason: 'no_matching_sender' });
  });

  it('keeps a staff forward with header-looking lines reviewable: text layout cannot prove an envelope', () => {
    const result = classifyMailSource({
      fromAddress: 'reservations@legacyhotels.co.za',
      subject: 'FW: Secure payment link',
      bodyText:
        'From: H-Pay <noreply@hospitality.cloud>\n\nSent: Monday\n\nTo: reservations\n\nCc: finance\n\nSubject: Secure payment link\n\nHello',
      hasAttachments: false,
    });
    expect(result).toEqual({ kind: 'direct', source: null, reason: 'no_matching_sender' });
  });

  it('skips all exact-host H-Pay mail; the skip is not subject-limited, and subdomains stay direct', () => {
    expect(
      classifyMailSource({ fromAddress: 'finance@hospitality.cloud', subject: 'Payment confirmation', bodyText: '' }),
    ).toEqual({ kind: 'system', source: 'H-Pay', reason: 'sender_domain:hospitality.cloud' });
    for (const fromAddress of ['staff@mail.profitroom.com', 'noreply@mail.tiket.com',
      'alerts@mail.ratetiger.com', 'finance@h-pay.hospitality.cloud']) {
      expect(classifyMailSource({ fromAddress, subject: 'Question', bodyText: '' }).kind).toBe('direct');
    }
  });

  it('does not skip an internal forward on a brand-prefixed subject alone', () => {
    for (const subject of ['Fwd: Profitroom request to change dates', 'Fwd: Tiket special request']) {
      expect(
        classifyMailSource({ fromAddress: 'reservations@legacyhotels.co.za', subject, bodyText: 'Please help.' }).kind,
      ).toBe('direct');
    }
  });

  it.each(channelExamples)('matches channel source: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(systemExamples)('matches system source: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(forwardedExamples)('keeps a human-origin forward reviewable: $name', ({ input, kind, source, reason }) => {
    expect(classifyMailSource(input)).toEqual({ kind, source, reason });
  });

  it.each(directExamples)('keeps direct mail: $name', (entry) => {
    expect(classifyMailSource(entry.input)).toEqual({
      kind: 'direct',
      source: null,
      reason: 'reason' in entry ? entry.reason : 'no_matching_sender',
    });
  });

  it('never lets header-looking body lines classify a staff forward, even an older quoted channel notice', () => {
    expect(
      classifyMailSource({
        fromAddress: 'staff@legacyhotels.co.za',
        subject: 'FW: Guest amendment',
        bodyText: [
          'Please amend the guest dates.',
          '',
          'From: guest@gmail.com',
          'Date: Mon, 12 Oct 2026 10:00:00 +0000',
          'Subject: Request to amend my stay',
          '',
          '---------- Forwarded message ----------',
          '> From: Booking.com <noreply@messages.booking.com>',
          '> Subject: Booking confirmation',
        ].join('\n'),
      }),
    ).toEqual({
      kind: 'direct',
      source: null,
      reason: 'no_matching_sender',
    });
  });

  it('keeps an HTML-only staff forward with header-looking lines reviewable', () => {
    expect(
      classifyMailSource({
        fromAddress: 'staff@legacyhotels.co.za',
        subject: 'FW: Guest message',
        bodyText: [
          '<div>Forwarded message</div>',
          '<div>From: SynXis&nbsp;&amp; &quot;Reservations&quot; &#39;desk&#39; ',
          '&lt;noreply@synxis.com&gt;</div>',
          '<div>Subject: Guest message</div>',
        ].join(''),
        hasAttachments: false,
      }),
    ).toEqual({
      kind: 'direct',
      source: null,
      reason: 'no_matching_sender',
    });
  });
});

describe('mailSourceTriageOutput', () => {
  it('routes source-matched mail to automated-channel as non-spam with an auditable rationale', () => {
    const output = mailSourceTriageOutput({
      kind: 'channel',
      source: 'Expedia Partner Central',
      reason: 'sender_domain:m.expediapartnercentral.com',
    });

    expect(output).toMatchObject({
      primaryFolder: 'automated-channel',
      isSpam: false,
      suggestedTools: [],
      humanAction: 'none',
    });
    expect(output.rationale).toContain('Expedia Partner Central');
    expect(output.rationale).toContain('sender_domain:m.expediapartnercentral.com');
    expect(output.policyFlags).toContain('mail-source:channel');
    expect(output.policyFlags).not.toContain('mail-source:routed');
  });
});

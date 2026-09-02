import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  detectConversationSignals,
  isConversationResponded,
  type ConversationMessage,
  type IndexableMessage,
} from '../src/mail/conversation-signals.js';
import { describe, expect, it } from 'vitest';

function msg(
  overrides: Partial<ConversationMessage> & Pick<ConversationMessage, 'id'>,
): ConversationMessage {
  return {
    threadId: 'thread-a',
    direction: 'inbound',
    from: 'guest-a@example.com',
    to: 'centurion@legacyhotels.co.za',
    cc: '',
    subject: 'Room request',
    bodyText: 'Need two rooms for next month.',
    receivedAt: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

function indexable(
  overrides: Partial<IndexableMessage> & Pick<IndexableMessage, 'id'>,
): IndexableMessage {
  const { bodyText: _body, ...rest } = msg(overrides as ConversationMessage);
  return rest;
}

describe('buildAutoConfirmIndex', () => {
  it('indexes auto outbound confirmation letters with conf and guest norm', () => {
    const rows = buildAutoConfirmIndex([
      indexable({
        id: 'auto-1',
        threadId: 'thread-conf',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'booking.com',
        subject: 'Confirmation letter_Jane Doe (n°1234567-1) booking update notification',
        receivedAt: '2026-08-30T14:00:00.000Z',
      }),
      indexable({
        id: 'human-1',
        threadId: 'thread-human',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Re: Room request',
        receivedAt: '2026-08-30T15:00:00.000Z',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      conf: '1234567',
      guestNorm: 'janedoe',
      day: '2026-08-30',
      threadId: 'thread-conf',
    });
  });
});

describe('buildOrphanOutboundIndex', () => {
  it('groups outbound rows by external guest email', () => {
    const index = buildOrphanOutboundIndex([
      indexable({
        id: 'out-1',
        threadId: 'thread-b',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'Guest A <guest-a@example.com>',
        subject: 'Confirmation letter for stay',
        receivedAt: '2026-08-31T09:00:00.000Z',
      }),
    ]);

    const rows = index.get('guest-a@example.com');
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toEqual({
      guestEmail: 'guest-a@example.com',
      threadId: 'thread-b',
      subject: 'Confirmation letter for stay',
      from: 'centurion@legacyhotels.co.za',
      isAuto: true,
      day: '2026-08-31',
    });
  });
});

describe('detectConversationSignals', () => {
  it('detects in_thread_outbound when staff replies after trigger', () => {
    const messages = [
      msg({ id: 'trigger', direction: 'inbound', receivedAt: '2026-08-30T10:00:00.000Z' }),
      msg({
        id: 'reply',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Re: Room request',
        bodyText: 'We can assist with availability.',
        receivedAt: '2026-08-30T11:00:00.000Z',
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('in_thread_outbound');
    expect(isConversationResponded(signals)).toBe(true);
  });

  it('detects cross_thread_conf when conf number appears in thread text', () => {
    const autoConfirmIndex = buildAutoConfirmIndex([
      indexable({
        id: 'auto-1',
        threadId: 'other-thread',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'booking.com notification',
        subject: 'Confirmation letter_Guest (n°7654321-1) booking update notification',
        receivedAt: '2026-08-30T12:00:00.000Z',
      }),
    ]);

    const messages = [
      msg({
        id: 'trigger',
        bodyText: 'Please confirm reservation n°7654321-1 for our group.',
        receivedAt: '2026-08-30T13:00:00.000Z',
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex,
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('cross_thread_conf');
  });

  it('detects orphan_auto_confirm on another thread to the same guest', () => {
    const orphanByGuest = buildOrphanOutboundIndex([
      indexable({
        id: 'orphan-1',
        threadId: 'thread-b',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Confirmation letter_Jane Guest (n°1234567-1) booking update notification',
        receivedAt: '2026-08-31T09:00:00.000Z',
      }),
    ]);

    const messages = [
      msg({
        id: 'trigger',
        direction: 'inbound',
        from: 'guest-a@example.com',
        bodyText: 'Jane Guest asks about confirmation n°1234567-1.',
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest,
    });

    expect(signals).toContain('orphan_auto_confirm');
  });

  it('detects orphan_centurion_human on another thread to the same guest', () => {
    const orphanByGuest = buildOrphanOutboundIndex([
      indexable({
        id: 'orphan-1',
        threadId: 'thread-b',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Re: Room request quote',
        receivedAt: '2026-08-31T09:00:00.000Z',
      }),
    ]);

    const messages = [msg({ id: 'trigger', direction: 'inbound', from: 'guest-a@example.com' })];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest,
    });

    expect(signals).toContain('orphan_centurion_human');
  });

  it('detects quoted_hotel_header in full thread body', () => {
    const messages = [
      msg({
        id: 'trigger',
        bodyText: [
          'See below.',
          'From: Centurion Hotel Reservations <centurion@legacyhotels.co.za>',
          'Subject: Quote',
        ].join('\n'),
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('quoted_hotel_header');
    expect(signals).not.toContain('quoted_hotel_phrase');
  });

  it('detects quoted_hotel_phrase when hotel header pattern is absent', () => {
    const messages = [
      msg({
        id: 'trigger',
        bodyText: 'Please find attached quotation for your requested dates.',
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('quoted_hotel_phrase');
    expect(signals).not.toContain('quoted_hotel_header');
  });

  it('detects an Outlook quoted From/Sent legacy-hotel block', () => {
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [
        msg({
          id: 'trigger',
          bodyText: [
            'Thanks for the update.',
            'From: Centurion Reservations <centurion@legacyhotels.co.za>',
            'Sent: Monday, September 1, 2026 08:14',
          ].join('\n'),
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('quoted_outlook_legacy_from');
  });

  it('detects an inbound follow-up whose In-Reply-To names a hotel message', () => {
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [
        msg({ id: 'trigger' }),
        msg({
          id: 'guest-follow-up',
          bodyText: 'Following up on the quotation.',
          inReplyTo: '<hotel-123@legacyhotels.co.za>',
          references: ['<hotel-123@legacyhotels.co.za>'],
          receivedAt: '2026-08-30T11:00:00.000Z',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('in_reply_to_hotel_msgid');
  });

  it('detects a staff inbound message carrying commercial reply language', () => {
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [
        msg({ id: 'trigger' }),
        msg({
          id: 'staff-follow-up',
          from: 'marthamthembu@legacyhotels.co.za',
          bodyText: 'Please see attached quotation and provisional confirmation.',
          receivedAt: '2026-08-30T11:00:00.000Z',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('staff_inbound_commercial_reply');
  });

  it('detects Gmail and Apple Mail hotel quote headers', () => {
    const gmailSignals = detectConversationSignals({
      threadId: 'thread-gmail',
      triggerMessageId: 'trigger',
      messages: [
        msg({
          id: 'trigger',
          bodyText:
            'On Mon, Sep 1, 2026 at 8:14 AM, Centurion Hotel Reservations <centurion@legacyhotels.co.za> wrote:\n> Quote',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });
    const appleSignals = detectConversationSignals({
      threadId: 'thread-apple',
      triggerMessageId: 'trigger',
      messages: [
        msg({
          id: 'trigger',
          bodyText: 'On 1 Sep 2026, at 08:14, centurion@legacyhotels.co.za wrote:\n> Quote',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(gmailSignals).toContain('quoted_gmail_hotel');
    expect(appleSignals).toContain('quoted_applemail_hotel');
  });

  it('detects the Centurion From/Date quote header variant', () => {
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [
        msg({
          id: 'trigger',
          bodyText: 'From: Centurion Hotel Reservations\nDate: 1 September 2026',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('quoted_from_centurion_date');
  });

  it('detects a quoted staff signature block', () => {
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [
        msg({
          id: 'trigger',
          bodyText: 'Warm regards,\nBongi Kolanisi\nReservationist',
        }),
      ],
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toContain('quoted_staff_sig');
  });

  it('does not infer response from a short-name cross-thread auto-confirm match', () => {
    const autoConfirmIndex = buildAutoConfirmIndex([
      indexable({
        id: 'auto-short',
        threadId: 'other-thread',
        direction: 'outbound',
        to: 'booking.com notification',
        subject: 'Confirmation letter_A (n°7654321-1) booking update notification',
        receivedAt: '2026-08-30T12:00:00.000Z',
      }),
    ]);
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [msg({ id: 'trigger', bodyText: 'Please confirm this booking for A.' })],
      autoConfirmIndex,
      orphanByGuest: new Map(),
    });

    expect(signals).not.toContain('cross_thread_conf');
    expect(isConversationResponded(signals)).toBe(false);
  });

  it('does not infer response from a weak guest-email orphan', () => {
    const orphanByGuest = buildOrphanOutboundIndex([
      indexable({
        id: 'weak-orphan',
        threadId: 'other-thread',
        direction: 'outbound',
        from: 'agent@other-hotel.example',
        to: 'guest-a@example.com',
        subject: 'Re: Room request',
      }),
    ]);
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [msg({ id: 'trigger', from: 'guest-a@example.com' })],
      autoConfirmIndex: [],
      orphanByGuest,
    });

    expect(signals).not.toContain('orphan_auto_confirm');
    expect(signals).not.toContain('orphan_centurion_human');
    expect(isConversationResponded(signals)).toBe(false);
  });

  it('does not infer response from a generic confirmation orphan without identity evidence', () => {
    const orphanByGuest = buildOrphanOutboundIndex([
      indexable({
        id: 'generic-confirmation',
        threadId: 'other-thread',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Confirmation letter for guest stay',
      }),
    ]);
    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages: [msg({ id: 'trigger', from: 'guest-a@example.com' })],
      autoConfirmIndex: [],
      orphanByGuest,
    });

    expect(signals).not.toContain('orphan_auto_confirm');
    expect(isConversationResponded(signals)).toBe(false);
  });

  it('returns no signals for unanswered guest-only thread', () => {
    const messages = [
      msg({
        id: 'trigger',
        direction: 'inbound',
        bodyText: 'Any availability for 10 rooms?',
      }),
    ];

    const signals = detectConversationSignals({
      threadId: 'thread-a',
      triggerMessageId: 'trigger',
      messages,
      autoConfirmIndex: [],
      orphanByGuest: new Map(),
    });

    expect(signals).toEqual([]);
    expect(isConversationResponded(signals)).toBe(false);
  });
});

describe('isConversationResponded', () => {
  it('is true when any conversation signal is present', () => {
    expect(isConversationResponded(['quoted_hotel_phrase'])).toBe(true);
    expect(isConversationResponded([])).toBe(false);
  });
});

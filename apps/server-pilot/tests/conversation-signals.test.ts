import { describe, expect, it } from 'vitest';
import {
  buildAutoConfirmIndex,
  buildOrphanOutboundIndex,
  detectConversationSignals,
  isConversationResponded,
  type ConversationMessage,
  type IndexableMessage,
} from '../src/mail/conversation-signals.js';

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
        subject:
          'Confirmation letter_Jane Doe (n°1234567-1) booking update notification',
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
        subject: 'Confirmation letter for guest stay',
        receivedAt: '2026-08-31T09:00:00.000Z',
      }),
    ]);

    const messages = [
      msg({ id: 'trigger', direction: 'inbound', from: 'guest-a@example.com' }),
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

    const messages = [
      msg({ id: 'trigger', direction: 'inbound', from: 'guest-a@example.com' }),
    ];

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

/**
 * Reactions wire contract and grouping logic tests.
 */
import { describe, expect, it } from 'vitest';
import { toggleReactionInput } from '../src/trpc/routes/mail.js';
import {
  groupReactions,
  toParsedMessage,
} from '../src/trpc/wire-compat.js';
import type { MessageRow } from '../src/trpc/wire-compat.js';

describe('mail reactions — grouping and wire helpers', () => {
  it('returns empty array when rows are empty', () => {
    const grouped = groupReactions([]);
    expect(grouped).toEqual([]);
  });

  it('groups multiple reactions by emoji and marks hasReacted correctly', () => {
    const rows = [
      {
        reaction: '👍',
        userId: 'user-1',
        userEmail: 'alice@example.com',
        userName: 'Alice Smith',
        createdAt: new Date('2026-09-09T10:00:00Z'),
      },
      {
        reaction: '👍',
        userId: 'user-2',
        userEmail: 'bob@example.com',
        userName: 'Bob Jones',
        createdAt: new Date('2026-09-09T10:01:00Z'),
      },
      {
        reaction: '❤️',
        userId: 'user-1',
        userEmail: 'alice@example.com',
        userName: 'Alice Smith',
        createdAt: new Date('2026-09-09T10:02:00Z'),
      },
    ];

    // For user bob@example.com
    const groupedBob = groupReactions(rows, 'bob@example.com');
    expect(groupedBob).toHaveLength(2);

    const thumbsBob = groupedBob.find((g) => g.emoji === '👍');
    expect(thumbsBob).toBeDefined();
    expect(thumbsBob?.count).toBe(2);
    expect(thumbsBob?.hasReacted).toBe(true);
    expect(thumbsBob?.users).toEqual([
      { userId: 'user-1', email: 'alice@example.com', userName: 'Alice Smith' },
      { userId: 'user-2', email: 'bob@example.com', userName: 'Bob Jones' },
    ]);

    const heartBob = groupedBob.find((g) => g.emoji === '❤️');
    expect(heartBob).toBeDefined();
    expect(heartBob?.count).toBe(1);
    expect(heartBob?.hasReacted).toBe(false);

    // Case-insensitivity check for caller email
    const groupedAlice = groupReactions(rows, 'ALICE@EXAMPLE.COM');
    const thumbsAlice = groupedAlice.find((g) => g.emoji === '👍');
    expect(thumbsAlice?.hasReacted).toBe(true);
    const heartAlice = groupedAlice.find((g) => g.emoji === '❤️');
    expect(heartAlice?.hasReacted).toBe(true);
  });

  it('toParsedMessage attaches reactions to ParsedMessageWire', () => {
    const fakeRow: MessageRow = {
      id: 'msg-test-1',
      transportId: 'transport-1',
      threadId: 'thread-test-1',
      ingestMailboxId: null,
      direction: 'inbound',
      pop3Uidl: null,
      ownerHeaderValue: null,
      messageIdHeader: '<test@zero.mail>',
      inReplyTo: null,
      references: null,
      fromAddress: 'sender@example.com',
      toAddresses: ['recipient@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Test Subject',
      textBody: 'Hello world',
      htmlBody: '<p>Hello world</p>',
      rawMimeS3Key: null,
      isRead: true,
      isStarred: false,
      receivedAt: new Date('2026-09-09T12:00:00Z'),
      sentAt: null,
      createdAt: new Date('2026-09-09T12:00:00Z'),
      updatedAt: new Date('2026-09-09T12:00:00Z'),
    };

    const reactions: MessageReactionWire[] = [
      {
        emoji: '🎉',
        count: 1,
        users: [{ userId: 'u1', email: 'u1@example.com', userName: 'User 1' }],
        hasReacted: true,
      },
    ];

    const parsed = toParsedMessage(fakeRow, [], reactions);
    expect(parsed.reactions).toEqual(reactions);

    // Default without reactions
    const parsedDefault = toParsedMessage(fakeRow);
    expect(parsedDefault.reactions).toEqual([]);
  });

  it('toggleReactionInput validates messageId and reaction bounds', () => {
    expect(() =>
      toggleReactionInput.parse({ messageId: 'msg-1', reaction: '👍' }),
    ).not.toThrow();

    // 6 Outlook supported emojis
    const outlookEmojis = ['👍', '❤️', '🎉', '😆', '😮', '😢'];
    for (const emoji of outlookEmojis) {
      const parsed = toggleReactionInput.parse({ messageId: 'msg-123', reaction: emoji });
      expect(parsed.reaction).toBe(emoji);
    }

    // Invalid: empty reaction
    expect(() =>
      toggleReactionInput.parse({ messageId: 'msg-1', reaction: '' }),
    ).toThrow();

    // Invalid: empty messageId
    expect(() =>
      toggleReactionInput.parse({ messageId: '', reaction: '👍' }),
    ).toThrow();

    // Invalid: excessively long string
    expect(() =>
      toggleReactionInput.parse({ messageId: 'msg-1', reaction: 'a'.repeat(20) }),
    ).toThrow();
  });
});

import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const reachable = await probeTestDb();
const describeWithDb = reachable && TEST_DB_AVAILABLE ? describe : describe.skip;

describeWithDb('mail reactions — tRPC toggleReaction integration', () => {
  it('toggles reaction on and off and returns in mail.get', async () => {
    await withSeededTestDb(async (db) => {
      await seedInboxThread(db, {
        threadId: 'thread-reaction-test',
        transportId: 'transport-centurion',
        transportEmail: 'centurion@legacyhotel.com',
        threadRootId: 'reaction-root-1',
        subject: 'Reaction Test Subject',
        messageId: 'msg-reaction-1',
        messageIdHeader: 'msg-reaction-1@example.com',
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-centurion',
      });

      // Toggle 👍 ON
      const res1 = await caller.mail.toggleReaction({
        messageId: 'msg-reaction-1',
        reaction: '👍',
      });
      expect(res1.messageId).toBe('msg-reaction-1');
      expect(res1.reactions).toHaveLength(1);
      expect(res1.reactions[0].emoji).toBe('👍');
      expect(res1.reactions[0].count).toBe(1);
      expect(res1.reactions[0].hasReacted).toBe(true);

      // Verify mail.get includes the reaction
      const threadData = await caller.mail.get({ id: 'thread-reaction-test' });
      const targetMsg = threadData.messages.find((m) => m.id === 'msg-reaction-1');
      expect(targetMsg).toBeDefined();
      expect(targetMsg?.reactions).toBeDefined();
      expect(targetMsg?.reactions).toHaveLength(1);
      expect(targetMsg?.reactions?.[0].emoji).toBe('👍');
      expect(targetMsg?.reactions?.[0].count).toBe(1);
      expect(targetMsg?.reactions?.[0].hasReacted).toBe(true);

      // Toggle 👍 OFF
      const res2 = await caller.mail.toggleReaction({
        messageId: 'msg-reaction-1',
        reaction: '👍',
      });
      expect(res2.reactions).toHaveLength(0);

      // Verify mail.get reflects removed reaction
      const threadDataAfter = await caller.mail.get({ id: 'thread-reaction-test' });
      const targetMsgAfter = threadDataAfter.messages.find((m) => m.id === 'msg-reaction-1');
      expect(targetMsgAfter?.reactions).toHaveLength(0);
    });
  });
});


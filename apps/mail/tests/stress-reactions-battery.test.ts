import { describe, expect, it } from 'vitest';
import { groupReactions } from '../../server-pilot/src/trpc/wire-compat';
import { detectReactionNotification } from '../components/mail/reactions/reaction-banner';
import type { ParsedMessage } from '@/types';

describe('Suite 3: Stress Reactions Concurrency & State Battery', () => {
  describe('High-Volume Multi-User Reaction Aggregation', () => {
    it('aggregates 100 reactions across multiple emojis correctly', () => {
      const rows: Array<{
        reaction: string;
        userId: string;
        userEmail: string;
        userName: string;
      }> = [];

      // 50 users react with 👍
      for (let i = 1; i <= 50; i++) {
        rows.push({
          reaction: '👍',
          userId: `user-${i}`,
          userEmail: `staff${i}@legacyhotel.com`,
          userName: `Hotel Staff ${i}`,
        });
      }

      // 30 users react with ❤️
      for (let i = 1; i <= 30; i++) {
        rows.push({
          reaction: '❤️',
          userId: `guest-${i}`,
          userEmail: `guest${i}@gmail.com`,
          userName: `Guest ${i}`,
        });
      }

      // 20 users react with 🎉
      for (let i = 1; i <= 20; i++) {
        rows.push({
          reaction: '🎉',
          userId: `vip-${i}`,
          userEmail: `vip${i}@enterprise.com`,
          userName: `VIP ${i}`,
        });
      }

      // Current caller is staff10@legacyhotel.com (reacted with 👍)
      const grouped = groupReactions(rows, 'staff10@legacyhotel.com');

      expect(grouped).toHaveLength(3);

      const thumbs = grouped.find((g) => g.emoji === '👍');
      expect(thumbs).toBeDefined();
      expect(thumbs?.count).toBe(50);
      expect(thumbs?.hasReacted).toBe(true);
      expect(thumbs?.users).toHaveLength(50);

      const heart = grouped.find((g) => g.emoji === '❤️');
      expect(heart).toBeDefined();
      expect(heart?.count).toBe(30);
      expect(heart?.hasReacted).toBe(false);

      const party = grouped.find((g) => g.emoji === '🎉');
      expect(party).toBeDefined();
      expect(party?.count).toBe(20);
      expect(party?.hasReacted).toBe(false);
    });

    it('handles case-insensitive email matching for current user', () => {
      const rows = [
        {
          reaction: '👍',
          userId: 'u1',
          userEmail: 'Manager.FrontDesk@LegacyHotel.COM',
          userName: 'Duty Manager',
        },
      ];

      // Caller email in lowercase
      const grouped = groupReactions(rows, 'manager.frontdesk@legacyhotel.com');
      expect(grouped[0].hasReacted).toBe(true);
    });
  });

  describe('Outlook 6-Emoji Set Completeness', () => {
    it('supports all 6 standard Outlook emojis simultaneously on one message', () => {
      const outlookEmojis = ['👍', '❤️', '🎉', '😆', '😮', '😢'];
      const rows = outlookEmojis.map((emoji, idx) => ({
        reaction: emoji,
        userId: `u-${idx}`,
        userEmail: `user${idx}@example.com`,
        userName: `User ${idx}`,
      }));

      const grouped = groupReactions(rows, 'user0@example.com');
      expect(grouped).toHaveLength(6);

      for (const emoji of outlookEmojis) {
        const found = grouped.find((g) => g.emoji === emoji);
        expect(found).toBeDefined();
        expect(found?.count).toBe(1);
      }

      // User 0 only reacted to 👍
      expect(grouped.find((g) => g.emoji === '👍')?.hasReacted).toBe(true);
      expect(grouped.find((g) => g.emoji === '❤️')?.hasReacted).toBe(false);
    });
  });

  describe('Inbound Reaction Notification Body Variations', () => {
    const makeMsg = (text: string, html?: string): ParsedMessage => ({
      id: 'msg-notif-1',
      title: 'Re: Reservation Update',
      subject: 'Re: Reservation Update',
      tags: [],
      sender: { name: 'Alice', email: 'alice@hotel.com' },
      to: [{ email: 'bob@hotel.com' }],
      cc: null,
      bcc: null,
      tls: true,
      receivedOn: '2026-09-09T10:00:00Z',
      unread: false,
      body: text,
      decodedBody: html || `<p>${text}</p>`,
      processedHtml: html || `<p>${text}</p>`,
      blobUrl: '',
    });

    it('detects standard Outlook Web format: 👍 [Name] reacted to your message:', () => {
      const msg = makeMsg('👍 Ansh Arora reacted to your message:\n"Payment received in full"');
      const detected = detectReactionNotification(msg);
      expect(detected).not.toBeNull();
      expect(detected?.emoji).toBe('👍');
      expect(detected?.reactorName).toBe('Ansh Arora');
      expect(detected?.quotedSnippet).toBe('Payment received in full');
    });

    it('detects Outlook desktop trailing format: [Name] reacted to your message: ❤️', () => {
      const msg = makeMsg('Sarah Connor reacted to your message: ❤️\n"Will see you at 9am"');
      const detected = detectReactionNotification(msg);
      expect(detected).not.toBeNull();
      expect(detected?.emoji).toBe('❤️');
      expect(detected?.reactorName).toBe('Sarah Connor');
    });

    it('detects HTML formatted reaction message', () => {
      const html = `
        <div class="reaction-notification">
          <span>🎉 Executive Office reacted to your message:</span>
          <div>"Congratulations on the award"</div>
        </div>
      `;
      const msg = makeMsg('', html);
      const detected = detectReactionNotification(msg);
      expect(detected).not.toBeNull();
      expect(detected?.emoji).toBe('🎉');
    });
  });
});

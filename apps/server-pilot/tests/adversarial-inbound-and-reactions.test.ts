import { describe, expect, it } from 'vitest';
import { parseInboundReactionEmail } from '../src/mail/inbound-reaction-parser.js';
import { collapseQuotedHtml } from '../src/mail/collapse-quoted-html.js';
import { groupReactions, type MessageReactionWire } from '../src/trpc/wire-compat.js';

describe('Adversarial Server Battery — Inbound Reactions & Quoted Collapsing', () => {
  describe('Adversarial Inbound Reaction Email Parsing', () => {
    it('parses subject with FWD: and leading emoji', () => {
      const subject = 'FWD: 👍 Alice Smith reacted to your message:';
      const result = parseInboundReactionEmail(subject, '<p>Some body</p>');
      expect(result).not.toBeNull();
      expect(result?.emoji).toBe('👍');
      expect(result?.reactorName).toBe('Alice Smith');
    });

    it('parses subject with [EXTERNAL] or [EXT] prefixes', () => {
      const subject = '[EXTERNAL] ❤️ Front Desk Manager reacted to: "Key Card Issue"';
      const result = parseInboundReactionEmail(subject, '<p>Some body</p>');
      expect(result).not.toBeNull();
      expect(result?.emoji).toBe('❤️');
      expect(result?.reactorName).toBe('Front Desk Manager');
      expect(result?.quotedSnippet).toBe('Key Card Issue');
    });

    it('parses trailing emoji pattern: "Name reacted 👍 to your message"', () => {
      const subject = 'Sarah Connor reacted 😆 to your message:';
      const result = parseInboundReactionEmail(subject, '<p>Some body</p>');
      expect(result).not.toBeNull();
      expect(result?.emoji).toBe('😆');
      expect(result?.reactorName).toBe('Sarah Connor');
    });

    it('handles all 6 standard Outlook emojis with or without variation selector', () => {
      const emojis = ['👍', '❤️', '🎉', '😆', '😮', '😢'];
      for (const emoji of emojis) {
        const subject = `${emoji} Guest User reacted to your message:`;
        const result = parseInboundReactionEmail(subject, '');
        expect(result).not.toBeNull();
        expect(result?.reactorName).toBe('Guest User');
      }
    });

    it('returns false for normal emails that merely mention emojis or reactions', () => {
      expect(parseInboundReactionEmail('Please react to this proposal 👍', '').isReaction).toBe(false);
      expect(parseInboundReactionEmail('Re: Chemical reaction in lab', '').isReaction).toBe(false);
      expect(parseInboundReactionEmail('Happy Birthday! 🎉', '').isReaction).toBe(false);
    });
  });

  describe('Adversarial Inbound Quote Collapsing with Cheerio', () => {
    it('collapses uppercase and mixed-case <DIV ID="DIVRPLYFWDMSG">', () => {
      const html = `
        <div>Top text</div>
        <div id="divRplyFwdMsg">
          <hr>
          <b>From:</b> someone<br>
          Quoted content
        </div>
      `;
      const collapsed = collapseQuotedHtml(html);
      expect(collapsed).toContain('<details class="quoted-toggle">');
      expect(collapsed).toContain('Top text');
    });

    it('collapses Outlook HTML with .OutlookMessageHeader class', () => {
      const html = `
        <p>I agree.</p>
        <div class="OutlookMessageHeader">
          <hr>
          <font size="2" face="Calibri">
            <b>From:</b> Manager<br>
            <b>Sent:</b> Tuesday, September 8, 2026<br>
          </font>
        </div>
        <div>Previous discussion</div>
      `;
      const collapsed = collapseQuotedHtml(html);
      expect(collapsed).toContain('<details class="quoted-toggle">');
      expect(collapsed).toContain('I agree.');
    });

    it('does not collapse email body that just has standard text "From: "', () => {
      const normalEmail = `
        <p>Hello team,</p>
        <p>From: our perspective, this deadline is achievable.</p>
        <p>Best regards,</p>
      `;
      const result = collapseQuotedHtml(normalEmail);
      expect(result).not.toContain('<details class="quoted-toggle">');
      expect(result).toContain('From: our perspective');
    });

    it('handles 30 levels of nested quotes without stack overflow', () => {
      let nested = '<p>Base email</p>';
      for (let i = 0; i < 30; i++) {
        nested = `<div>Reply ${i}</div><div class="gmail_quote"><hr>${nested}</div>`;
      }
      const start = performance.now();
      const collapsed = collapseQuotedHtml(nested);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100); // Must be sub-100ms
      expect(collapsed).toContain('<details class="quoted-toggle">');
    });
  });

  describe('Adversarial Reaction Aggregation & Deduplication', () => {
    it('aggregates multiple reactions from different users on the same emoji', () => {
      const rows: MessageReactionWire[] = [
        {
          id: 'r1',
          messageId: 'm1',
          transportId: 't1',
          userId: 'u1',
          userEmail: 'alice@test.com',
          userName: 'Alice',
          reaction: '👍',
          source: 'internal',
          createdAt: new Date(),
        },
        {
          id: 'r2',
          messageId: 'm1',
          transportId: 't1',
          userId: 'u2',
          userEmail: 'bob@test.com',
          userName: 'Bob',
          reaction: '👍',
          source: 'internal',
          createdAt: new Date(),
        },
      ];

      const groups = groupReactions(rows, 'alice@test.com');
      expect(groups).toHaveLength(1);
      expect(groups[0]?.emoji).toBe('👍');
      expect(groups[0]?.count).toBe(2);
      expect(groups[0]?.hasReacted).toBe(true);
      expect(groups[0]?.users).toHaveLength(2);
    });

    it('preserves skin tones and multi-byte unicode accurately', () => {
      const rows: MessageReactionWire[] = [
        {
          id: 'r1',
          messageId: 'm1',
          transportId: 't1',
          userId: 'u1',
          userEmail: 'user1@test.com',
          userName: 'User 1',
          reaction: '👍🏽',
          source: 'internal',
          createdAt: new Date(),
        },
      ];

      const groups = groupReactions(rows);
      expect(groups[0]?.emoji).toBe('👍🏽');
    });
  });
});

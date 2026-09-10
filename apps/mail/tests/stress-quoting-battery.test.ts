import { describe, expect, it } from 'vitest';
import { constructOutlookReplyHtml } from '../lib/mail/outlook-quote-formatter';
import { constructReplyBody, constructForwardBody } from '../lib/utils';
import type { ParsedMessage } from '@/types';

describe('Suite 2: Stress Quoting Wire & Compose Parsing Battery', () => {
  const baseMessage: ParsedMessage = {
    id: 'msg-quote-stress-1',
    subject: 'Urgent Hotel Booking #88219',
    title: 'Urgent Hotel Booking #88219',
    tags: [],
    sender: { name: 'Dr. Sarah Connor', email: 'sarah@skynet.com' },
    to: [
      { name: 'Centurion Reservations', email: 'reservations@legacyhotel.com' },
      { name: 'Front Desk', email: 'frontdesk@legacyhotel.com' },
    ],
    cc: [{ name: 'Executive Assistant', email: 'assistant@skynet.com' }],
    bcc: null,
    tls: true,
    receivedOn: '2026-09-09T14:15:30.000Z',
    unread: false,
    body: 'Could you please confirm the Presidential Suite reservation?',
    decodedBody: '<p>Could you please confirm the <strong>Presidential Suite</strong> reservation?</p>',
    processedHtml: '<p>Could you please confirm the <strong>Presidential Suite</strong> reservation?</p>',
    blobUrl: '',
  };

  describe('Outlook Wire HTML Structure & Calibri Specifications', () => {
    it('produces compliant #divRplyFwdMsg container with #E1E1E1 border and Calibri 11pt', () => {
      const html = constructOutlookReplyHtml(baseMessage, {
        isForward: false,
        userTimezone: 'Africa/Johannesburg',
      });

      expect(html).toContain('id="divRplyFwdMsg"');
      expect(html).toContain('#E1E1E1');
      expect(html).toContain('class="gmail_quote"');
      expect(html).toContain('id="zero-quoted-content"');
      expect(html).toContain('Calibri, Arial, sans-serif');
      expect(html).toContain('font-size: 11pt');
    });

    it('formats headers correctly for Reply with all fields present', () => {
      const html = constructOutlookReplyHtml(baseMessage, {
        isForward: false,
        userTimezone: 'Africa/Johannesburg',
      });

      // From header
      expect(html).toContain('<b>From:</b> Dr. Sarah Connor &lt;sarah@skynet.com&gt;');
      // Sent header with South Africa local time (14:15 UTC -> 16:15 SAST)
      expect(html).toContain('<b>Sent:</b>');
      expect(html).toContain('4:15 PM');
      // To header
      expect(html).toContain('<b>To:</b>');
      expect(html).toContain('reservations@legacyhotel.com');
      expect(html).toContain('frontdesk@legacyhotel.com');
      // Cc header
      expect(html).toContain('<b>Cc:</b>');
      expect(html).toContain('assistant@skynet.com');
      // Subject
      expect(html).toContain('<b>Subject:</b> RE: Urgent Hotel Booking #88219');
    });

    it('omits Cc header when Cc is empty or null', () => {
      const noCcMsg: ParsedMessage = {
        ...baseMessage,
        cc: null,
      };

      const html = constructOutlookReplyHtml(noCcMsg, {
        isForward: false,
        userTimezone: 'UTC',
      });

      expect(html).not.toContain('<b>Cc:</b>');
    });

    it('formats Forward headers correctly', () => {
      const html = constructForwardBody(baseMessage, 'UTC');

      expect(html).toContain('id="divRplyFwdMsg"');
      expect(html).toContain('<b>From:</b>');
      expect(html).toContain('<b>Sent:</b>');
      expect(html).toContain('<b>Subject:</b>');
    });
  });

  describe('Deep Nesting & Large Thread Payloads', () => {
    it('handles deeply nested existing quotes without corrupting structure', () => {
      let nestedBody = '<p>Original bottom message</p>';
      for (let i = 1; i <= 10; i++) {
        nestedBody = `
          <p>Reply level ${i}</p>
          <div id="divRplyFwdMsg">
            <hr />
            <p><b>From:</b> User ${i}</p>
            ${nestedBody}
          </div>
        `;
      }

      const deepMessage: ParsedMessage = {
        ...baseMessage,
        decodedBody: nestedBody,
        body: nestedBody,
      };

      const replyHtml = constructReplyBody(deepMessage, 'Africa/Johannesburg');

      expect(replyHtml).toContain('id="divRplyFwdMsg"');
      expect(replyHtml).toContain('Reply level 10');
      expect(replyHtml).toContain('Original bottom message');
    });

    it('handles 100KB+ email bodies performantly', () => {
      const largeParagraph = '<p>' + 'The quick brown fox jumps over the lazy dog. '.repeat(100) + '</p>';
      const largeBody = largeParagraph.repeat(25); // ~112KB
      expect(largeBody.length).toBeGreaterThan(100_000);

      const largeMessage: ParsedMessage = {
        ...baseMessage,
        decodedBody: largeBody,
      };

      const startTime = performance.now();
      const output = constructReplyBody(largeMessage, 'UTC');
      const durationMs = performance.now() - startTime;

      expect(durationMs).toBeLessThan(100); // Must be sub-100ms
      expect(output.length).toBeGreaterThan(largeBody.length);
      expect(output).toContain('id="divRplyFwdMsg"');
    });
  });

  describe('XSS & Malicious Injection Resilience', () => {
    it('sanitizes dangerous tags in header sender names', () => {
      const maliciousMsg: ParsedMessage = {
        ...baseMessage,
        sender: {
          name: '<script>alert("XSS")</script>Evil Hacker',
          email: 'hacker@evil.com"><script>alert(1)</script>',
        },
        subject: '<img src=x onerror=alert(1)>Hacked',
      };

      const html = constructReplyBody(maliciousMsg, 'UTC');

      // Raw unescaped script tag should NOT be present in sender name/email
      expect(html).not.toContain('<script>alert("XSS")</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseAndValidateDate,
  formatMessageHeaderDate,
  formatThreadListDate,
  constructReplyBody,
  constructForwardBody,
} from '../lib/utils';
import type { ParsedMessage } from '@/types';

describe('Adversarial Outlook Parity Battery — Edge Cases & Stress Testing', () => {
  describe('Timezone & Date Parsing Adversarial Cases', () => {
    const HALF_AND_QUARTER_HOUR_TIMEZONES = [
      'Asia/Kolkata',        // UTC+5:30
      'Asia/Kathmandu',      // UTC+5:45
      'Australia/Adelaide',  // UTC+9:30 / +10:30 DST
      'Australia/Eucla',     // UTC+8:45
      'America/St_Johns',    // UTC-3:30 / -2:30 DST (Newfoundland)
      'Pacific/Chatham',     // UTC+12:45 / +13:45 DST
      'Pacific/Marquesas',   // UTC-9:30
    ];

    it('formats accurate local header dates in fractional-offset timezones', () => {
      const utcTime = '2026-09-09T12:00:00.000Z';

      // Verify each non-standard fractional timezone does not crash and formats accurately
      for (const tz of HALF_AND_QUARTER_HOUR_TIMEZONES) {
        const formatted = formatMessageHeaderDate(utcTime, tz);
        expect(formatted.display).toMatch(/\d{1,2}:\d{2}\s+(AM|PM)/);
      }

      // Asia/Kolkata is UTC+5:30 -> 17:30 (5:30 PM)
      const kolkata = formatMessageHeaderDate(utcTime, 'Asia/Kolkata');
      expect(kolkata.display).toContain('5:30 PM');

      // Asia/Kathmandu is UTC+5:45 -> 17:45 (5:45 PM)
      const kathmandu = formatMessageHeaderDate(utcTime, 'Asia/Kathmandu');
      expect(kathmandu.display).toContain('5:45 PM');

      // America/St_Johns is UTC-2:30 in September (NDT DST) -> 9:30 AM
      const newfoundland = formatMessageHeaderDate(utcTime, 'America/St_Johns');
      expect(newfoundland.display).toContain('9:30 AM');

      // Pacific/Chatham is UTC+12:45 (or +13:45 during NZDT) -> verify valid non-crashing format
      const chatham = formatMessageHeaderDate(utcTime, 'Pacific/Chatham');
      expect(chatham.display).toMatch(/\d{1,2}:\d{2}\s+(AM|PM)/);
    });

    it('handles leap day (Feb 29) across century boundary', () => {
      // 2000 was a century leap year (divisible by 400)
      const leap2000 = '2000-02-29T12:00:00.000Z';
      const parsed2000 = parseAndValidateDate(leap2000);
      expect(parsed2000).not.toBeNull();
      expect(parsed2000?.getUTCFullYear()).toBe(2000);
      expect(parsed2000?.getUTCMonth()).toBe(1); // Feb is 1
      expect(parsed2000?.getUTCDate()).toBe(29);

      const header2000 = formatMessageHeaderDate(leap2000, 'UTC');
      expect(header2000.display).toContain('2/29/2000');
    });

    it('handles ISO strings with microsecond and nanosecond precision', () => {
      const microIso = '2026-09-09T14:15:30.123456Z';
      const parsed = parseAndValidateDate(microIso);
      expect(parsed).not.toBeNull();
      expect(parsed?.getUTCHours()).toBe(14);
      expect(parsed?.getUTCMinutes()).toBe(15);
    });

    it('handles ISO strings with timezone offsets (+02:00, -04:00)', () => {
      const sastIso = '2026-09-09T16:15:00+02:00';
      const parsed = parseAndValidateDate(sastIso);
      expect(parsed).not.toBeNull();
      // 16:15 SAST is 14:15 UTC
      expect(parsed?.getUTCHours()).toBe(14);
      expect(parsed?.getUTCMinutes()).toBe(15);
    });

    it('gracefully handles garbage input without throwing or logging uncaught errors', () => {
      expect(parseAndValidateDate('')).toBeNull();
      expect(parseAndValidateDate('   ')).toBeNull();
      expect(parseAndValidateDate(null)).toBeNull();
      expect(parseAndValidateDate(undefined)).toBeNull();
      expect(parseAndValidateDate('not-a-date')).toBeNull();
      expect(parseAndValidateDate('2026-99-99T99:99:99Z')).toBeNull();

      expect(formatMessageHeaderDate('garbage').display).toBe('');
      expect(formatThreadListDate('garbage')).toBe('');
    });
  });

  describe('Quoting & Subject Prefix Normalization Adversarial Cases', () => {
    const baseMsg: ParsedMessage = {
      id: 'msg-adv-1',
      sender: { name: 'Alice Smith', email: 'alice@example.com' },
      to: [{ name: 'Bob Jones', email: 'bob@example.com' }],
      subject: 'Room Service Enquiry',
      receivedOn: '2026-09-09T14:00:00.000Z',
      decodedBody: '<p>Can I order room service?</p>',
    } as any;

    it('does not duplicate RE: prefix if message subject already starts with Re:', () => {
      const reMsg = { ...baseMsg, subject: 'Re: Room Service Enquiry' };
      const replyHtml = constructReplyBody(reMsg, 'UTC');
      expect(replyHtml).toContain('<b>Subject:</b> Re: Room Service Enquiry');
      expect(replyHtml).not.toContain('RE: Re:');
    });

    it('does not duplicate RE: prefix if subject starts with case-insensitive RE:', () => {
      const reMsg = { ...baseMsg, subject: 'rE: Room Service Enquiry' };
      const replyHtml = constructReplyBody(reMsg, 'UTC');
      expect(replyHtml).toContain('<b>Subject:</b> rE: Room Service Enquiry');
      expect(replyHtml).not.toContain('RE: rE:');
    });

    it('does not duplicate FW: prefix if forward subject already starts with FW:', () => {
      const fwMsg = { ...baseMsg, subject: 'FW: Room Service Enquiry' };
      const forwardHtml = constructForwardBody(fwMsg, 'UTC');
      expect(forwardHtml).toContain('<b>Subject:</b> FW: Room Service Enquiry');
      expect(forwardHtml).not.toContain('FW: FW:');
    });

    it('handles forward subject starting with Fwd: gracefully', () => {
      const fwdMsg = { ...baseMsg, subject: 'Fwd: Room Service Enquiry' };
      const forwardHtml = constructForwardBody(fwdMsg, 'UTC');
      // Should not create FW: Fwd: if regex handles fwd
      expect(forwardHtml).toContain('<b>Subject:</b>');
    });

    it('handles sender with special characters and quotes in name', () => {
      const specialMsg: ParsedMessage = {
        ...baseMsg,
        sender: { name: 'Dr. "Bartholomew" O\'Connor <VIP>', email: 'b.oconnor@hospitality.com' },
      } as any;

      const html = constructReplyBody(specialMsg, 'UTC');
      // Must be safely escaped
      expect(html).toContain('Dr. &quot;Bartholomew&quot; O&#39;Connor &lt;VIP&gt;');
      expect(html).toContain('&lt;b.oconnor@hospitality.com&gt;');
      expect(html).not.toContain('<script>');
    });

    it('handles identical sender name and email without redundant formatting', () => {
      const sameMsg: ParsedMessage = {
        ...baseMsg,
        sender: { name: 'guest@hotel.com', email: 'guest@hotel.com' },
      } as any;

      const html = constructReplyBody(sameMsg, 'UTC');
      // When name equals email, it should format as &lt;guest@hotel.com&gt; rather than guest@hotel.com &lt;guest@hotel.com&gt;
      expect(html).toContain('<b>From:</b> &lt;guest@hotel.com&gt;');
      expect(html).not.toContain('guest@hotel.com &lt;guest@hotel.com&gt;');
    });

    it('handles 50 recipients in To and Cc without performance cliff', () => {
      const manyTo = Array.from({ length: 50 }, (_, i) => ({
        name: `Guest Number ${i}`,
        email: `guest${i}@conference.com`,
      }));

      const manyCc = Array.from({ length: 50 }, (_, i) => ({
        name: `Organizer Number ${i}`,
        email: `organizer${i}@conference.com`,
      }));

      const heavyMsg: ParsedMessage = {
        ...baseMsg,
        to: manyTo,
        cc: manyCc,
      } as any;

      const start = performance.now();
      const html = constructReplyBody(heavyMsg, 'UTC');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50); // Under 50ms
      expect(html).toContain('guest49@conference.com');
      expect(html).toContain('organizer49@conference.com');
    });
  });
});

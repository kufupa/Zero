import { describe, expect, it } from 'vitest';
import {
  constructForwardBody,
  constructReplyBody,
  formatOutlookHeaderDate,
} from '../lib/utils';

describe('Outlook Quoting & Wire Formatter Parity', () => {
  describe('constructReplyBody', () => {
    it('generates Outlook wire format with #divRplyFwdMsg, #E1E1E1, and headers', () => {
      const html = constructReplyBody(
        '<p>hiii</p>',
        '2026-09-09T12:00:00.000Z',
        { name: 'Ansh Arora', email: 'aroransh17@gmail.com' },
        [{ name: 'Nava AI', email: 'navaai@legacyhotels.co.za' }],
        '<p>hi!!</p>',
        'Dinner reservation',
        'Africa/Johannesburg',
      );

      // Outlook wire container
      expect(html).toContain('id="divRplyFwdMsg"');
      expect(html).toContain('class="gmail_quote"');
      expect(html).toContain('border-top: 1px solid #E1E1E1');
      expect(html).toContain('<hr style="display:inline-block;width:98%" size="1">');

      // Outlook headers
      expect(html).toContain('<b>From:</b> Ansh Arora &lt;aroransh17@gmail.com&gt;');
      expect(html).toContain('<b>Sent:</b> Wednesday, September 9, 2026 2:00 PM');
      expect(html).toContain('<b>To:</b> Nava AI &lt;navaai@legacyhotels.co.za&gt;');
      expect(html).toContain('<b>Subject:</b> RE: Dinner reservation');

      // Bodies
      expect(html).toContain('<p>hiii</p>');
      expect(html).toContain('<p>hi!!</p>');
      expect(html).toContain('id="zero-quoted-content"');

      // Typography
      expect(html).toContain('font-family: Calibri, Arial, sans-serif');
      expect(html).toContain('font-size: 11pt');
    });

    it('puts the original sender email in the From header', () => {
      const html = constructReplyBody(
        '<p>hiii</p>',
        '7/23/2026, 11:33:26 AM',
        { name: 'aroransh17', email: 'aroransh17@gmail.com' },
        [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
        '<p>hi!!</p>',
      );
      expect(html).toContain('aroransh17@gmail.com');
      expect(html).toContain('<b>From:</b>');
    });

    it('uses Outlook Calibri body stack not apple-system', () => {
      const html = constructReplyBody(
        '<p>hiii</p>',
        '7/23/2026, 11:33:26 AM',
        { name: 'aroransh17', email: 'aroransh17@gmail.com' },
        [{ name: 'Nava', email: 'navaai@legacyhotels.co.za' }],
        '<p>hi!!</p>',
      );
      expect(html).toContain('nava-mail-body');
      expect(html).toContain('Calibri, Arial, sans-serif');
      expect(html).toContain('font-size: 11pt');
      expect(html).not.toContain('apple-system');
    });
  });

  describe('constructForwardBody', () => {
    it('generates FW: subject and Outlook header structure', () => {
      const html = constructForwardBody(
        '<p>fyi</p>',
        '2026-09-09T12:00:00.000Z',
        { name: 'Ann', email: 'ann@x.com', subject: 'Hello' },
        [{ email: 'bob@x.com' }],
        '<p>original body</p>',
        'Hello',
        'Africa/Johannesburg',
      );

      expect(html).toContain('id="divRplyFwdMsg"');
      expect(html).toContain('<b>From:</b> Ann &lt;ann@x.com&gt;');
      expect(html).toContain('<b>Subject:</b> FW: Hello');
      expect(html).toContain('<p>original body</p>');
      expect(html).toContain('<p>fyi</p>');
    });
  });

  describe('formatOutlookHeaderDate', () => {
    it('formats dates in full weekday, month, day, year and time', () => {
      const formatted = formatOutlookHeaderDate('2026-09-09T12:00:00.000Z', 'Africa/Johannesburg');
      expect(formatted).toBe('Wednesday, September 9, 2026 2:00 PM');
    });
  });
});

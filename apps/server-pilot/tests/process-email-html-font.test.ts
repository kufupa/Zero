import { describe, expect, it } from 'vitest';
import { processEmailHtmlForDisplay } from '../src/mail/process-email-html.js';
import { MAIL_BODY_FONT_FAMILY } from '../src/mail/mail-body-typography.js';

describe('processEmailHtmlForDisplay font default', () => {
  it('prepends Calibri display CSS after sanitize', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<p class="MsoNormal" style="font-family:Calibri">Hello</p><script>alert(1)</script>',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });
    expect(processedHtml).toContain('data-nava-mail-font');
    expect(processedHtml).toContain(MAIL_BODY_FONT_FAMILY);
    expect(processedHtml).not.toContain('<script');
    expect(processedHtml).not.toMatch(/style="font-family:Calibri"/);
  });
});

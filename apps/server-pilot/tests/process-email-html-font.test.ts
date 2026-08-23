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

  it('retains a white legacy canvas while stripping authored colors', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<table bgcolor="#ffffff" style="background-color:#000000"><tr><td><span style="color:#ffffff">Readable</span></td></tr></table>',
      messageId: 'msg-legacy',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });

    expect(processedHtml).toContain('bgcolor="#ffffff"');
    expect(processedHtml).not.toContain('background-color:#000000');
    expect(processedHtml).not.toContain('color:#ffffff');
  });

  it('renders collapsed quotes with light-paper controls', () => {
    const { processedHtml } = processEmailHtmlForDisplay({
      html: '<blockquote><p>Quoted reply</p></blockquote>',
      messageId: 'msg-quote',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://example.test',
      attachments: [],
    });

    expect(processedHtml).toContain('background: #ffffff');
    expect(processedHtml).toContain('outline: 2px solid #71717a');
    expect(processedHtml).not.toContain('#313131');
  });
});

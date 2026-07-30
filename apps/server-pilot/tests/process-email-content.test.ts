import { describe, expect, it } from 'vitest';
import { processEmailHtmlForDisplay } from '../src/mail/process-email-html.js';

describe('processEmailHtmlForDisplay', () => {
  it('projects cid after sanitize when messageId in scope', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img src="cid:banner001@rocketseed">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [
        {
          attachmentId: 'att-1',
          contentId: '<banner001@rocketseed>',
          mimeType: 'image/gif',
          sizeBytes: 10,
        },
      ],
    });
    expect(result.processedHtml).toContain('/attachments/att-1/inline');
    expect(result.processedHtml).not.toContain('cid:');
  });

  it('keeps remote https blocked when shouldLoadImages false', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img src="https://tracker.example/x.gif">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [],
    });
    expect(result.hasBlockedImages).toBe(true);
    expect(result.processedHtml).not.toContain('tracker.example');
  });

  it('does not re-sanitize projected cid https urls with images off', async () => {
    const result = await processEmailHtmlForDisplay({
      html: '<img alt="b" src="cid:banner001@rocketseed">',
      messageId: 'msg-1',
      shouldLoadImages: false,
      theme: 'light',
      origin: 'https://nava.legacy.local',
      attachments: [
        {
          attachmentId: 'att-1',
          contentId: '<banner001@rocketseed>',
          mimeType: 'image/gif',
          sizeBytes: 10,
        },
      ],
    });
    expect(result.processedHtml).toContain(
      'https://nava.legacy.local/api/mail/messages/msg-1/attachments/att-1/inline',
    );
  });
});

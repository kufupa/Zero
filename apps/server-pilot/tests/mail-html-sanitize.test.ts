import { describe, expect, it } from 'vitest';
import { sanitizeHtmlBodyForStorage } from '../src/mail/sanitize-email-html.js';
import { toParsedMessage } from '../src/trpc/wire-compat.js';

describe('mail html sanitize serving path', () => {
  it('strips script and onerror handlers from processedHtml', () => {
    const malicious = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const parsed = toParsedMessage({
      id: 'm1',
      transportId: 't1',
      threadId: 'th1',
      direction: 'inbound',
      fromAddress: 'a@b.com',
      toAddresses: ['c@d.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'x',
      textBody: null,
      htmlBody: malicious,
      messageIdHeader: null,
      inReplyTo: null,
      references: [],
      isRead: true,
      isStarred: false,
      receivedAt: new Date(),
      sentAt: null,
      ingestMailboxId: null,
      pop3Uidl: null,
      ownerHeaderValue: null,
      rawMimeS3Key: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(parsed.processedHtml).not.toContain('<script');
    expect(parsed.processedHtml).not.toMatch(/onerror/i);
  });

  it('removes style tags from processedHtml', () => {
    const css = '<style>body{background:url(http://evil)}</style><p>hi</p>';
    const parsed = toParsedMessage({
      id: 'm2',
      transportId: 't1',
      threadId: 'th1',
      direction: 'inbound',
      fromAddress: 'a@b.com',
      toAddresses: ['c@d.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'x',
      textBody: null,
      htmlBody: css,
      messageIdHeader: null,
      inReplyTo: null,
      references: [],
      isRead: true,
      isStarred: false,
      receivedAt: new Date(),
      sentAt: null,
      ingestMailboxId: null,
      pop3Uidl: null,
      ownerHeaderValue: null,
      rawMimeS3Key: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(parsed.processedHtml).not.toContain('<style');
    expect(parsed.processedHtml).toContain('hi');
  });

  it('toParsedMessage stays safe when htmlBody was pre-sanitized at ingest', () => {
    const malicious = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const stored = sanitizeHtmlBodyForStorage(malicious)!;
    const parsed = toParsedMessage({
      id: 'm3',
      transportId: 't1',
      threadId: 'th1',
      direction: 'inbound',
      fromAddress: 'a@b.com',
      toAddresses: ['c@d.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'x',
      textBody: null,
      htmlBody: stored,
      messageIdHeader: null,
      inReplyTo: null,
      references: [],
      isRead: true,
      isStarred: false,
      receivedAt: new Date(),
      sentAt: null,
      ingestMailboxId: null,
      pop3Uidl: null,
      ownerHeaderValue: null,
      rawMimeS3Key: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(parsed.processedHtml).not.toContain('<script');
    expect(parsed.processedHtml).not.toMatch(/onerror/i);
  });

  it('toParsedMessage keeps remote https img src in decodedBody', () => {
    const remote =
      '<p><img src="https://branding.legacyhotels.co.za/x.gif"><script>alert(1)</script></p>';
    const parsed = toParsedMessage({
      id: 'm4',
      transportId: 't1',
      threadId: 'th1',
      direction: 'inbound',
      fromAddress: 'a@b.com',
      toAddresses: ['c@d.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'x',
      textBody: null,
      htmlBody: remote,
      messageIdHeader: null,
      inReplyTo: null,
      references: [],
      isRead: true,
      isStarred: false,
      receivedAt: new Date(),
      sentAt: null,
      ingestMailboxId: null,
      pop3Uidl: null,
      ownerHeaderValue: null,
      rawMimeS3Key: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(parsed.decodedBody).toContain('src="https://branding.legacyhotels.co.za/x.gif"');
    expect(parsed.processedHtml).toContain('src="https://branding.legacyhotels.co.za/x.gif"');
    expect(parsed.processedHtml).not.toContain('<script');
  });
});

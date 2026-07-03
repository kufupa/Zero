import { describe, expect, it } from 'vitest';
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
});

import { describe, expect, it } from 'vitest';
import {
  buildOutboundHeaderPreview,
  canShowHeaderDebug,
  NAVA_TRANSPORT_ID,
} from '@/lib/mail/header-debug';

describe('header debug helpers', () => {
  it('allows only the Nava transport', () => {
    expect(canShowHeaderDebug(NAVA_TRANSPORT_ID)).toBe(true);
    expect(canShowHeaderDebug('transport-centurion')).toBe(false);
    expect(canShowHeaderDebug(null)).toBe(false);
  });

  it('builds deterministic outbound routing and threading preview lines', () => {
    expect(
      buildOutboundHeaderPreview({
        transportEmail: 'nava@legacyhotel.com',
        messageId: 'smtp-1@example.com',
        inReplyTo: 'parent@example.com',
        references: 'root@example.com parent@example.com',
      }),
    ).toEqual([
      { key: 'x-zero-mailbox', line: 'X-Zero-Mailbox: nava@legacyhotel.com' },
      { key: 'message-id', line: 'Message-ID: smtp-1@example.com' },
      { key: 'in-reply-to', line: 'In-Reply-To: parent@example.com' },
      { key: 'references', line: 'References: root@example.com parent@example.com' },
    ]);
  });
});

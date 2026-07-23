import { describe, expect, it } from 'vitest';
import { resolveReplyHeaders } from '../src/mail/send/resolve-reply-headers';

describe('resolveReplyHeaders (no DB)', () => {
  const older = {
    messageIdHeader: '<old@x>',
    references: ['inbound-msg-id-1'],
  };
  const newer = {
    messageIdHeader: '<new@x>',
    references: ['inbound-msg-id-1', '<old@x>'],
  };

  it('uses older selected Message-ID for In-Reply-To (not newer latest)', () => {
    const headers = resolveReplyHeaders({
      selectedMessage: older,
      explicitInReplyTo: '<explicit@x>',
      explicitReferences: ['<root@x>'],
      latestThreadPrior: newer,
    });
    expect(headers.inReplyTo).toBe('<old@x>');
    expect(headers.references).toContain('<old@x>');
    expect(headers.inReplyTo).not.toBe('<new@x>');
  });

  it('uses explicit inReplyTo when no selected message', () => {
    const headers = resolveReplyHeaders({
      selectedMessage: null,
      explicitInReplyTo: '<explicit@x>',
      explicitReferences: ['<root@x>', '<explicit@x>'],
      latestThreadPrior: newer,
    });
    expect(headers.inReplyTo).toBe('<explicit@x>');
    expect(headers.references).toEqual(['<root@x>', '<explicit@x>']);
  });

  it('falls back to latest-thread prior when neither selected nor explicit', () => {
    const headers = resolveReplyHeaders({
      selectedMessage: null,
      explicitInReplyTo: null,
      latestThreadPrior: newer,
    });
    expect(headers.inReplyTo).toBe('<new@x>');
    expect(headers.references).toContain('<new@x>');
  });
});

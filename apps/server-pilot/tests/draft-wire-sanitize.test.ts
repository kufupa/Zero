import { describe, expect, it } from 'vitest';
import type { mailDraft } from '../src/db/schema/mail.js';
import { toDraftWire } from '../src/trpc/routes/draft-wire.js';

const MALICIOUS = '<script>alert(1)</script><p>draft</p>';

function draftRow(
  overrides: Partial<typeof mailDraft.$inferSelect>,
): typeof mailDraft.$inferSelect {
  return {
    id: 'draft-1',
    transportId: 'transport-centurion',
    threadId: 'thread-1',
    createdByUserId: 'user-manager',
    toAddresses: [],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'Re: test',
    textBody: null,
    htmlBody: MALICIOUS,
    attachments: [],
    isSent: false,
    status: 'active',
    origin: 'ai',
    replyToMessageId: null,
    generationId: null,
    sentMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('toDraftWire htmlBody fallback', () => {
  it('sanitizes htmlBody when textBody is null', () => {
    const wire = toDraftWire(draftRow({ textBody: null, htmlBody: MALICIOUS }));
    expect(wire.content).not.toContain('<script');
    expect(wire.content).toContain('draft');
  });

  it('does not sanitize textBody when present', () => {
    const userHtml = '<p class="tiptap">user</p>';
    const wire = toDraftWire(
      draftRow({ textBody: userHtml, htmlBody: MALICIOUS }),
    );
    expect(wire.content).toBe(userHtml);
  });
});

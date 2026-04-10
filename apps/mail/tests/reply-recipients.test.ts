import { describe, expect, it } from 'vitest';
import { deriveReplyRecipients } from '../lib/mail/reply-recipients';

describe('deriveReplyRecipients', () => {
  it('sets reply recipient to sender when sender is not the current user', () => {
    const recipients = deriveReplyRecipients({
      mode: 'reply',
      excludedEmails: ['me@example.com'],
      message: {
        sender: { email: 'sender@example.com' },
        to: [{ email: 'me@example.com' }],
      },
    });

    expect(recipients).toEqual({
      to: ['sender@example.com'],
      cc: [],
    });
  });

  it('falls back to first non-self original to recipient when replying to own sent message', () => {
    const recipients = deriveReplyRecipients({
      mode: 'reply',
      excludedEmails: ['me@example.com'],
      message: {
        sender: { email: 'me@example.com' },
        to: [{ email: 'me@example.com' }, { email: 'teammate@example.com' }],
      },
    });

    expect(recipients).toEqual({
      to: ['teammate@example.com'],
      cc: [],
    });
  });

  it('builds reply-all recipients deterministically without self or duplicates', () => {
    const recipients = deriveReplyRecipients({
      mode: 'replyAll',
      excludedEmails: ['me@example.com'],
      message: {
        sender: { email: 'sender@example.com' },
        to: [
          { email: 'me@example.com' },
          { email: 'teammate@example.com' },
          { email: 'SENDER@example.com' },
          { email: 'teammate@example.com' },
        ],
        cc: [
          { email: 'me@example.com' },
          { email: 'observer@example.com' },
          { email: 'Teammate@example.com' },
          { email: 'observer@example.com' },
        ],
      },
    });

    expect(recipients).toEqual({
      to: ['sender@example.com', 'teammate@example.com'],
      cc: ['observer@example.com'],
    });
  });

  it('returns empty recipients for forward mode', () => {
    const recipients = deriveReplyRecipients({
      mode: 'forward',
      excludedEmails: ['me@example.com'],
      message: {
        sender: { email: 'sender@example.com' },
        to: [{ email: 'me@example.com' }],
      },
    });

    expect(recipients).toEqual({
      to: [],
      cc: [],
    });
  });
});

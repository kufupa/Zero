import { describe, expect, it } from 'vitest';
import { getStaleDraftRetryInput, isStaleDraftConflict } from '../lib/mail/draft-persistence';

describe('stale draft send flow', () => {
  it('recognizes server stale draft conflicts', () => {
    expect(isStaleDraftConflict({ data: { code: 'CONFLICT' }, message: 'STALE_DRAFT' })).toBe(true);
    expect(isStaleDraftConflict({ data: { code: 'BAD_REQUEST' }, message: 'STALE_DRAFT' })).toBe(false);
  });

  it('does not treat STALE_AI_DRAFT as confirmable stale conflict', () => {
    expect(isStaleDraftConflict({ data: { code: 'CONFLICT' }, message: 'STALE_AI_DRAFT' })).toBe(
      false,
    );
    expect(
      isStaleDraftConflict({ data: { code: 'CONFLICT' }, message: 'STALE_AI_CANDIDATE' }),
    ).toBe(false);
  });

  it('retries the same send input with explicit stale confirmation', () => {
    expect(
      getStaleDraftRetryInput({
        threadId: 'thread-1',
        draftId: 'draft-1',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: Booking',
        message: '<p>Reply</p>',
      }),
    ).toMatchObject({
      threadId: 'thread-1',
      draftId: 'draft-1',
      confirmStaleDraft: true,
    });
  });
});

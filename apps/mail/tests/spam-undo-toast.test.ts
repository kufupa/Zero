import { describe, expect, it } from 'vitest';
import { buildSpamUndoToastMessage } from '../lib/mail/spam-undo-toast';

describe('spam undo toast', () => {
  it('uses movedToSpam copy for single thread without block preference', () => {
    expect(buildSpamUndoToastMessage(1, [])).toBe('Moved to spam');
  });

  it('mentions sender block when moveThreads returned block preferences', () => {
    expect(
      buildSpamUndoToastMessage(1, [{ email: 'spammer@example.com', kind: 'block' }]),
    ).toBe('Moved to spam and sender blocked');
  });

  it('appends bulk count for multi-select spam', () => {
    expect(
      buildSpamUndoToastMessage(3, [{ email: 'spammer@example.com', kind: 'block' }]),
    ).toBe('Moved to spam and sender blocked (3 items)');
  });
});

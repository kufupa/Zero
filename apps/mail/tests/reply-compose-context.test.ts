import { describe, expect, it, vi } from 'vitest';
import { clearReplyComposeContext, openReplyComposeContext } from '../lib/mail/reply-compose-context';

describe('reply compose context helpers', () => {
  it('opens reply compose context and clears previous draft affinity', async () => {
    const setMode = vi.fn();
    const setActiveReplyId = vi.fn();
    const setDraftId = vi.fn();

    await openReplyComposeContext({
      mode: 'replyAll',
      messageId: 'message-123',
      setMode,
      setActiveReplyId,
      setDraftId,
    });

    expect(setDraftId).toHaveBeenCalledWith(null);
    expect(setMode).toHaveBeenCalledWith('replyAll');
    expect(setActiveReplyId).toHaveBeenCalledWith('message-123');
  });

  it('normalizes empty message ids to null when opening compose context', async () => {
    const setMode = vi.fn();
    const setActiveReplyId = vi.fn();
    const setDraftId = vi.fn();

    await openReplyComposeContext({
      mode: 'reply',
      messageId: '   ',
      setMode,
      setActiveReplyId,
      setDraftId,
    });

    expect(setActiveReplyId).toHaveBeenCalledWith(null);
  });

  it('clears mode, reply target, and draft affinity together', async () => {
    const setMode = vi.fn();
    const setActiveReplyId = vi.fn();
    const setDraftId = vi.fn();

    await clearReplyComposeContext({
      setMode,
      setActiveReplyId,
      setDraftId,
    });

    expect(setMode).toHaveBeenCalledWith(null);
    expect(setActiveReplyId).toHaveBeenCalledWith(null);
    expect(setDraftId).toHaveBeenCalledWith(null);
  });
});

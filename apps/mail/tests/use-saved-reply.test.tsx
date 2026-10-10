/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVED_REPLY_REFRESH_MS, useSavedReply } from '@/components/nava-pane/use-saved-reply';

afterEach(() => vi.useRealTimers());

const reply = (html: string) => ({ html, attachments: [{ fileName: 'Quotation.pdf', pdfBase64: 'JVBERi0=' }] });

describe('useSavedReply', () => {
  it('reads the saved reply at the click, so a reply replaced in webmail is the one inserted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stored = reply('<p>First</p>');
    const read = vi.fn(async () => stored);
    const { result } = renderHook(() => useSavedReply(read, 'thread-1'));
    await act(async () => {});
    expect(result.current.available).toBe(true);

    stored = reply('<p>Replaced in webmail</p>');
    let current: Awaited<ReturnType<typeof result.current.readCurrent>> = null;
    await act(async () => {
      current = await result.current.readCurrent();
    });
    expect(current).toEqual(reply('<p>Replaced in webmail</p>'));
  });

  it('shows Insert once webmail saves a reply while the thread stays open, and hides it once removed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let stored: ReturnType<typeof reply> | null = null;
    const read = vi.fn(async () => stored);
    const { result } = renderHook(() => useSavedReply(read, 'thread-1'));
    await act(async () => {});
    expect(result.current.available).toBe(false);

    stored = reply('<p>Saved later</p>');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_REPLY_REFRESH_MS);
    });
    expect(result.current.available).toBe(true);

    stored = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVED_REPLY_REFRESH_MS);
    });
    expect(result.current.available).toBe(false);
  });

  it('reads nothing without a thread', async () => {
    const read = vi.fn(async () => reply('<p>x</p>'));
    const { result } = renderHook(() => useSavedReply(read, null));
    await act(async () => {});
    expect(result.current.available).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});

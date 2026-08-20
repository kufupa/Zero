import { describe, expect, it } from 'vitest';
import {
  resolveComposeEscapeAction,
  resolveOpenThreadId,
  shouldBlankOpenThreadData,
  shouldShowOpenThreadSkeleton,
} from '../lib/mail/thread-open-stability';

describe('resolveOpenThreadId', () => {
  it('prefers response thread id over message ids', () => {
    expect(
      resolveOpenThreadId({
        id: 'thread-1',
        latest: { id: 'message-9', threadId: 'thread-1' },
        messages: [{ threadId: 'thread-1' }],
      }),
    ).toBe('thread-1');
  });

  it('uses latest.threadId when response id absent', () => {
    expect(
      resolveOpenThreadId({
        latest: { id: 'message-9', threadId: 'thread-2' },
      }),
    ).toBe('thread-2');
  });

  it('never falls back to message id (false mismatch / compose unmount)', () => {
    expect(
      resolveOpenThreadId({
        latest: { id: 'message-only', threadId: null },
        messages: [{ threadId: null }],
      }),
    ).toBeUndefined();
  });
});

describe('shouldBlankOpenThreadData', () => {
  it('blanks only on positive thread-id mismatch', () => {
    expect(
      shouldBlankOpenThreadData({
        requestedThreadId: 'thread-a',
        resolvedThreadId: 'thread-b',
      }),
    ).toBe(true);
  });

  it('keeps data when resolved id unknown (avoid compose kick-out)', () => {
    expect(
      shouldBlankOpenThreadData({
        requestedThreadId: 'thread-a',
        resolvedThreadId: undefined,
      }),
    ).toBe(false);
  });
});

describe('shouldShowOpenThreadSkeleton', () => {
  it('does not skeleton-unmount a loaded thread during refetch', () => {
    expect(
      shouldShowOpenThreadSkeleton({
        hasEmailData: true,
        isLoading: false,
        isFetching: true,
        isThreadDataMismatch: false,
      }),
    ).toBe(false);
  });

  it('shows skeleton on first load with no data', () => {
    expect(
      shouldShowOpenThreadSkeleton({
        hasEmailData: false,
        isLoading: true,
        isFetching: true,
        isThreadDataMismatch: false,
      }),
    ).toBe(true);
  });

  it('shows skeleton when fetching mismatched thread with no retained data', () => {
    expect(
      shouldShowOpenThreadSkeleton({
        hasEmailData: false,
        isLoading: false,
        isFetching: true,
        isThreadDataMismatch: true,
      }),
    ).toBe(true);
  });
});

describe('resolveComposeEscapeAction', () => {
  it('ignores Escape while IME is composing', () => {
    expect(
      resolveComposeEscapeAction({
        isComposing: true,
        hasUnsavedChanges: false,
        initialHtml: '',
        html: '<p>hello</p>',
        text: 'hello',
        to: ['a@b.com'],
        subject: 'Re: x',
        aiBlocked: false,
      }),
    ).toBe('ignore');
  });

  it('prompts when body has text even after autosave cleared dirty', () => {
    expect(
      resolveComposeEscapeAction({
        isComposing: false,
        hasUnsavedChanges: false,
        initialHtml: '<p>hello</p>',
        html: '<p>hello</p>',
        text: 'hello',
        to: ['a@b.com'],
        subject: 'Re: x',
        aiBlocked: false,
      }),
    ).toBe('prompt');
  });

  it('closeSilent for empty composer', () => {
    expect(
      resolveComposeEscapeAction({
        isComposing: false,
        hasUnsavedChanges: false,
        initialHtml: '',
        html: '<p></p>',
        text: '',
        to: [],
        subject: '',
        aiBlocked: false,
      }),
    ).toBe('closeSilent');
  });
});

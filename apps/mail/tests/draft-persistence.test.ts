import { describe, expect, it } from 'vitest';
import {
  buildDraftMutationInput,
  chooseDraftEditorState,
  nextAfterDialogChoice,
  resolveComposeCloseAction,
  runComposeLeaveFlush,
  shouldEnsureEditableDraftForReply,
  shouldPersistDraft,
} from '../lib/mail/draft-persistence';

describe('draft persistence', () => {
  it('persists partial draft bodies before recipients or subject exist', () => {
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>Need to answer guest about late checkout</p>',
        text: 'Need to answer guest about late checkout',
        to: [],
        subject: '',
        aiBlocked: false,
      }),
    ).toBe(true);
  });

  it('does not persist unchanged or AI-owned transient content', () => {
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: false,
        initialHtml: '<p>Same</p>',
        html: '<p>Same</p>',
        text: 'Same',
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        aiBlocked: false,
      }),
    ).toBe(false);
    expect(
      shouldPersistDraft({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>AI pending</p>',
        text: 'AI pending',
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        aiBlocked: true,
      }),
    ).toBe(false);
  });

  it('includes thread and reply parent when saving a reply draft', () => {
    expect(
      buildDraftMutationInput({
        draftId: 'draft-1',
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        subject: 'Re: Booking',
        html: '<p>Reply text</p>',
        fromEmail: 'nava@example.com',
        attachments: [],
      }),
    ).toMatchObject({
      id: 'draft-1',
      threadId: 'thread-1',
      replyToMessageId: 'msg-2',
      to: 'guest@example.com',
      subject: 'Re: Booking',
      body: '<p>Reply text</p>',
    });
  });

  it('does not overwrite dirty local editor state with late server data', () => {
    const result = chooseDraftEditorState({
      isDirty: true,
      localHtml: '<p>Human typed after load</p>',
      localSubject: 'Local subject',
      serverDraft: {
        content: '<p>Older server draft</p>',
        subject: 'Server subject',
        updatedAt: '2026-07-06T10:00:00.000Z',
      },
    });

    expect(result).toEqual({
      html: '<p>Human typed after load</p>',
      subject: 'Local subject',
      source: 'local-dirty',
    });
  });

  it('requests AI candidate promotion only when editor opens without an active draft', () => {
    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({
      shouldEnsure: true,
      threadId: 'thread-1',
      replyToMessageId: 'msg-2',
    });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: 'draft-active',
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: true,
        threadId: 'thread-1',
        replyToMessageId: 'msg-2',
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });

    expect(
      shouldEnsureEditableDraftForReply({
        demoMode: false,
        threadId: 'thread-1',
        replyToMessageId: null,
        activeDraftId: null,
        aiCandidateCount: 1,
      }),
    ).toEqual({ shouldEnsure: false });
  });
});

describe('resolveComposeCloseAction', () => {
  const dirtyBody = {
    hasUnsavedChanges: true,
    initialHtml: '',
    html: '<p>Thanks</p>',
    text: 'Thanks',
    to: [] as string[],
    subject: '',
    aiBlocked: false,
  };

  it('prompts on userClose when content is persistable', () => {
    expect(resolveComposeCloseAction({ ...dirtyBody, intent: 'userClose' })).toBe('prompt');
  });

  it('flushAndLeave on threadSwitch when content is persistable', () => {
    expect(resolveComposeCloseAction({ ...dirtyBody, intent: 'threadSwitch' })).toBe(
      'flushAndLeave',
    );
  });

  it('closeSilent when whitespace-only and no subject/to', () => {
    expect(
      resolveComposeCloseAction({
        hasUnsavedChanges: true,
        initialHtml: '',
        html: '<p>   </p>',
        text: '   ',
        to: [],
        subject: '',
        aiBlocked: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });

  it('closeSilent when html unchanged from initial (quoted reply only)', () => {
    expect(
      resolveComposeCloseAction({
        hasUnsavedChanges: true,
        initialHtml: '<p>Quoted</p>',
        html: '<p>Quoted</p>',
        text: 'Quoted',
        to: [],
        subject: '',
        aiBlocked: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });

  it('closeSilent when not dirty', () => {
    expect(
      resolveComposeCloseAction({
        ...dirtyBody,
        hasUnsavedChanges: false,
        intent: 'userClose',
      }),
    ).toBe('closeSilent');
  });
});

describe('nextAfterDialogChoice', () => {
  it('maps keepEditing / saveDraft / discard', () => {
    expect(nextAfterDialogChoice('keepEditing')).toBe('dismiss');
    expect(nextAfterDialogChoice('saveDraft')).toBe('saveThenClose');
    expect(nextAfterDialogChoice('discard')).toBe('discardThenClose');
  });
});

describe('runComposeLeaveFlush', () => {
  it('awaits flush then clear', async () => {
    const order: string[] = [];
    await runComposeLeaveFlush(
      async () => {
        order.push('flush');
      },
      () => {
        order.push('clear');
      },
    );
    expect(order).toEqual(['flush', 'clear']);
  });

  it('still clears when flush rejects', async () => {
    const order: string[] = [];
    await runComposeLeaveFlush(
      async () => {
        order.push('flush');
        throw new Error('save failed');
      },
      () => {
        order.push('clear');
      },
    );
    expect(order).toEqual(['flush', 'clear']);
  });

  it('clears when flush is null', async () => {
    let cleared = false;
    await runComposeLeaveFlush(null, () => {
      cleared = true;
    });
    expect(cleared).toBe(true);
  });
});

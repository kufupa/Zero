import { describe, expect, it } from 'vitest';
import { buildThreadDraftViewModel } from '../lib/mail/thread-draft-view-model';
import type { ParsedDraft } from '@zero/server/driver/types';
import type { ParsedMessage } from '@/types';

function draftMsg(partial: Partial<ParsedMessage> & Pick<ParsedMessage, 'id'>): ParsedMessage {
  return {
    title: '',
    subject: 'Subj',
    tags: [],
    sender: { email: 'a@b.c' },
    to: [],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: '2026-04-13T18:28:00.000Z',
    unread: false,
    body: '<p>Hi all</p>',
    processedHtml: '',
    blobUrl: '',
    isDraft: true,
    ...partial,
  };
}

function pilotDraft(partial: Partial<ParsedDraft> & Pick<ParsedDraft, 'id'>): ParsedDraft {
  return {
    threadId: 'thread-1',
    replyToMessageId: 'msg-1',
    to: [],
    cc: [],
    bcc: [],
    subject: 'Pilot subj',
    content: '<p>Pilot body</p>',
    updatedAt: '2026-07-06T12:00:00.000Z',
    status: 'active',
    origin: 'manual',
    generationId: null,
    isStale: false,
    ...partial,
  };
}

describe('buildThreadDraftViewModel', () => {
  it('returns null when no draft', () => {
    expect(buildThreadDraftViewModel(undefined)).toBeNull();
  });

  it('returns null when isDraft false', () => {
    expect(buildThreadDraftViewModel(draftMsg({ id: 'x', isDraft: false }))).toBeNull();
  });

  it('builds preview and saved label input from demo message draft', () => {
    const vm = buildThreadDraftViewModel(draftMsg({ id: 'd1', decodedBody: '<p>Hi</p>' }));
    expect(vm?.id).toBe('d1');
    expect(vm?.subject).toBe('Subj');
    expect(vm?.bodyPreview).toBe('Hi');
    expect(vm?.savedAtIso).toBe('2026-04-13T18:28:00');
    expect(vm?.origin).toBe('manual');
    expect(vm?.status).toBe('active');
    expect(vm?.isStale).toBe(false);
  });

  it('builds preview from pilot ParsedDraft', () => {
    const vm = buildThreadDraftViewModel(
      pilotDraft({ id: 'pd1', content: '<p>AI reply</p>', origin: 'ai', status: 'candidate' }),
    );
    expect(vm?.id).toBe('pd1');
    expect(vm?.subject).toBe('Pilot subj');
    expect(vm?.bodyPreview).toBe('AI reply');
    expect(vm?.savedAtIso).toBe('2026-07-06T12:00:00');
    expect(vm?.origin).toBe('ai');
    expect(vm?.status).toBe('candidate');
    expect(vm?.isStale).toBe(false);
  });
});

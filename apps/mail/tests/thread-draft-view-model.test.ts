import { describe, expect, it } from 'vitest';
import { buildThreadDraftViewModel } from '../lib/mail/thread-draft-view-model';
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

describe('buildThreadDraftViewModel', () => {
  it('returns null when no draft', () => {
    expect(buildThreadDraftViewModel(undefined)).toBeNull();
  });

  it('returns null when isDraft false', () => {
    expect(buildThreadDraftViewModel(draftMsg({ id: 'x', isDraft: false }))).toBeNull();
  });

  it('builds preview and saved label input', () => {
    const vm = buildThreadDraftViewModel(draftMsg({ id: 'd1', decodedBody: '<p>Hi</p>' }));
    expect(vm?.id).toBe('d1');
    expect(vm?.subject).toBe('Subj');
    expect(vm?.bodyPreview).toBe('Hi');
    expect(vm?.savedAtIso).toBe('2026-04-13T18:28:00');
  });
});

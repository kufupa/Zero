import {
  buildThreadDraftViewModel,
  canRefreshHmsCandidate,
  hmsCandidateNotice,
} from '../lib/mail/thread-draft-view-model';
import type { ParsedDraft } from '@zero/server/driver/types';
import { describe, expect, it } from 'vitest';
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

  it('maps stale HMS candidate to Refresh-capable view model', () => {
    const vm = buildThreadDraftViewModel(
      pilotDraft({ id: 'pd2', origin: 'ai', status: 'candidate', content: '<p>Old</p>' }),
      {
        outcome: 'candidate',
        freshness: 'stale_evidence',
        activeRun: null,
        unresolvedFields: [],
      },
    );
    expect(vm).toMatchObject({
      freshness: 'stale_evidence',
      refreshState: 'idle',
      isStale: true,
      aiOutcome: 'candidate',
    });
    expect(hmsCandidateNotice(vm!)).toContain('Refresh');
    expect(canRefreshHmsCandidate(vm)).toBe(true);
  });

  it('maps running Refresh to pending disabled refresh', () => {
    const vm = buildThreadDraftViewModel(
      pilotDraft({ id: 'pd3', origin: 'ai', status: 'candidate' }),
      {
        outcome: 'candidate',
        freshness: 'fresh',
        activeRun: { id: 'run-1', state: 'running' },
        unresolvedFields: [],
      },
    );
    expect(vm?.refreshState).toBe('running');
    expect(hmsCandidateNotice(vm!)).toContain('Refreshing');
    expect(canRefreshHmsCandidate(vm)).toBe(false);
  });

  it('maps needs_clarification outcome', () => {
    const vm = buildThreadDraftViewModel(
      pilotDraft({ id: 'pd4', origin: 'ai', status: 'candidate' }),
      {
        outcome: 'needs_clarification',
        freshness: 'unknown',
        activeRun: null,
        unresolvedFields: ['evidence'],
      },
    );
    expect(vm?.aiOutcome).toBe('needs_clarification');
    expect(vm?.unresolvedFields).toEqual(['evidence']);
    expect(hmsCandidateNotice(vm!)).toContain('clarification');
  });
});
it('blocks required unavailable artifacts and preserves human attachment hydration ownership', () => {
  const vm = buildThreadDraftViewModel(
    pilotDraft({
      id: 'generated',
      origin: 'ai',
      attachments: [
        {
          artifactRef: 'generated:q',
          filename: 'quote.pdf',
          state: 'missing',
          sourceHash: 'a'.repeat(64),
        },
      ],
    } as any),
  );
  expect(vm?.readinessLabel).toBe('Attachment unavailable');
});
it('preserves task review details from the server even when attachment readiness needs review',()=>{
 const tasks=[{label:'Prepare new booking',state:'Pending staff action',details:['Room 1 · Alex Example · ZAR 262.00']}];
 const vm=buildThreadDraftViewModel(pilotDraft({id:'review',origin:'ai',reviewSummary:{readinessLabel:'Pending staff action',reason:'Staff must complete the booking.',tasks,pricingProof:[]},attachments:[{artifactRef:'generated:q',filename:'quote.pdf',state:'missing'}]} as any));
 expect(vm?.tasks).toEqual(tasks);expect(vm?.readinessLabel).toBe('Attachment unavailable');
});

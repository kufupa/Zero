import {
  PRIMARY_BUCKETS,
  reduceMailBaseline,
  type MailBaselineEvidence,
} from '../src/metrics/mail-baseline.js';
import { resolveTriageEventClock } from '../src/ai/triage-input.js';
import { describe, expect, it } from 'vitest';

const CUTOFF = '2026-09-08T12:00:00.000Z';
const T0 = '2026-09-01T00:00:00.000Z';

function evidence(
  overrides: Partial<MailBaselineEvidence> & Pick<MailBaselineEvidence, 'id' | 'askId'>,
): MailBaselineEvidence {
  return {
    requestId: 'request-1',
    threadId: 'thread-1',
    transportId: 'transport-centurion',
    eventType: 'ask',
    direction: 'inbound',
    eventAt: '2026-09-02T09:00:00.000Z',
    observedAt: '2026-09-02T09:01:00.000Z',
    source: 'mail_event',
    sourceBasis: 'source_event',
    requiresHotelResponse: false,
    requiresCustomerInformation: false,
    answerState: null,
    workState: 'unknown',
    substantive: false,
    linkStrength: 'thread',
    delivery: null,
    ...overrides,
  };
}

describe('mail baseline reducer', () => {
  it('keeps source-event and sender-estimate clocks distinct', () => {
    expect(
      resolveTriageEventClock({
        id: 'inbound-1',
        from: 'guest@example.com',
        body: 'x',
        direction: 'inbound',
        createdAt: new Date('2026-09-02T09:05:00.000Z'),
        receivedAt: new Date('2026-09-02T09:00:00.000Z'),
        sentAt: null,
      }),
    ).toMatchObject({
      at: new Date('2026-09-02T09:00:00.000Z'),
      basis: 'sender_timestamp_estimate',
    });
    expect(
      resolveTriageEventClock({
        id: 'outbound-1',
        from: 'staff@example.com',
        body: 'x',
        direction: 'outbound',
        createdAt: new Date('2026-09-02T10:05:00.000Z'),
        receivedAt: null,
        sentAt: new Date('2026-09-02T10:00:00.000Z'),
      }),
    ).toMatchObject({ at: new Date('2026-09-02T10:00:00.000Z'), basis: 'source_event' });
  });

  it('keeps six exclusive buckets and reopens when a genuinely new ask arrives', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      measurementStartAt: T0,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({
          id: 'ask-a',
          askId: 'ask-a',
          eventAt: '2026-09-02T09:00:00.000Z',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'answer-a',
          askId: 'ask-a',
          eventType: 'answer',
          direction: 'outbound',
          eventAt: '2026-09-02T11:00:00.000Z',
          sourceBasis: 'source_event',
          answerState: 'supported',
          workState: 'complete',
          substantive: true,
          delivery: { status: 'accepted', acceptedAt: '2026-09-02T11:00:01.000Z' },
        }),
        evidence({
          id: 'ask-b',
          askId: 'ask-b',
          eventAt: '2026-09-03T09:00:00.000Z',
          requiresHotelResponse: true,
          workState: 'open',
        }),
      ],
    });

    expect(PRIMARY_BUCKETS).toHaveLength(6);
    expect(result.primaryBucket).toBe('awaiting_hotel_reply');
    expect(result.asks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ askId: 'ask-a', replyState: 'answered' }),
        expect.objectContaining({
          askId: 'ask-b',
          replyState: 'awaiting_hotel',
          waitStartedAt: '2026-09-03T09:00:00.000Z',
        }),
      ]),
    );
    expect(result.answeredAskCount).toBe(1);
    expect(result.openAskCount).toBe(1);
  });

  it('does not restart the wait clock for a follow-up on the same ask', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({
          id: 'ask-a',
          askId: 'ask-a',
          eventAt: '2026-09-02T09:00:00.000Z',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'follow-up-a',
          askId: 'ask-a',
          eventType: 'clarification',
          eventAt: '2026-09-04T09:00:00.000Z',
          requiresHotelResponse: true,
          workState: 'open',
        }),
      ],
    });

    expect(result.primaryBucket).toBe('awaiting_hotel_reply');
    expect(result.asks[0]).toMatchObject({
      askId: 'ask-a',
      waitStartedAt: '2026-09-02T09:00:00.000Z',
      followUpCount: 1,
    });
  });

  it('separates partial answers and preserves unknown evidence over a known completion', () => {
    const partial = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({
          id: 'ask-a',
          askId: 'ask-a',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'answer-a',
          askId: 'ask-a',
          eventType: 'answer',
          direction: 'outbound',
          answerState: 'partial',
          workState: 'partially_complete',
          substantive: true,
          delivery: { status: 'partial', acceptedAt: '2026-09-02T11:00:01.000Z' },
        }),
      ],
    });
    expect(partial.primaryBucket).toBe('awaiting_hotel_reply');
    expect(partial.overlays).toEqual(expect.arrayContaining(['partially_answered']));

    const unknownWork = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({
          id: 'ask-a',
          askId: 'ask-a',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'unknown-answer-a',
          askId: 'ask-a',
          eventType: 'answer',
          direction: 'outbound',
          answerState: 'unknown',
          workState: 'open',
          substantive: true,
          delivery: { status: 'unknown' },
        }),
      ],
    });
    expect(unknownWork.primaryBucket).toBe('hotel_action_pending');
    expect(unknownWork.overlays).toEqual(expect.arrayContaining(['unknown_evidence']));
    expect(unknownWork.answeredAskCount).toBe(0);
  });

  it('does not treat auto-acks, internal forwards, ambiguous links, or queued sends as answers', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({ id: 'ask-a', askId: 'ask-a', requiresHotelResponse: true, workState: 'open' }),
        evidence({
          id: 'ack-a',
          askId: 'ask-a',
          eventType: 'acknowledgement',
          direction: 'outbound',
          answerState: 'supported',
          substantive: false,
          delivery: { status: 'accepted', acceptedAt: '2026-09-02T10:00:00.000Z' },
        }),
        evidence({
          id: 'forward-a',
          askId: 'ask-a',
          eventType: 'forward',
          direction: 'outbound',
          answerState: 'supported',
          substantive: true,
          linkStrength: 'ambiguous',
          delivery: { status: 'accepted', acceptedAt: '2026-09-02T10:30:00.000Z' },
        }),
        evidence({
          id: 'queued-a',
          askId: 'ask-a',
          eventType: 'answer',
          direction: 'outbound',
          answerState: 'supported',
          substantive: true,
          delivery: { status: 'queued' },
        }),
      ],
    });

    expect(result.primaryBucket).toBe('awaiting_hotel_reply');
    expect(result.answeredAskCount).toBe(0);
  });

  it('accepts an independently observed external Sent answer without a Nava queue row', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'external-sent-vintage-1',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      evidence: [
        evidence({
          id: 'ask-a',
          askId: 'ask-a',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'external-sent-a',
          askId: 'ask-a',
          eventType: 'answer',
          direction: 'outbound',
          source: 'external_sent',
          eventAt: '2026-09-02T11:00:00.000Z',
          linkStrength: 'header',
          answerState: 'supported',
          workState: 'complete',
          substantive: true,
          delivery: { status: 'sent' },
        }),
      ],
    });

    expect(result.primaryBucket).toBe('answered');
    expect(result.answeredAskCount).toBe(1);
  });

  it('keeps explicitly no-response work in the sixth exclusive bucket', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'no-reply-vintage-1',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      evidence: [
        evidence({
          id: 'no-reply-a',
          askId: 'no-reply-a',
          eventType: 'work_update',
          noReplyRequired: true,
          workState: 'not_required',
        }),
      ],
    });

    expect(result.primaryBucket).toBe('no_reply_required');
    expect(result.replyState).toBe('no_reply_required');
    expect(result.workState).toBe('not_required');
  });

  it('rejects future evidence, separates pre-T0 backlog, and preserves coverage denominators', () => {
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      measurementStartAt: T0,
      coverage: {
        startAt: T0,
        endAt: CUTOFF,
        basis: 'two_way_feed_after_t0',
        complete: false,
      },
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({
          id: 'old-ask',
          askId: 'old-ask',
          eventAt: '2026-08-31T09:00:00.000Z',
          requiresHotelResponse: true,
          workState: 'open',
        }),
        evidence({
          id: 'new-ask',
          askId: 'new-ask',
          eventAt: '2026-09-02T09:00:00.000Z',
          requiresCustomerInformation: true,
          workState: 'open',
        }),
        evidence({
          id: 'future-answer',
          askId: 'new-ask',
          eventType: 'answer',
          direction: 'outbound',
          eventAt: '2026-09-09T09:00:00.000Z',
          answerState: 'supported',
          workState: 'complete',
          substantive: true,
          delivery: { status: 'accepted', acceptedAt: '2026-09-09T09:00:01.000Z' },
        }),
      ],
    });

    expect(result.primaryBucket).toBe('awaiting_customer_information');
    expect(result.exclusions).toMatchObject({ future_event: 1, pre_period: 1 });
    expect(result.denominators).toMatchObject({ eligible: 1, scorable: 0, unscorable: 1 });
    expect(result.coverage).toMatchObject({ complete: false, basis: 'two_way_feed_after_t0' });
  });

  it('marks conflicting duplicate answer facts unknown regardless of input order', () => {
    const make = (answerState: 'supported' | 'unknown') =>
      evidence({
        id: `answer-${answerState}`,
        askId: 'ask-a',
        eventType: 'answer',
        direction: 'outbound',
        answerState,
        factKey: 'answer-a-v1',
        substantive: true,
        delivery: { status: 'accepted', acceptedAt: '2026-09-02T11:00:01.000Z' },
      });
    const input = {
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      observationCutoff: CUTOFF,
      sourceVintage: 'mail-vintage-1',
      interpretationVersion: 'interpretation-1',
      evidence: [
        evidence({ id: 'ask-a', askId: 'ask-a', requiresHotelResponse: true, workState: 'open' }),
        make('supported'),
        make('unknown'),
      ],
    } as const;
    const first = reduceMailBaseline(input);
    const second = reduceMailBaseline({ ...input, evidence: [...input.evidence].reverse() });
    expect(first).toEqual(second);
    expect(first.primaryBucket).toBe('hotel_action_pending');
    expect(first.overlays).toContain('unknown_evidence');
  });
});

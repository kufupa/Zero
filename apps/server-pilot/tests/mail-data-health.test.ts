import { describe, expect, it } from 'vitest';
import {
  buildMailDataHealth,
  type MailDataHealthMessage,
} from '../src/metrics/mail-data-health';

const cutoff = '2026-09-07T00:00:00.000Z';

describe('mail data health', () => {
  it('deduplicates canonical source copies and reports both directions through the cutoff', () => {
    const inbound: MailDataHealthMessage = {
      canonicalId: 'message-in-1',
      direction: 'inbound',
      sourceEventAt: '2026-09-03T08:00:00.000Z',
      firstKnownAt: '2026-09-03T08:01:00.000Z',
      threadId: 'thread-1',
      hasQuotedMailboxReply: false,
    };
    const outbound: MailDataHealthMessage = {
      canonicalId: 'message-out-1',
      direction: 'outbound',
      sourceEventAt: '2026-09-03T08:30:00.000Z',
      firstKnownAt: '2026-09-03T08:31:00.000Z',
      sendState: 'sent',
      threadId: 'thread-1',
      hasQuotedMailboxReply: false,
      hasMatchingOutbound: true,
    };

    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [inbound, { ...inbound, sourceMessageId: 'copy-of-in-1' }, outbound],
      quoteProjection: 'available',
    });

    expect(health.directionCounts).toEqual({ inbound: 1, outbound: 1 });
    expect(health.lastObservedAt).toEqual({
      inbound: '2026-09-03T08:00:00.000Z',
      outbound: '2026-09-03T08:30:00.000Z',
    });
    expect(health.lastObservedBasis).toEqual({
      inbound: 'source_event',
      outbound: 'source_event',
    });
    expect(health.observationCutoff).toBe(cutoff);
  });

  it('deduplicates rows that share either a canonical or source identity', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'canonical-1',
          sourceMessageId: 'source-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-03T08:00:00.000Z',
        },
        {
          canonicalId: 'different-copy-id',
          sourceMessageId: 'source-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-03T08:01:00.000Z',
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.directionCounts.inbound).toBe(1);
  });

  it('does not treat a queued native send as the last observed outbound', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'sent',
          direction: 'outbound',
          sourceEventAt: '2026-09-04T10:00:00.000Z',
          sendState: 'sent',
        },
        {
          canonicalId: 'queued',
          direction: 'outbound',
          sourceEventAt: '2026-09-06T10:00:00.000Z',
          firstKnownAt: '2026-09-06T10:01:00.000Z',
          sendState: 'pending',
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.directionCounts.outbound).toBe(1);
    expect(health.lastObservedAt.outbound).toBe('2026-09-04T10:00:00.000Z');
  });

  it('labels header-date fallback and does not use import availability as an event clock', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'header-dated',
          direction: 'inbound',
          headerDateAt: '2026-09-05T10:00:00.000Z',
          firstKnownAt: '2026-09-06T10:00:00.000Z',
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.lastObservedAt.inbound).toBe('2026-09-05T10:00:00.000Z');
    expect(health.lastObservedBasis.inbound).toBe('sender_timestamp_estimate');
  });

  it('uses a trusted outbound send clock as a source event', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'sent-1',
          direction: 'outbound',
          sentAt: '2026-09-05T10:00:00.000Z',
          createdAt: '2026-09-06T10:00:00.000Z',
          sendState: 'sent',
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.lastObservedAt.outbound).toBe('2026-09-05T10:00:00.000Z');
    expect(health.lastObservedBasis.outbound).toBe('source_event');
  });

  it('keeps singleton and quoted-mailbox-reply diagnostics independently scoped', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'singleton-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-01T10:00:00.000Z',
          threadId: 'thread-singleton',
          hasQuotedMailboxReply: true,
          hasMatchingOutbound: false,
        },
        {
          canonicalId: 'conversation-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-02T10:00:00.000Z',
          threadId: 'thread-conversation',
          hasQuotedMailboxReply: false,
        },
        {
          canonicalId: 'conversation-2',
          direction: 'outbound',
          sourceEventAt: '2026-09-02T11:00:00.000Z',
          threadId: 'thread-conversation',
          sendState: 'sent',
          hasQuotedMailboxReply: false,
          hasMatchingOutbound: true,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.singleton).toEqual({ numerator: 1, denominator: 2 });
    expect(health.quotedMailboxReplyNoMatchingOutbound).toMatchObject({
      numerator: 1,
      denominator: 2,
      availability: 'available',
    });
  });

  it('returns unknown quote counts when the bounded projection is unavailable', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [
        {
          canonicalId: 'inbound-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-03T10:00:00.000Z',
          threadId: 'thread-1',
        },
      ],
      quoteProjection: 'unavailable',
    });

    expect(health.quotedMailboxReplyNoMatchingOutbound).toEqual({
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'quote_projection_unavailable',
    });
    expect(health).not.toHaveProperty('body');
    expect(health).not.toHaveProperty('rawBody');
  });

  it('does not turn a known empty covered period into an unavailable zero', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      messages: [],
      quoteProjection: 'available',
    });

    expect(health.directionCounts).toEqual({ inbound: 0, outbound: 0 });
    expect(health.singleton).toEqual({ numerator: 0, denominator: 0 });
    expect(health.quotedMailboxReplyNoMatchingOutbound).toMatchObject({
      numerator: 0,
      denominator: 0,
      availability: 'available',
    });
  });

  it('accepts an existing bounded summary without scanning message bodies', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      directionCounts: { inbound: 4, outbound: 2 },
      lastObservedAt: {
        inbound: '2026-09-06T08:00:00.000Z',
        outbound: '2026-09-06T09:00:00.000Z',
      },
      lastObservedBasis: { inbound: 'source_event', outbound: 'source_event' },
      singleton: { numerator: 1, denominator: 4 },
      quotedMailboxReplyNoMatchingOutbound: {
        numerator: 1,
        denominator: 4,
      },
    });

    expect(health).toEqual({
      availability: 'available',
      observationCutoff: cutoff,
      directionCounts: { inbound: 4, outbound: 2 },
      lastObservedAt: {
        inbound: '2026-09-06T08:00:00.000Z',
        outbound: '2026-09-06T09:00:00.000Z',
      },
      lastObservedBasis: { inbound: 'source_event', outbound: 'source_event' },
      singleton: { numerator: 1, denominator: 4 },
      quotedMailboxReplyNoMatchingOutbound: {
        numerator: 1,
        denominator: 4,
        availability: 'available',
      },
    });
  });
});

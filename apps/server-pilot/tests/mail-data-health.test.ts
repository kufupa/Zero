import { describe, expect, it } from 'vitest';
import {
  buildMailDataHealth,
  type MailDataHealthMessage,
  type MailDataHealthSummaryInput,
} from '../src/metrics/mail-data-health';

const cutoff = '2026-09-07T00:00:00.000Z';
const scopeKey = 'transport-centurion/cohort-centurion';

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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      scopeKey,
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
      unscorable: {
        total: 0,
        inbound: 0,
        outbound: 0,
        missingClock: 0,
        invalidClock: 0,
        missingThreadLinkage: 0,
        missingIdentity: 0,
      },
    });
  });

  it('fails closed when no bounded evidence source is supplied', () => {
    const health = buildMailDataHealth({ observationCutoff: cutoff });

    expect(health.availability).toBe('unavailable');
    expect(health.directionCounts).toEqual({ inbound: null, outbound: null });
    expect(health.singleton).toEqual({ numerator: null, denominator: null });
  });

  it('fails closed when a row has no usable event or observation clock', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [{ canonicalId: 'clockless', direction: 'inbound', threadId: 'thread-1' }],
      quoteProjection: 'available',
    });

    expect(health.availability).toBe('unavailable');
    expect(health.directionCounts).toEqual({ inbound: null, outbound: null });
    expect(health.unscorable).toMatchObject({ total: 1, missingClock: 1 });
    expect(health.quotedMailboxReplyNoMatchingOutbound.availability).toBe('unavailable');
  });

  it('does not count an invalid/future event through a first-known fallback', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [
        {
          canonicalId: 'future-event',
          direction: 'inbound',
          sourceEventAt: '2026-09-08T10:00:00.000Z',
          firstKnownAt: '2026-09-06T10:00:00.000Z',
          threadId: 'thread-1',
          hasQuotedMailboxReply: true,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.availability).toBe('unavailable');
    expect(health.directionCounts).toEqual({ inbound: null, outbound: null });
    expect(health.singleton).toEqual({ numerator: null, denominator: null });
    expect(health.lastObservedAt).toEqual({ inbound: null, outbound: null });
    expect(health.lastObservedBasis).toEqual({ inbound: null, outbound: null });
    expect(health.unscorable).toMatchObject({ total: 1, invalidClock: 1 });
  });

  it('rejects any future primary clock even when another primary clock is before cutoff', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [
        {
          canonicalId: 'future-inbound',
          direction: 'inbound',
          sourceEventAt: '2026-09-08T10:00:00.000Z',
          receivedAt: '2026-09-06T10:00:00.000Z',
          threadId: 'thread-inbound',
          hasQuotedMailboxReply: false,
        },
        {
          canonicalId: 'future-outbound',
          direction: 'outbound',
          sourceEventAt: '2026-09-08T11:00:00.000Z',
          sentAt: '2026-09-06T11:00:00.000Z',
          sendState: 'sent',
          threadId: 'thread-outbound',
          hasQuotedMailboxReply: false,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.availability).toBe('unavailable');
    expect(health.directionCounts).toEqual({ inbound: null, outbound: null });
    expect(health.unscorable).toMatchObject({
      total: 2,
      inbound: 1,
      outbound: 1,
      invalidClock: 2,
    });
  });

  it('requires source summary clock basis instead of inferring first-known', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      directionCounts: { inbound: 1, outbound: 0 },
      lastObservedAt: { inbound: '2026-09-06T10:00:00.000Z', outbound: null },
      singleton: { numerator: 1, denominator: 1 },
      quotedMailboxReplyNoMatchingOutbound: { numerator: 0, denominator: 1 },
    });

    expect(health.availability).toBe('unavailable');
    expect(health.lastObservedBasis).toEqual({ inbound: null, outbound: null });
  });

  it('requires summary timestamp and basis nullness to agree in both directions', () => {
    const base: MailDataHealthSummaryInput = {
      observationCutoff: cutoff,
      directionCounts: { inbound: 1, outbound: 0 },
      lastObservedAt: { inbound: null, outbound: null },
      lastObservedBasis: { inbound: null, outbound: null },
      singleton: { numerator: 0, denominator: 0 },
      quotedMailboxReplyNoMatchingOutbound: { numerator: 0, denominator: 0 },
    };

    const missingTime = buildMailDataHealth({
      ...base,
      lastObservedBasis: { inbound: 'source_event', outbound: null },
    });
    const missingBasis = buildMailDataHealth({
      ...base,
      lastObservedAt: {
        inbound: '2026-09-06T10:00:00.000Z',
        outbound: null,
      },
    });

    expect(missingTime.availability).toBe('unavailable');
    expect(missingBasis.availability).toBe('unavailable');
  });

  it('fails closed instead of throwing for malformed summary containers', () => {
    const base: MailDataHealthSummaryInput = {
      observationCutoff: cutoff,
      directionCounts: { inbound: 1, outbound: 0 },
      lastObservedAt: {
        inbound: '2026-09-06T10:00:00.000Z',
        outbound: null,
      },
      lastObservedBasis: { inbound: 'source_event', outbound: null },
      singleton: { numerator: 0, denominator: 0 },
      quotedMailboxReplyNoMatchingOutbound: { numerator: 0, denominator: 0 },
    };

    const malformedCounts = {
      ...base,
      directionCounts: undefined,
    } as unknown as Parameters<typeof buildMailDataHealth>[0];
    const malformedTimes = {
      ...base,
      lastObservedAt: undefined,
    } as unknown as Parameters<typeof buildMailDataHealth>[0];

    expect(() => buildMailDataHealth(malformedCounts)).not.toThrow();
    expect(() => buildMailDataHealth(malformedTimes)).not.toThrow();
    expect(buildMailDataHealth(malformedCounts).availability).toBe('unavailable');
    expect(buildMailDataHealth(malformedTimes).availability).toBe('unavailable');
  });

  it('does not certify singleton or quote evidence without thread linkage', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [
        {
          canonicalId: 'unlinked-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-05T10:00:00.000Z',
          hasQuotedMailboxReply: true,
        },
        {
          canonicalId: 'unlinked-2',
          direction: 'inbound',
          sourceEventAt: '2026-09-05T11:00:00.000Z',
          hasQuotedMailboxReply: false,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.directionCounts).toEqual({ inbound: 2, outbound: 0 });
    expect(health.singleton).toEqual({ numerator: null, denominator: null });
    expect(health.quotedMailboxReplyNoMatchingOutbound).toMatchObject({
      numerator: null,
      denominator: null,
      availability: 'unavailable',
      reason: 'thread_linkage_unavailable',
    });
    expect(health.unscorable).toMatchObject({ total: 2, missingThreadLinkage: 2 });
  });

  it('merges duplicate identities so a valid later source clock is not hidden by the first row', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [
        {
          canonicalId: 'same-message',
          direction: 'inbound',
          threadId: 'thread-1',
        },
        {
          canonicalId: 'same-message',
          sourceMessageId: '<same-message@example.test>',
          direction: 'inbound',
          sourceEventAt: '2026-09-05T12:00:00.000Z',
          threadId: 'thread-1',
          hasQuotedMailboxReply: false,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.directionCounts).toEqual({ inbound: 1, outbound: 0 });
    expect(health.unscorable.total).toBe(0);
  });

  it('merges later sent and quote evidence instead of letting an earlier queued copy win', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey,
      messages: [
        {
          canonicalId: 'same-outbound',
          direction: 'outbound',
          sourceEventAt: '2026-09-05T12:00:00.000Z',
          threadId: 'thread-1',
          sendState: 'pending',
          hasQuotedMailboxReply: false,
        },
        {
          canonicalId: 'same-outbound',
          direction: 'outbound',
          sourceMessageId: '<same-outbound@example.test>',
          sourceEventAt: '2026-09-05T12:00:00.000Z',
          threadId: 'thread-1',
          sendState: 'sent',
          hasQuotedMailboxReply: true,
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.directionCounts).toEqual({ inbound: 0, outbound: 1 });
    expect(health.lastObservedAt.outbound).toBe('2026-09-05T12:00:00.000Z');
    expect(health.unscorable.total).toBe(0);
  });

  it('requires a non-empty scope key for row diagnostics', () => {
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      scopeKey: ' ',
      messages: [
        {
          canonicalId: 'message-1',
          direction: 'inbound',
          sourceEventAt: '2026-09-05T12:00:00.000Z',
        },
      ],
      quoteProjection: 'available',
    });

    expect(health.availability).toBe('unavailable');
  });

  it('allowlists summary scalars instead of copying tainted extra fields', () => {
    const quote = {
      numerator: 1,
      denominator: 2,
      rawBody: 'quoted body must not be returned',
    } as unknown as { numerator: number; denominator: number };
    const health = buildMailDataHealth({
      observationCutoff: cutoff,
      directionCounts: { inbound: 2, outbound: 1 },
      lastObservedAt: { inbound: '2026-09-06T10:00:00.000Z', outbound: null },
      lastObservedBasis: { inbound: 'source_event', outbound: null },
      singleton: { numerator: 1, denominator: 2 },
      quotedMailboxReplyNoMatchingOutbound: quote,
    });

    expect(health.quotedMailboxReplyNoMatchingOutbound).toEqual({
      numerator: 1,
      denominator: 2,
      availability: 'available',
    });
    expect(health).not.toHaveProperty('rawBody');
    expect(JSON.stringify(health)).not.toContain('quoted body');
  });
});

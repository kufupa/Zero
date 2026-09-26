import { matchShadowReference } from '../src/ai/shadow-reference-matcher.js';
import { describe, expect, it } from 'vitest';

const prediction = {
  id: 'prediction-1',
  transportId: 'transport-1',
  threadId: 'thread-1',
  triggerMessageId: 'inbound-1',
  triggerMessageIdHeader: '<inbound-1@example.test>',
  asOfAt: new Date('2026-09-01T10:00:00.000Z'),
};

function outbound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outbound-1',
    transportId: 'transport-1',
    threadId: 'thread-1',
    direction: 'outbound' as const,
    createdAt: new Date('2026-09-01T11:00:00.000Z'),
    sentAt: new Date('2026-09-01T11:00:00.000Z'),
    receivedAt: null,
    messageIdHeader: '<outbound-1@example.test>',
    inReplyTo: '<inbound-1@example.test>',
    references: ['<inbound-1@example.test>'],
    ...overrides,
  };
}

describe('shadow reference matcher', () => {
  it('matches a later outbound with a verified reply reference', () => {
    expect(matchShadowReference(prediction, [outbound()])).toMatchObject({
      status: 'matched',
      referenceMessageId: 'outbound-1',
      linkStrength: 'header',
    });
  });

  it('marks an imported sent copy before the frozen prediction as late', () => {
    const late = outbound({
      createdAt: new Date('2026-09-01T09:00:00.000Z'),
      sentAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    expect(matchShadowReference(prediction, [late])).toMatchObject({
      status: 'late',
      referenceMessageId: 'outbound-1',
    });
  });

  it('keeps competing weak same-thread references ambiguous', () => {
    expect(
      matchShadowReference(prediction, [
        outbound({ id: 'outbound-a', inReplyTo: null, references: [] }),
        outbound({
          id: 'outbound-b',
          inReplyTo: null,
          references: [],
          sentAt: new Date('2026-09-01T12:00:00.000Z'),
        }),
      ]),
    ).toMatchObject({ status: 'ambiguous', referenceMessageId: null, linkStrength: 'ambiguous' });
  });

  it('retains unmatched/no-reference coverage instead of treating it as a reply', () => {
    expect(matchShadowReference(prediction, [])).toMatchObject({
      status: 'unmatched',
      referenceMessageId: null,
      linkStrength: 'unknown',
    });
  });
});

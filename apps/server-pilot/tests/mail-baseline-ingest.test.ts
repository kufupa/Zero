import { reduceMailBaseline, type MailBaselineEvidence } from '../src/metrics/mail-baseline.js';
import { extractMailBaselineEvidence } from '../src/ai/mail-baseline-extraction.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { resolveTriageEventClock } from '../src/ai/triage-input.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';

describe('mail baseline ingest clock provenance', () => {
  it('preserves a missing MIME Date as an unavailable clock through parser and extraction', async () => {
    const raw = Buffer.from(
      [
        'From: guest@example.test',
        'To: hotel@example.test',
        'Message-ID: <missing-date@example.test>',
        'Subject: Please confirm my reservation',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please confirm my reservation.',
      ].join('\r\n'),
      'utf8',
    );
    const parsed = await parseRawMessage(raw, {
      messageId: 'missing-date-message',
      storage: new FakeS3Storage('missing-date-bucket'),
    });
    expect(parsed.receivedAt).toBeNull();

    const clock = resolveTriageEventClock({
      id: 'missing-date-message',
      from: parsed.fromAddress ?? '',
      body: parsed.textBody ?? '',
      direction: 'inbound',
      createdAt: new Date('2026-09-02T09:05:00.000Z'),
      receivedAt: parsed.receivedAt,
      sentAt: null,
    });
    expect(clock).toEqual({ at: null, basis: 'availability' });

    const extracted = extractMailBaselineEvidence({
      sourceVintage: 'missing-date-v1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      message: {
        id: 'missing-date-message',
        transportId: 'transport-centurion',
        threadId: 'thread-missing-date',
        direction: 'inbound',
        fromAddress: parsed.fromAddress ?? '',
        toAddresses: parsed.toAddresses,
        subject: parsed.subject,
        textBody: parsed.textBody,
        receivedAt: parsed.receivedAt,
        createdAt: '2026-09-02T09:05:00.000Z',
        source: 'mail_event',
        sourceBasis: 'availability',
      },
    });
    expect(extracted).toMatchObject({ sourceBasis: 'availability', eventAt: null });
    expect(extracted.evidence[0]).toMatchObject({
      sourceBasis: 'availability',
      eventAt: null,
      unknownReason: 'availability_clock_unavailable',
    });
  });

  it('keeps an availability-clock ask in the unscorable population without claiming a bucket', () => {
    const evidence: MailBaselineEvidence = {
      id: 'availability-ask',
      requestId: 'request-availability',
      askId: 'ask-availability',
      threadId: 'thread-availability',
      transportId: 'transport-centurion',
      eventType: 'ask',
      direction: 'inbound',
      eventAt: null,
      observedAt: null,
      source: 'mail_event',
      sourceBasis: 'availability',
      requiresHotelResponse: true,
      workState: 'open',
      answerState: null,
      substantive: false,
      linkStrength: 'header',
      delivery: null,
      unknownReason: 'availability_clock_unavailable',
    };
    const result = reduceMailBaseline({
      transportId: 'transport-centurion',
      threadId: 'thread-availability',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      measurementStartAt: '2026-09-01T00:00:00.000Z',
      sourceVintage: 'availability-v1',
      interpretationVersion: 'mail-baseline-interpretation-v1',
      evidence: [evidence],
    });
    expect(result.primaryBucket).toBe('unknown');
    expect(result.denominators).toEqual({ eligible: 1, scorable: 0, unscorable: 1 });
    expect(result.exclusions).toMatchObject({ unscorable_event_clock: 1 });
  });
});

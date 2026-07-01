import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  IngestTooLargeError,
  assertWithinIngestLimits,
  getIngestLimits,
} from '../src/mail/ingest/limits';

describe('ingest limits', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('uses 25MB / 15MB defaults when env unset', () => {
    delete process.env.INGEST_MAX_MESSAGE_BYTES;
    delete process.env.INGEST_MAX_ATTACHMENT_BYTES;
    const limits = getIngestLimits();
    expect(limits.maxMessageBytes).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    expect(limits.maxAttachmentBytes).toBe(DEFAULT_MAX_ATTACHMENT_BYTES);
  });

  it('reads optional env overrides', () => {
    process.env.INGEST_MAX_MESSAGE_BYTES = '1000';
    process.env.INGEST_MAX_ATTACHMENT_BYTES = '500';
    const limits = getIngestLimits();
    expect(limits.maxMessageBytes).toBe(1000);
    expect(limits.maxAttachmentBytes).toBe(500);
  });

  it('throws IngestTooLargeError for oversized message', () => {
    expect(() =>
      assertWithinIngestLimits(26 * 1024 * 1024, 'message'),
    ).toThrow(IngestTooLargeError);
    try {
      assertWithinIngestLimits(26 * 1024 * 1024, 'message');
    } catch (err) {
      expect(err).toBeInstanceOf(IngestTooLargeError);
      const e = err as IngestTooLargeError;
      expect(e.kind).toBe('message');
      expect(e.limitBytes).toBe(DEFAULT_MAX_MESSAGE_BYTES);
    }
  });

  it('throws IngestTooLargeError for oversized attachment', () => {
    expect(() =>
      assertWithinIngestLimits(16 * 1024 * 1024, 'attachment'),
    ).toThrow(IngestTooLargeError);
  });

  it('allows sizes within limits', () => {
    expect(() =>
      assertWithinIngestLimits(1024, 'message', {
        maxMessageBytes: 2048,
        maxAttachmentBytes: 2048,
      }),
    ).not.toThrow();
  });
});

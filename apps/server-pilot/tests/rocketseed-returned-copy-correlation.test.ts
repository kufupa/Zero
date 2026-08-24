import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakeS3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

function returnedCopyWithOutboundId(outboundId: string): Buffer {
  return Buffer.from(
    [
      `X-Zero-Outbound-Id: ${outboundId}`,
      'Message-ID: <parser-correlation@zero.test>',
      '',
      'parser correlation test',
    ].join('\r\n'),
  );
}

describe('returned-copy outbound correlation parsing', () => {
  it('parses a valid X-Zero-Outbound-Id as outbound correlation', async () => {
    const outboundId = randomUUID();
    const parsed = await parseRawMessage(returnedCopyWithOutboundId(outboundId), {
      messageId: randomUUID(),
      storage: new FakeS3Storage('test-mail-bucket'),
    });

    expect(parsed.outboundCorrelation).toEqual({
      kind: 'valid',
      outboundId,
    });
  });

  it('distinguishes absent from malformed X-Zero-Outbound-Id', async () => {
    const storage = new FakeS3Storage('test-mail-bucket');
    const [absent, malformed] = await Promise.all([
      parseRawMessage(Buffer.from('Subject: no correlation\r\n\r\nparser correlation test'), {
        messageId: randomUUID(),
        storage,
      }),
      parseRawMessage(returnedCopyWithOutboundId('not-a-uuid'), {
        messageId: randomUUID(),
        storage,
      }),
    ]);

    expect(absent.outboundCorrelation).toEqual({ kind: 'absent' });
    expect(malformed.outboundCorrelation).toEqual({ kind: 'malformed' });
  });
});

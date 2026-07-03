import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { FakeS3Storage } from '../src/storage/s3.js';

describe('s3 stream upload', () => {
  it('FakeS3Storage stores full bytes from Readable stream', async () => {
    const storage = new FakeS3Storage('stream-test');
    const payload = Buffer.from('stream-body-bytes');
    const stream = Readable.from([payload]);

    const result = await storage.putObject({
      key: 'raw-mime/test/stream.eml',
      body: stream,
      contentType: 'message/rfc822',
    });

    expect(result.bytes).toBe(payload.byteLength);
    expect(storage.get('raw-mime/test/stream.eml')?.toString()).toBe('stream-body-bytes');
  });
});

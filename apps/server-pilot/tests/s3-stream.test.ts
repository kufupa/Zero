import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { FakeS3Storage, S3ObjectTooLargeError } from '../src/storage/s3.js';

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

  it('FakeS3Storage getObjectBounded rejects oversized bodies', async () => {
    const storage = new FakeS3Storage('stream-test');
    await storage.putObject({
      key: 'attachments/msg/000-big.bin',
      body: Buffer.alloc(100, 0x42),
      contentType: 'application/octet-stream',
    });

    await expect(
      storage.getObjectBounded('attachments/msg/000-big.bin', 50),
    ).rejects.toBeInstanceOf(S3ObjectTooLargeError);

    const ok = await storage.getObjectBounded(
      'attachments/msg/000-big.bin',
      100,
    );
    expect(ok?.body.byteLength).toBe(100);
  });

  it('FakeS3Storage getObjectBounded rejects non-finite maxBytes', async () => {
    const storage = new FakeS3Storage('stream-test');
    await storage.putObject({
      key: 'attachments/msg/000-x.bin',
      body: Buffer.from('x'),
      contentType: 'application/octet-stream',
    });
    await expect(
      storage.getObjectBounded('attachments/msg/000-x.bin', Number.NaN),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

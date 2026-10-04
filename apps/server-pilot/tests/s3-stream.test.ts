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

describe('bounded sync stream helpers', () => {
  it('hashes a stream without collecting whole-object buffers', async () => {
    const { sha256Stream } = await import('../src/storage/s3.js');
    const result = await sha256Stream(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 3);
    expect(result).toEqual({ bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    await expect(sha256Stream(Readable.from([Buffer.alloc(4)]), 3)).rejects.toThrow('size');
  });
  it('parts fragmented input into fixed buffers with exact final size and rejects oversized streams', async () => {
    const { fixedSizeStreamParts } = await import('../src/storage/s3.js');
    const chunks: Buffer[] = [];
    for await (const chunk of fixedSizeStreamParts(Readable.from([Buffer.from('ab'), Buffer.from('cdefg')]), 3, 7)) chunks.push(chunk);
    expect(chunks.map((b) => b.toString())).toEqual(['abc', 'def', 'g']);
    await expect((async () => {
      for await (const _part of fixedSizeStreamParts(Readable.from([Buffer.alloc(8)]), 3, 7)) { /* drain */ }
    })()).rejects.toThrow('size');
  });
});

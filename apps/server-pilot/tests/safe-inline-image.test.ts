import { describe, expect, it } from 'vitest';
import {
  assertSafeInlineRaster,
  InlineImageTooLargeError,
  InlineImageUnsupportedError,
} from '../src/mail/safe-inline-image.js';

const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
    buffer,
  );
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 2;
  return buffer;
}

function jpeg(width: number, height: number): Buffer {
  const appPayload = Buffer.from([0x00, 0x00]);
  const app = Buffer.alloc(appPayload.length + 4);
  app[0] = 0xff;
  app[1] = 0xe0;
  app.writeUInt16BE(appPayload.length + 2, 2);
  appPayload.copy(app, 4);

  const sofPayload = Buffer.alloc(15);
  sofPayload[0] = 8;
  sofPayload.writeUInt16BE(height, 1);
  sofPayload.writeUInt16BE(width, 3);
  sofPayload[5] = 3;
  const sof = Buffer.alloc(sofPayload.length + 4);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(sofPayload.length + 2, 2);
  sofPayload.copy(sof, 4);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app,
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function gif(
  width: number,
  height: number,
  version: 'GIF87a' | 'GIF89a' = 'GIF89a',
): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write(version, 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function webpChunk(kind: 'VP8X' | 'VP8 ' | 'VP8L', data: Buffer): Buffer {
  const paddedLength = data.length + (data.length % 2);
  const buffer = Buffer.alloc(20 + paddedLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write(kind, 12, 'ascii');
  buffer.writeUInt32LE(data.length, 16);
  data.copy(buffer, 20);
  return buffer;
}

function webpVp8x(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
}

function webpVp8(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[3] = 0x9d;
  data[4] = 0x01;
  data[5] = 0x2a;
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk('VP8 ', data);
}

function webpVp8l(width: number, height: number): Buffer {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  const dimensions = ((height - 1) << 14) | (width - 1);
  data.writeUInt32LE(dimensions >>> 0, 1);
  return webpChunk('VP8L', data);
}

describe('assertSafeInlineRaster', () => {
  it('accepts PNG, JPEG, GIF87a, GIF89a, and all WebP dimension headers', () => {
    expect(() => assertSafeInlineRaster(png(1, 1), 'image/png')).not.toThrow();
    expect(() => assertSafeInlineRaster(jpeg(2, 3), 'IMAGE/JPEG')).not.toThrow();
    expect(() => assertSafeInlineRaster(gif(4, 5, 'GIF87a'), 'image/gif')).not.toThrow();
    expect(() => assertSafeInlineRaster(gif(4, 5, 'GIF89a'), 'image/gif')).not.toThrow();
    expect(() => assertSafeInlineRaster(webpVp8x(6, 7), 'image/webp')).not.toThrow();
    expect(() => assertSafeInlineRaster(webpVp8(8, 9), 'image/webp')).not.toThrow();
    expect(() => assertSafeInlineRaster(webpVp8l(10, 11), 'image/webp')).not.toThrow();
  });

  it('normalizes MIME parameters but requires MIME/signature agreement', () => {
    expect(() =>
      assertSafeInlineRaster(png(1, 1), ' image/png; charset=binary '),
    ).not.toThrow();
    expect(() => assertSafeInlineRaster(png(1, 1), 'image/jpeg')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(jpeg(1, 1), 'image/png')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(gif(1, 1), 'image/webp')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(webpVp8x(1, 1), 'image/gif')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects SVG and unsupported formats', () => {
    expect(() =>
      assertSafeInlineRaster(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
        'image/svg+xml',
      ),
    ).toThrow(InlineImageUnsupportedError);
    expect(() =>
      assertSafeInlineRaster(Buffer.from('%PDF-1.7'), 'application/pdf'),
    ).toThrow(InlineImageUnsupportedError);
  });

  it('rejects truncated or structurally malformed headers', () => {
    const truncatedWebp = webpVp8x(1, 1).subarray(0, 24);
    for (const [bytes, mimeType] of [
      [png(1, 1).subarray(0, 24), 'image/png'],
      [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
      [Buffer.from('GIF89a'), 'image/gif'],
      [truncatedWebp, 'image/webp'],
    ] as const) {
      expect(() => assertSafeInlineRaster(bytes, mimeType)).toThrow(
        InlineImageUnsupportedError,
      );
    }
  });

  it('rejects zero dimensions and width or height above 10,000', () => {
    for (const [bytes, mimeType] of [
      [png(0, 1), 'image/png'],
      [jpeg(1, 0), 'image/jpeg'],
      [gif(10_001, 1), 'image/gif'],
      [webpVp8x(1, 10_001), 'image/webp'],
    ] as const) {
      expect(() => assertSafeInlineRaster(bytes, mimeType)).toThrow(
        InlineImageUnsupportedError,
      );
    }
  });

  it('rejects more than 25,000,000 pixels while accepting exact limits', () => {
    expect(() => assertSafeInlineRaster(png(5_000, 5_000), 'image/png')).not.toThrow();
    expect(() => assertSafeInlineRaster(gif(10_000, 1), 'image/gif')).not.toThrow();
    expect(() => assertSafeInlineRaster(png(5_001, 5_001), 'image/png')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects bodies above 5 MiB with the typed size error', () => {
    const bytes = Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1);
    png(1, 1).copy(bytes);

    expect(() => assertSafeInlineRaster(bytes, 'image/png')).toThrow(
      InlineImageTooLargeError,
    );
  });

  it('accepts a valid header at exactly 5 MiB', () => {
    const bytes = Buffer.alloc(MAX_INLINE_IMAGE_BYTES);
    png(1, 1).copy(bytes);

    expect(() => assertSafeInlineRaster(bytes, 'image/png')).not.toThrow();
  });
});

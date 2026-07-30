import { describe, expect, it } from 'vitest';
import {
  assertSafeInlineRaster,
  InlineImageTooLargeError,
  InlineImageUnsupportedError,
} from '../src/mail/safe-inline-image.js';

/** Minimal 1×1 PNG (IHDR width=1, height=1). */
function png(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR');
  // CRC not validated by our gate — zeros fine
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, len, type, ihdrData, crc]);
}

/** Minimal JPEG with SOF0 dimensions. */
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2); // length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), sof, Buffer.from([0xff, 0xd9])]);
}

function gif(width: number, height: number, version: 'GIF87a' | 'GIF89a' = 'GIF89a'): Buffer {
  const buf = Buffer.alloc(13);
  buf.write(version, 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Simple VP8X WebP with canvas size (width-1 / height-1 packed LE 24-bit). */
function webp(width: number, height: number): Buffer {
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0);
  vp8x.writeUInt32LE(10, 4); // chunk size
  vp8x[8] = 0; // flags
  vp8x[9] = 0;
  vp8x[10] = 0;
  vp8x[11] = 0;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  vp8x[12] = wMinus1 & 0xff;
  vp8x[13] = (wMinus1 >> 8) & 0xff;
  vp8x[14] = (wMinus1 >> 16) & 0xff;
  vp8x[15] = hMinus1 & 0xff;
  vp8x[16] = (hMinus1 >> 8) & 0xff;
  vp8x[17] = (hMinus1 >> 16) & 0xff;

  const riffSize = 4 + vp8x.length; // 'WEBP' + chunk
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(riffSize, 4);
  header.write('WEBP', 8);
  return Buffer.concat([header, vp8x]);
}

describe('assertSafeInlineRaster', () => {
  it('accepts valid PNG JPEG GIF WebP', () => {
    expect(() => assertSafeInlineRaster(png(1, 1), 'image/png')).not.toThrow();
    expect(() => assertSafeInlineRaster(jpeg(1, 1), 'image/jpeg')).not.toThrow();
    expect(() => assertSafeInlineRaster(gif(1, 1, 'GIF89a'), 'image/gif')).not.toThrow();
    expect(() => assertSafeInlineRaster(gif(1, 1, 'GIF87a'), 'image/gif')).not.toThrow();
    expect(() => assertSafeInlineRaster(webp(1, 1), 'image/webp')).not.toThrow();
  });

  it('accepts mime with charset parameter', () => {
    expect(() => assertSafeInlineRaster(png(1, 1), 'image/png; charset=binary')).not.toThrow();
  });

  it('rejects SVG and unsupported formats', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(() => assertSafeInlineRaster(svg, 'image/svg+xml')).toThrow(InlineImageUnsupportedError);
    expect(() => assertSafeInlineRaster(Buffer.from('%PDF-1.4'), 'application/pdf')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects MIME/signature mismatch', () => {
    expect(() => assertSafeInlineRaster(png(1, 1), 'image/jpeg')).toThrow(InlineImageUnsupportedError);
    expect(() => assertSafeInlineRaster(jpeg(1, 1), 'image/png')).toThrow(InlineImageUnsupportedError);
    expect(() => assertSafeInlineRaster(gif(1, 1), 'image/webp')).toThrow(InlineImageUnsupportedError);
  });

  it('rejects truncated headers', () => {
    expect(() => assertSafeInlineRaster(Buffer.from([0x89, 0x50]), 'image/png')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(Buffer.from([0xff, 0xd8]), 'image/jpeg')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(Buffer.from('GIF89'), 'image/gif')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(Buffer.from('RIFF'), 'image/webp')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects width or height above 10000', () => {
    expect(() => assertSafeInlineRaster(png(10001, 1), 'image/png')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(jpeg(1, 10001), 'image/jpeg')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(gif(10001, 1), 'image/gif')).toThrow(
      InlineImageUnsupportedError,
    );
    expect(() => assertSafeInlineRaster(webp(1, 10001), 'image/webp')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects more than 25_000_000 pixels', () => {
    // 5001 * 5001 = 25_010_001
    expect(() => assertSafeInlineRaster(png(5001, 5001), 'image/png')).toThrow(
      InlineImageUnsupportedError,
    );
  });

  it('rejects body above 5 MiB', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    // Put a valid PNG header so failure is size, not magic
    png(1, 1).copy(big, 0);
    expect(() => assertSafeInlineRaster(big, 'image/png')).toThrow(InlineImageTooLargeError);
  });
});

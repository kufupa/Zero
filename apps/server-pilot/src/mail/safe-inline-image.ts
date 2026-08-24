/** Shared projection and serving limit for an inline raster attachment. */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_PIXELS = 25_000_000;

export class InlineImageUnsupportedError extends Error {
  constructor(message = 'Unsupported inline image') {
    super(message);
    this.name = 'InlineImageUnsupportedError';
  }
}

export class InlineImageTooLargeError extends Error {
  constructor(message = 'Inline image too large') {
    super(message);
    this.name = 'InlineImageTooLargeError';
  }
}

type RasterKind = 'png' | 'jpeg' | 'gif' | 'webp';

function normalizeMime(mimeType: string): string {
  return mimeType.toLowerCase().split(';')[0]!.trim();
}

function mimeToKind(mime: string): RasterKind | null {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}

function detectKind(bytes: Buffer): RasterKind | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new InlineImageUnsupportedError('Inline image dimensions exceed limits');
  }
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } {
  // sig(8) + len(4) + 'IHDR'(4) + width(4) + height(4)
  if (bytes.length < 24) throw new InlineImageUnsupportedError('Truncated PNG');
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new InlineImageUnsupportedError('Invalid PNG IHDR');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readGifDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 10) throw new InlineImageUnsupportedError('Truncated GIF');
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) throw new InlineImageUnsupportedError('Invalid JPEG marker');
    while (i < bytes.length && bytes[i] === 0xff) i++;
    if (i >= bytes.length) break;
    const marker = bytes[i++]!;
    // Standalone markers without length
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= bytes.length) throw new InlineImageUnsupportedError('Truncated JPEG');
    const segLen = bytes.readUInt16BE(i);
    if (segLen < 2) throw new InlineImageUnsupportedError('Invalid JPEG segment');
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (not DHT/DAC etc.)
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (i + 7 >= bytes.length) throw new InlineImageUnsupportedError('Truncated JPEG SOF');
      const height = bytes.readUInt16BE(i + 3);
      const width = bytes.readUInt16BE(i + 5);
      return { width, height };
    }
    i += segLen;
  }
  throw new InlineImageUnsupportedError('JPEG missing SOF');
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 30) throw new InlineImageUnsupportedError('Truncated WebP');
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    // canvas size is 24-bit LE stored as (dim - 1) at offsets 24..29
    if (bytes.length < 30) throw new InlineImageUnsupportedError('Truncated VP8X');
    const width =
      1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height =
      1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // lossy: width/height 14-bit LE at frame header after 10-byte chunk hdr + 3 start code
    if (bytes.length < 30) throw new InlineImageUnsupportedError('Truncated VP8');
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    // lossless: 14-bit width-1 / height-1 packed in 4 bytes after chunk hdr + signature byte
    if (bytes.length < 25) throw new InlineImageUnsupportedError('Truncated VP8L');
    if (bytes[20] !== 0x2f) throw new InlineImageUnsupportedError('Invalid VP8L signature');
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  throw new InlineImageUnsupportedError('Unsupported WebP chunk');
}

function readDimensions(kind: RasterKind, bytes: Buffer): { width: number; height: number } {
  switch (kind) {
    case 'png':
      return readPngDimensions(bytes);
    case 'jpeg':
      return readJpegDimensions(bytes);
    case 'gif':
      return readGifDimensions(bytes);
    case 'webp':
      return readWebpDimensions(bytes);
  }
}

/**
 * Gate attachment bytes before serving as Content-Disposition: inline.
 * Magic bytes must match declared MIME; dimensions must stay within hard limits.
 */
export function assertSafeInlineRaster(bytes: Buffer, mimeType: string): void {
  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new InlineImageTooLargeError();
  }
  const mime = normalizeMime(mimeType);
  const expected = mimeToKind(mime);
  if (!expected) {
    throw new InlineImageUnsupportedError(`MIME not allowed: ${mime}`);
  }
  const detected = detectKind(bytes);
  if (!detected || detected !== expected) {
    throw new InlineImageUnsupportedError('MIME/signature mismatch');
  }
  const { width, height } = readDimensions(detected, bytes);
  assertDimensions(width, height);
}

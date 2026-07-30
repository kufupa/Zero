export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const MAX_INLINE_IMAGE_DIMENSION = 10_000;
const MAX_INLINE_IMAGE_PIXELS = 25_000_000;

export class InlineImageUnsupportedError extends Error {
  constructor(message = 'Unsupported inline image') {
    super(message);
    this.name = 'InlineImageUnsupportedError';
  }
}

export class InlineImageTooLargeError extends Error {
  constructor(message = 'Inline image exceeds 5 MiB') {
    super(message);
    this.name = 'InlineImageTooLargeError';
  }
}

type RasterKind = 'png' | 'jpeg' | 'gif' | 'webp';
type Dimensions = { width: number; height: number };

function unsupported(message: string): never {
  throw new InlineImageUnsupportedError(message);
}

function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

function kindForMimeType(mimeType: string): RasterKind | null {
  switch (mimeType) {
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

function detectRasterKind(bytes: Buffer): RasterKind | null {
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
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'gif';
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

function readPngDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 33) unsupported('Truncated PNG header');
  if (
    bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    unsupported('Invalid PNG IHDR');
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function readJpegDimensions(bytes: Buffer): Dimensions {
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) unsupported('Invalid JPEG marker');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) unsupported('Truncated JPEG marker');

    const marker = bytes[offset]!;
    offset += 1;

    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      unsupported('JPEG missing dimensions');
    }
    if (offset + 2 > bytes.length) unsupported('Truncated JPEG segment');

    const segmentLength = bytes.readUInt16BE(offset);
    if (
      segmentLength < 2 ||
      offset + segmentLength > bytes.length
    ) {
      unsupported('Invalid JPEG segment');
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      if (segmentLength < 8) unsupported('Truncated JPEG SOF');
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  return unsupported('JPEG missing dimensions');
}

function readGifDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 13) unsupported('Truncated GIF header');
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}

function readWebpDimensions(bytes: Buffer): Dimensions {
  if (bytes.length < 20) unsupported('Truncated WebP header');

  const declaredEnd = bytes.readUInt32LE(4) + 8;
  const chunkSize = bytes.readUInt32LE(16);
  const chunkEnd = 20 + chunkSize + (chunkSize % 2);
  if (
    declaredEnd < 20 ||
    declaredEnd > bytes.length ||
    chunkEnd > declaredEnd
  ) {
    unsupported('Truncated WebP chunk');
  }

  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    if (chunkSize < 10) unsupported('Truncated VP8X header');
    return {
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }

  if (chunk === 'VP8 ') {
    if (
      chunkSize < 10 ||
      (bytes[20]! & 1) !== 0 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      unsupported('Invalid VP8 frame header');
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (chunkSize < 5 || bytes[20] !== 0x2f) {
      unsupported('Invalid VP8L frame header');
    }
    const dimensions = bytes.readUInt32LE(21);
    return {
      width: (dimensions & 0x3fff) + 1,
      height: ((dimensions >>> 14) & 0x3fff) + 1,
    };
  }

  return unsupported('Unsupported WebP chunk');
}

function readDimensions(kind: RasterKind, bytes: Buffer): Dimensions {
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

function assertSafeDimensions({ width, height }: Dimensions): void {
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_INLINE_IMAGE_DIMENSION ||
    height > MAX_INLINE_IMAGE_DIMENSION ||
    width * height > MAX_INLINE_IMAGE_PIXELS
  ) {
    unsupported('Inline image dimensions exceed limits');
  }
}

/**
 * Validate bounded raster headers without decoding or accessing the network.
 */
export function assertSafeInlineRaster(
  bytes: Buffer,
  mimeType: string,
): void {
  if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new InlineImageTooLargeError();
  }

  const expectedKind = kindForMimeType(normalizeMimeType(mimeType));
  const detectedKind = detectRasterKind(bytes);
  if (!expectedKind || detectedKind !== expectedKind) {
    unsupported('Inline image MIME/signature mismatch');
  }

  assertSafeDimensions(readDimensions(expectedKind, bytes));
}

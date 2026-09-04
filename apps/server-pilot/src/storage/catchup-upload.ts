import { randomUUID } from 'node:crypto';
import {
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  getS3Storage,
  RealS3Storage,
  FakeS3Storage,
  type S3HeadResult,
} from './s3.js';

/** Presigned PUT expiration: 12 hours (43200s) to comfortably support large uploads. */
export const CATCHUP_PUT_EXPIRES_IN = 43200;

/** Absolute maximum upload size: 50 GiB (53,687,091,200 bytes). */
export const MAX_CATCHUP_FILE_BYTES = 53687091200;

/** Single PUT threshold: files <= 100 MiB use direct PUT; larger files use MPU. */
export const SINGLE_PUT_THRESHOLD_BYTES = 104857600;

/** Recommended MPU chunk size: 16 MiB. */
export const MPU_PART_SIZE_BYTES = 16777216;

export const ALLOWED_EXTENSIONS = ['.pst', '.zip', '.msg'] as const;

/** In-memory state for tracking fake multipart uploads in test / non-AWS environments. */
const fakeMultipartUploads = new Map<
  string,
  { key: string; contentType: string; totalSizeBytes?: number }
>();

/** Sanitize an uploaded filename: strip directory traversal and sanitize special characters. */
export function sanitizeCatchupFilename(raw: string): string {
  // Strip path traversal and directory separators (both Windows and POSIX)
  const basename = raw.split(/[/\\]/).pop() || '';
  const trimmed = basename.trim();

  // Extract extension if present
  const lastDot = trimmed.lastIndexOf('.');
  const ext = lastDot !== -1 ? trimmed.slice(lastDot).toLowerCase() : '';
  const nameWithoutExt = lastDot !== -1 ? trimmed.slice(0, lastDot) : trimmed;

  // Replace invalid characters with underscore, preserve alphanumeric and safe punctuation
  const cleanName = nameWithoutExt.replace(/[^a-zA-Z0-9._-]/g, '_');
  const cleanExt = ext.replace(/[^a-zA-Z0-9.]/g, '');

  const result = `${cleanName || 'upload'}${cleanExt}`;
  return result.length > 0 ? result : 'upload.bin';
}

/** Assert that a filename has an allowed extension and size is within bounds (1 byte to 50 GiB). */
export function assertCatchupAllowedFile(filename: string, sizeBytes: number): void {
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot !== -1 ? filename.slice(lastDot).toLowerCase() : '';

  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new Error(
      `Invalid catchup upload file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    );
  }

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`Invalid file size ${sizeBytes}`);
  }

  if (sizeBytes > MAX_CATCHUP_FILE_BYTES) {
    throw new Error(
      `File size ${sizeBytes} exceeds maximum 50 GB limit (${MAX_CATCHUP_FILE_BYTES} bytes)`,
    );
  }
}

/** Return the appropriate MIME Content-Type based on extension. */
export function contentTypeForCatchupFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pst') || lower.endsWith('.msg')) {
    return 'application/vnd.ms-outlook';
  }
  if (lower.endsWith('.zip')) {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

/** Build the canonical S3 key for a catch-up upload. */
export function buildCatchupS3Key(userId: string, uploadId: string, filename: string): string {
  const safeFilename = sanitizeCatchupFilename(filename);
  return `catchup-uploads/${userId}/${uploadId}/${safeFilename}`;
}

/** Presign a single PUT upload URL with required Content-Type and AES256 headers. */
export async function presignCatchupPut(opts: {
  key: string;
  contentType: string;
}): Promise<{
  uploadUrl: string;
  headers: Record<string, string>;
}> {
  const storage = getS3Storage();
  const headers = {
    'Content-Type': opts.contentType,
    'x-amz-server-side-encryption': 'AES256',
  };

  if (storage.kind === 'real' && storage instanceof RealS3Storage) {
    const cmd = new PutObjectCommand({
      Bucket: storage.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
      ServerSideEncryption: 'AES256',
    });
    const uploadUrl = await getSignedUrl(storage.client, cmd, {
      expiresIn: CATCHUP_PUT_EXPIRES_IN,
    });
    return { uploadUrl, headers };
  }

  // Fake S3 path
  const uploadUrl = `zero-fake-s3://${storage.bucket}/${opts.key}?mode=single`;
  return { uploadUrl, headers };
}

/** Initiate an S3 multipart upload and return the S3 uploadId. */
export async function createCatchupMultipart(opts: {
  key: string;
  contentType: string;
}): Promise<string> {
  const storage = getS3Storage();

  if (storage.kind === 'real' && storage instanceof RealS3Storage) {
    const cmd = new CreateMultipartUploadCommand({
      Bucket: storage.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
      ServerSideEncryption: 'AES256',
    });
    const res = await storage.client.send(cmd);
    if (!res.UploadId) {
      throw new Error('S3 failed to return UploadId for CreateMultipartUpload');
    }
    return res.UploadId;
  }

  // Fake S3 path
  const fakeUploadId = `fake-mpu-${randomUUID()}`;
  fakeMultipartUploads.set(fakeUploadId, {
    key: opts.key,
    contentType: opts.contentType,
  });
  return fakeUploadId;
}

/** Presign a single part upload URL for an active multipart upload. */
export async function presignCatchupPart(opts: {
  key: string;
  uploadId: string;
  partNumber: number;
}): Promise<{
  partNumber: number;
  uploadUrl: string;
}> {
  const storage = getS3Storage();

  if (storage.kind === 'real' && storage instanceof RealS3Storage) {
    const cmd = new UploadPartCommand({
      Bucket: storage.bucket,
      Key: opts.key,
      UploadId: opts.uploadId,
      PartNumber: opts.partNumber,
    });
    const uploadUrl = await getSignedUrl(storage.client, cmd, {
      expiresIn: CATCHUP_PUT_EXPIRES_IN,
    });
    return { partNumber: opts.partNumber, uploadUrl };
  }

  // Fake S3 path
  const uploadUrl = `zero-fake-s3://${storage.bucket}/${opts.key}?uploadId=${opts.uploadId}&partNumber=${opts.partNumber}`;
  return { partNumber: opts.partNumber, uploadUrl };
}

/** Complete an active S3 multipart upload. */
export async function completeCatchupMultipart(opts: {
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
  totalSizeBytes?: number;
}): Promise<void> {
  const storage = getS3Storage();

  if (storage.kind === 'real' && storage instanceof RealS3Storage) {
    // S3 requires parts sorted by PartNumber ascending
    const sortedParts = [...opts.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
      }));

    const cmd = new CompleteMultipartUploadCommand({
      Bucket: storage.bucket,
      Key: opts.key,
      UploadId: opts.uploadId,
      MultipartUpload: { Parts: sortedParts },
    });
    await storage.client.send(cmd);
    return;
  }

  // Fake S3 path: record completed entry in fake storage
  const mpu = fakeMultipartUploads.get(opts.uploadId);
  const contentType = mpu?.contentType ?? 'application/octet-stream';
  fakeMultipartUploads.delete(opts.uploadId);

  if (storage instanceof FakeS3Storage) {
    const size = opts.totalSizeBytes ?? 1024;
    storage.stored.set(opts.key, {
      body: Buffer.alloc(size),
      contentType,
    });
  }
}

/** Abort an active S3 multipart upload. */
export async function abortCatchupMultipart(opts: {
  key: string;
  uploadId: string;
}): Promise<void> {
  const storage = getS3Storage();

  if (storage.kind === 'real' && storage instanceof RealS3Storage) {
    const cmd = new AbortMultipartUploadCommand({
      Bucket: storage.bucket,
      Key: opts.key,
      UploadId: opts.uploadId,
    });
    await storage.client.send(cmd);
    return;
  }

  // Fake S3 path
  fakeMultipartUploads.delete(opts.uploadId);
}

/** Probe S3 for object existence and metadata. Returns null if object does not exist. */
export async function headCatchupObject(key: string): Promise<S3HeadResult | null> {
  return getS3Storage().headObject(key);
}

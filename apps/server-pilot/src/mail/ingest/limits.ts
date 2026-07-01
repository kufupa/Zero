/**
 * Ingest size limits (Notes N2, N3).
 *
 * Bounds raw MIME and per-attachment bytes during POP3 ingest. Defaults are
 * 25MB message / 15MB attachment; override via optional env vars.
 */
import type { EnvInput } from '../../env.js';

export const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export interface IngestLimits {
  maxMessageBytes: number;
  maxAttachmentBytes: number;
}

export class IngestTooLargeError extends Error {
  readonly kind: 'message' | 'attachment';
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(
    kind: 'message' | 'attachment',
    sizeBytes: number,
    limitBytes: number,
  ) {
    super(`ingest ${kind} too large: ${sizeBytes} bytes exceeds ${limitBytes}`);
    this.name = 'IngestTooLargeError';
    this.kind = kind;
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

function toPositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`env ${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

export function getIngestLimits(input: EnvInput = process.env): IngestLimits {
  const maxMessageBytes = input.INGEST_MAX_MESSAGE_BYTES
    ? toPositiveInt('INGEST_MAX_MESSAGE_BYTES', input.INGEST_MAX_MESSAGE_BYTES)
    : DEFAULT_MAX_MESSAGE_BYTES;
  const maxAttachmentBytes = input.INGEST_MAX_ATTACHMENT_BYTES
    ? toPositiveInt(
        'INGEST_MAX_ATTACHMENT_BYTES',
        input.INGEST_MAX_ATTACHMENT_BYTES,
      )
    : DEFAULT_MAX_ATTACHMENT_BYTES;
  return { maxMessageBytes, maxAttachmentBytes };
}

export function assertWithinIngestLimits(
  sizeBytes: number,
  kind: 'message' | 'attachment',
  limits: IngestLimits = getIngestLimits(),
): void {
  const limitBytes =
    kind === 'message' ? limits.maxMessageBytes : limits.maxAttachmentBytes;
  if (sizeBytes > limitBytes) {
    throw new IngestTooLargeError(kind, sizeBytes, limitBytes);
  }
}

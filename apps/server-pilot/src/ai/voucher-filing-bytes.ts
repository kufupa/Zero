import { createHash } from 'node:crypto';

/** Maximum source document size supported by the Cloud filing adapter. */
export const MAX_VOUCHER_FILING_BYTES = 10 * 1024 * 1024;

type ByteRead = {
  expectedBytes: number;
  /** Absent only at prepare for a legacy attachment without an ingest hash. */
  expectedSha256: string | null;
  signal: AbortSignal;
  readBounded: (maxBytes: number, signal: AbortSignal) => Promise<Uint8Array | null>;
};

/** Read bounded PDF bytes and compute their digest; any supplied digest must match. */
export async function readAndHashVoucherBytes(input: ByteRead): Promise<{ bytes: Buffer; sha256: string } | null> {
  if (
    input.signal.aborted ||
    !Number.isSafeInteger(input.expectedBytes) ||
    input.expectedBytes <= 0 ||
    input.expectedBytes > MAX_VOUCHER_FILING_BYTES ||
    (input.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(input.expectedSha256))
  ) return null;

  try {
    const fetched = await input.readBounded(input.expectedBytes, input.signal);
    if (input.signal.aborted || !fetched) return null;
    // Own the exact bytes handed to the adapter even when the reader retains its buffer.
    const bytes = Buffer.from(fetched);
    if (bytes.length !== input.expectedBytes || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return null;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (input.expectedSha256 !== null && sha256 !== input.expectedSha256) return null;
    return { bytes, sha256 };
  } catch {
    return null;
  }
}

/** Require a pre-existing digest when reading bytes for an already approved form. */
export async function readVerifiedVoucherBytes(input: ByteRead): Promise<Buffer | null> {
  if (input.expectedSha256 === null) return null;
  return (await readAndHashVoucherBytes(input))?.bytes ?? null;
}

import { z } from 'zod';
import type { SyncSealedArtifact } from '../outlook-sync/storage.js';
import { MAX_VOUCHER_FILING_BYTES } from './voucher-filing-bytes.js';

/** Version ID is optional; identity and bytes must still be checked when reading the receipt. */
export const voucherFilingReceiptSchema = z.object({
  key: z.string().min(1).max(1024),
  bytes: z.number().int().positive().max(MAX_VOUCHER_FILING_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  eTag: z.string().min(1).max(1024).refine((value) => !/[\r\n]/.test(value)),
  versionId: z.string().min(1).max(1024).refine((value) => !/[\r\n]/.test(value)).optional(),
}).strict();

export function parseVoucherFilingReceipt(value: unknown): SyncSealedArtifact | null {
  const parsed = voucherFilingReceiptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

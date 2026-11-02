import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Immutable, DB-approved Cloud operation. The authenticated server constructs this, never the pane. */
export const voucherFilingFormSchema = z.object({
  executor: z.literal('cloud-write/v1'),
  action: z.literal('attach_document'),
  propertyCode: z.string().regex(/^[A-Z0-9]{1,20}$/),
  payload: z.object({
    source: z.object({
      transportId: z.string().min(1).max(200),
      messageId: z.string().min(1).max(200),
      attachmentId: z.string().min(1).max(200),
      filename: z.string().min(1).max(150).refine((s) => !s.includes('/') && !s.includes('\\') &&
        [...s].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)),
      mimeType: z.literal('application/pdf'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      /** Digest of the server-resolved, version-bound private source receipt. */
      snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
    stay: z.object({
      confirmation: z.string().regex(/^\d+-\d+$/),
      arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
      }),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
    }).strict(),
    kind: z.enum(['voucher', 'proof_of_payment']),
  }).strict(),
}).strict();

export type VoucherFilingForm = z.infer<typeof voucherFilingFormSchema>;

/** Verify the fetched source after ownership and approval checks, immediately before dispatch. */
export function validateVoucherFilingBytes(form: VoucherFilingForm, bytes: Buffer):
  | 'ok' | 'unsupported_format' | 'invalid_size' | 'hash_mismatch' {
  if (!voucherFilingFormSchema.safeParse(form).success || !/\.pdf$/i.test(form.payload.source.filename)) return 'unsupported_format';
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) return 'invalid_size';
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'unsupported_format';
  if (createHash('sha256').update(bytes).digest('hex') !== form.payload.source.sha256) return 'hash_mismatch';
  return 'ok';
}

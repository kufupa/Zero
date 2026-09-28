import { createHash } from 'node:crypto';
import { z } from 'zod';

const opaqueRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque document reference');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);

export const hmsDocumentReadRequestSchema = z
  .object({
    toolId: z.literal('hms_read_document'),
    candidateId: opaqueRef,
    documentRef: opaqueRef,
    format: z.literal('bytes'),
  })
  .strict();
export type HmsDocumentReadRequest = z.infer<typeof hmsDocumentReadRequestSchema>;

export const hmsDocumentReadDataSchema = z
  .object({
    documentRef: opaqueRef,
    mimeType: z.string().min(1).max(128),
    byteLength: z.number().int().nonnegative().max(4 * 1024 * 1024),
    sha256,
    /** Base64 is returned only from a genuine HMS byte provider, never mail. */
    bytesBase64: z.string().max(5_600_000),
    observedAt: z.string().datetime({ offset: true }),
    source: z.literal('hms'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.byteLength === 0 && value.bytesBase64 !== '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bytesBase64'],
        message: 'zero-length HMS document must carry empty bytes',
      });
      return;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bytesBase64'],
        message: 'HMS document bytes must be canonical base64',
      });
      return;
    }
    const bytes = Buffer.from(value.bytesBase64, 'base64');
    if (bytes.byteLength !== value.byteLength) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['byteLength'],
        message: 'HMS document byteLength does not match bytesBase64',
      });
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== value.sha256.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sha256'],
        message: 'HMS document sha256 does not match bytesBase64',
      });
    }
  });
export type HmsDocumentReadData = z.infer<typeof hmsDocumentReadDataSchema>;

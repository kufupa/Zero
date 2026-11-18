import { z } from 'zod';

const id = z.string().min(1).max(200);
export const quoteDraftBindingSchema = z.object({
  proposalId: id, revision: z.number().int().positive().safe(), quoteId: id, jobId: id,
  artifactIds: z.tuple([z.string().uuid(), z.string().uuid()]).refine(ids => ids[0] !== ids[1]),
}).strict();
export type QuoteDraftBinding = z.infer<typeof quoteDraftBindingSchema>;

export function matchesQuoteDraftBinding(attachments: readonly unknown[], binding: QuoteDraftBinding): boolean {
  return [
    { filename: 'Quotation.pdf', mimeType: 'application/pdf', id: binding.artifactIds[0] },
    { filename: 'Quotation.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', id: binding.artifactIds[1] },
  ].every(expected => attachments.filter(attachment => {
    if (!attachment || typeof attachment !== 'object' || !('quoteBinding' in attachment)) return false;
    const row = attachment as { filename?: unknown; mimeType?: unknown; quoteBinding: unknown; quoteArtifactId?: unknown };
    const parsed = quoteDraftBindingSchema.safeParse(row.quoteBinding);
    if (!parsed.success) return false;
    const saved = parsed.data;
    return row.filename === expected.filename && row.mimeType === expected.mimeType && row.quoteArtifactId === expected.id &&
      saved.proposalId === binding.proposalId && saved.revision === binding.revision &&
      saved.quoteId === binding.quoteId && saved.jobId === binding.jobId &&
      saved.artifactIds[0] === binding.artifactIds[0] && saved.artifactIds[1] === binding.artifactIds[1];
  }).length === 1);
}

export function matchesQuoteDraftJob(attachments: readonly unknown[], binding: QuoteDraftBinding): boolean {
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object' || !('quoteBinding' in attachment)) continue;
    const parsed = quoteDraftBindingSchema.safeParse(attachment.quoteBinding);
    if (!parsed.success) continue;
    const saved = parsed.data;
    if (saved.proposalId === binding.proposalId && saved.revision === binding.revision &&
        saved.quoteId === binding.quoteId && saved.jobId === binding.jobId && matchesQuoteDraftBinding(attachments, saved)) return true;
  }
  return false;
}

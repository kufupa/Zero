import { z } from 'zod';

const id = z.string().min(1).max(200);
export const quoteDraftBindingSchema = z.object({
  proposalId: id, revision: z.number().int().positive().safe(), quoteId: id, jobId: id,
  artifactIds: z.array(z.string().uuid()).min(2).max(64).refine(ids => ids.length % 2 === 0 && new Set(ids).size === ids.length),
}).strict();
export type QuoteDraftBinding = z.infer<typeof quoteDraftBindingSchema>;

export function matchesQuoteDraftBinding(attachments: readonly unknown[], binding: QuoteDraftBinding): boolean {
  return binding.artifactIds.every((id,index) => attachments.filter(attachment => {
    if (!attachment || typeof attachment !== 'object' || !('quoteBinding' in attachment)) return false;
    const row = attachment as { filename?: unknown; mimeType?: unknown; quoteBinding: unknown; quoteArtifactId?: unknown };
    const parsed = quoteDraftBindingSchema.safeParse(row.quoteBinding);
    if (!parsed.success) return false;
    const saved = parsed.data;
    const filename=binding.artifactIds.length===2 ? `Quotation.${index%2===0?'pdf':'xlsx'}` : `Quotation ${Math.floor(index/2)+1}.${index%2===0?'pdf':'xlsx'}`;
    const mimeType=index%2===0?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return row.filename === filename && row.mimeType === mimeType && row.quoteArtifactId === id &&
      saved.proposalId === binding.proposalId && saved.revision === binding.revision &&
      saved.quoteId === binding.quoteId && saved.jobId === binding.jobId &&
      saved.artifactIds.length === binding.artifactIds.length && saved.artifactIds.every((value,i)=>value===binding.artifactIds[i]);
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

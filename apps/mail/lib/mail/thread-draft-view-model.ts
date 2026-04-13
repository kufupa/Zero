import type { ParsedMessage } from '@/types';
import { plainTextDraftPreview } from './draft-preview';

export type ThreadDraftViewModel = {
  id: string;
  subject: string;
  bodyPreview: string;
  savedAtIso: string;
};

export function buildThreadDraftViewModel(
  latestDraft: ParsedMessage | undefined,
): ThreadDraftViewModel | null {
  if (!latestDraft?.isDraft) return null;

  const raw = latestDraft.decodedBody || latestDraft.body || '';
  const bodyPreview = plainTextDraftPreview(raw);
  const savedAtIso = latestDraft.receivedOn.split('.')[0] || latestDraft.receivedOn;

  return {
    id: latestDraft.id,
    subject: latestDraft.subject?.trim() || '',
    bodyPreview,
    savedAtIso,
  };
}

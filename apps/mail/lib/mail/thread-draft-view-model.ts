import type { ParsedDraft } from '@zero/server/driver/types';
import type { ParsedMessage } from '@/types';
import { plainTextDraftPreview } from './draft-preview';

export type ThreadDraftViewModel = {
  id: string;
  subject: string;
  bodyPreview: string;
  savedAtIso: string;
  origin: 'manual' | 'ai';
  status: 'active' | 'candidate' | 'discarded' | 'sent';
  isStale: boolean;
};

function isParsedMessage(draft: ParsedDraft | ParsedMessage): draft is ParsedMessage {
  return 'isDraft' in draft;
}

export function buildThreadDraftViewModel(
  draft: ParsedDraft | ParsedMessage | undefined,
): ThreadDraftViewModel | null {
  if (!draft) return null;

  if (isParsedMessage(draft)) {
    if (!draft.isDraft) return null;

    const raw = draft.decodedBody || draft.body || '';
    const bodyPreview = plainTextDraftPreview(raw);
    const savedAtIso = draft.receivedOn.split('.')[0] || draft.receivedOn;

    return {
      id: draft.id,
      subject: draft.subject?.trim() || '',
      bodyPreview,
      savedAtIso,
      origin: 'manual',
      status: 'active',
      isStale: false,
    };
  }

  const raw = draft.content ?? '';
  const bodyPreview = plainTextDraftPreview(raw);
  const savedAtIso = draft.updatedAt.split('.')[0] || draft.updatedAt;

  return {
    id: draft.id,
    subject: draft.subject?.trim() || '',
    bodyPreview,
    savedAtIso,
    origin: draft.origin,
    status: draft.status,
    isStale: draft.isStale,
  };
}

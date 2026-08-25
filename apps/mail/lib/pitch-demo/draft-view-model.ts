import type { ThreadDraftViewModel } from '@/lib/mail/thread-draft-view-model';
import { PITCH_DEMO_DRAFT_BODY, PITCH_DEMO_DRAFT_SUBJECT } from './config';

export function buildPitchDemoDraftViewModel(now = new Date()): ThreadDraftViewModel {
  const savedAtIso = now.toISOString().split('.')[0] ?? now.toISOString();

  return {
    id: 'pitch-demo-draft',
    subject: PITCH_DEMO_DRAFT_SUBJECT,
    bodyPreview: PITCH_DEMO_DRAFT_BODY.trim(),
    savedAtIso,
    origin: 'ai',
    status: 'candidate',
    isStale: false,
    aiOutcome: 'candidate',
    freshness: 'fresh',
    refreshState: 'idle',
    unresolvedFields: [],
  };
}

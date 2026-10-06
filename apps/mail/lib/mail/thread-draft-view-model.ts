import type { DraftCardAttachment } from '@/components/mail/thread-draft-card';
import type { ParsedDraft } from '@zero/server/driver/types';
import { plainTextDraftPreview } from './draft-preview';
import type { ParsedMessage } from '@/types';

export type HmsCandidateFreshness = 'fresh' | 'stale_thread' | 'stale_evidence' | 'unknown';
export type HmsCandidateOutcome = 'candidate' | 'needs_clarification' | 'insufficient_evidence';
export type HmsRefreshState = 'queued' | 'claimed' | 'running' | 'retry_wait' | 'idle' | 'failed';

export type DraftReviewInput = {
  origin: 'manual' | 'ai';
  isStale: boolean;
  body: string;
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachmentKeys: string[];
  evidenceVersion: string | null | undefined;
  approvedFingerprint?: string | null;
};

export type DraftReviewState = 'manual' | 'review' | 'approved';

/** UI-only review identity; the server's closed approval token remains authoritative. */
export function draftApprovalReviewFingerprint(
  input: Omit<DraftReviewInput, 'approvedFingerprint'>,
): string {
  return [
    input.origin,
    input.isStale ? 'stale' : 'fresh',
    input.body,
    input.subject,
    input.to.join('\u001f'),
    input.cc.join('\u001f'),
    input.bcc.join('\u001f'),
    input.attachmentKeys.join('\u001f'),
    input.evidenceVersion ?? '',
  ].join('\u001e');
}

export function resolveDraftReviewState(input: DraftReviewInput): DraftReviewState {
  if (input.origin === 'manual') return 'manual';
  if (input.isStale) return 'review';
  return input.approvedFingerprint === draftApprovalReviewFingerprint(input)
    ? 'approved'
    : 'review';
}

export type ThreadDraftViewModel = {
  id: string;
  subject: string;
  bodyPreview: string;
  savedAtIso: string;
  origin: 'manual' | 'ai';
  status: 'active' | 'candidate' | 'discarded' | 'sent';
  isStale: boolean;
  aiOutcome?: HmsCandidateOutcome | null;
  freshness?: HmsCandidateFreshness;
  refreshState?: HmsRefreshState | null;
  unresolvedFields?: string[];
  readinessLabel?: string;
  readinessReason?: string;
  attachments?: DraftCardAttachment[];
  tasks?: { label: string; state: string; details?: string[] }[];
  pricingProof?: string[];
};

export type HmsCandidateStateInput = {
  outcome?: HmsCandidateOutcome | null;
  freshness?: HmsCandidateFreshness;
  activeRun?: { id: string; state: 'queued' | 'claimed' | 'running' | 'retry_wait' } | null;
  unresolvedFields?: string[];
};

function isParsedMessage(draft: ParsedDraft | ParsedMessage): draft is ParsedMessage {
  return 'isDraft' in draft;
}

export function resolveRefreshState(
  activeRun: HmsCandidateStateInput['activeRun'],
): HmsRefreshState | null {
  if (!activeRun) return 'idle';
  return activeRun.state;
}

export function buildThreadDraftViewModel(
  draft: ParsedDraft | ParsedMessage | undefined,
  hms?: HmsCandidateStateInput | null,
): ThreadDraftViewModel | null {
  if (!draft) return null;

  const hmsFields =
    hms != null
      ? {
          aiOutcome: hms.outcome ?? null,
          freshness: hms.freshness ?? 'unknown',
          refreshState: resolveRefreshState(hms.activeRun),
          unresolvedFields: hms.unresolvedFields ?? [],
        }
      : {};

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
      ...hmsFields,
    };
  }

  const extended = draft as typeof draft & {
    attachments?: (DraftCardAttachment & { sizeBytes?: number; sourceHash?: string | null })[];
    reviewSummary?: {
      readinessLabel?: string;
      reason?: string;
      tasks?: { label: string; state: string; details?: string[] }[];
      pricingProof?: string[];
    };
  };
  const attachments = extended.attachments ?? [];
  const summary = extended.reviewSummary;
  const unavailable = attachments.some((a) => a.state !== 'available');
  const raw = draft.content ?? '';
  const bodyPreview = plainTextDraftPreview(raw);
  const savedAtIso = draft.updatedAt.split('.')[0] || draft.updatedAt;
  const freshness = hms?.freshness;
  const isStale = draft.isStale || (freshness != null && freshness !== 'fresh');

  return {
    id: draft.id,
    readinessLabel: unavailable ? 'Attachment unavailable' : summary?.readinessLabel,
    readinessReason: unavailable
      ? 'A required attachment must be available before sending.'
      : summary?.reason,
    attachments,
    tasks: summary?.tasks,
    pricingProof: summary?.pricingProof,
    subject: draft.subject?.trim() || '',
    bodyPreview,
    savedAtIso,
    origin: draft.origin,
    status: draft.status,
    isStale,
    ...hmsFields,
  };
}

export function hmsCandidateNotice(vm: ThreadDraftViewModel): string | null {
  if (vm.origin !== 'ai') return null;
  const pending =
    vm.refreshState === 'queued' ||
    vm.refreshState === 'claimed' ||
    vm.refreshState === 'running' ||
    vm.refreshState === 'retry_wait';
  if (pending) return 'Refreshing hotel data. Prior candidate stays visible.';
  if (vm.aiOutcome === 'needs_clarification') {
    return 'Needs clarification before this draft can be used.';
  }
  if (vm.aiOutcome === 'insufficient_evidence') {
    return 'Insufficient hotel evidence for an automated candidate.';
  }
  if (vm.freshness === 'stale_thread' || vm.freshness === 'stale_evidence') {
    return 'Information expired. Refresh before using this draft.';
  }
  if (vm.freshness === 'unknown' && vm.status === 'candidate') {
    return 'Candidate reply. Review before sending.';
  }
  return null;
}

export function canRefreshHmsCandidate(vm: ThreadDraftViewModel | null): boolean {
  if (!vm || vm.origin !== 'ai') return false;
  const pending =
    vm.refreshState === 'queued' ||
    vm.refreshState === 'claimed' ||
    vm.refreshState === 'running' ||
    vm.refreshState === 'retry_wait';
  return !pending;
}

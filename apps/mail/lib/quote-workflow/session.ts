import type {
  QuoteOffer,
  QuoteSession,
  QuoteSessionAction,
  QuoteSelectionBinding,
  StayGroupRequirement,
} from './types';

export function selectionDigest(binding: QuoteSelectionBinding): string {
  return [
    binding.transportId,
    binding.mailboxEmail,
    binding.storeId,
    binding.folderEntryId,
    binding.entryId,
    binding.internetMessageId ?? '',
  ].join('|');
}

export function initialQuoteSession(): QuoteSession {
  return {
    phase: 'idle',
    binding: null,
    analysis: null,
    groups: [],
    inputRevision: 1,
    offers: [],
    selectedOfferIds: [],
    pdf: null,
    reviewedReplyHtml: '',
    steps: [],
    missing: [],
    errorMessage: null,
    runningStepId: null,
  };
}

export function allocationTotal(offers: readonly QuoteOffer[]): number {
  return offers
    .filter((offer) => offer.kind === 'allocation')
    .reduce((sum, offer) => sum + offer.stayTotalMinor, 0);
}

export function canCreatePdf(session: QuoteSession): boolean {
  return session.selectedOfferIds.some((id) =>
    session.offers.some((offer) => offer.id === id && offer.kind === 'allocation' && offer.sourceRef),
  );
}

export function canCreateNativeDraft(session: QuoteSession): boolean {
  return Boolean(session.pdf && session.reviewedReplyHtml.trim() && canCreatePdf(session));
}

function clearDownstream(session: QuoteSession): QuoteSession {
  return {
    ...session,
    offers: [],
    selectedOfferIds: [],
    pdf: null,
    runningStepId: null,
  };
}

function applyGroupPatch(
  group: StayGroupRequirement,
  patch: Partial<StayGroupRequirement>,
): StayGroupRequirement {
  const fields = { ...group.fields };
  for (const key of Object.keys(patch) as (keyof StayGroupRequirement)[]) {
    if (key === 'id' || key === 'fields') continue;
    fields[String(key)] = 'staff_corrected';
  }
  return { ...group, ...patch, id: group.id, fields };
}

export function reduceQuoteSession(session: QuoteSession, action: QuoteSessionAction): QuoteSession {
  switch (action.type) {
    case 'selection': {
      const current = session.binding ? selectionDigest(session.binding) : null;
      const next = selectionDigest(action.binding);
      if (current === next && session.analysis && session.phase !== 'idle') {
        return { ...session, binding: action.binding };
      }
      return {
        ...initialQuoteSession(),
        binding: action.binding,
      };
    }
    case 'analysis_started':
      return { ...session, phase: 'analysing', errorMessage: null };
    case 'analysis_ready': {
      if (action.analysis.intent !== 'quote') {
        return {
          ...session,
          phase: 'non_quote',
          analysis: action.analysis,
          groups: [],
        };
      }
      return {
        ...session,
        phase: 'requirements',
        analysis: action.analysis,
        groups: action.analysis.groups,
        inputRevision: 1,
      };
    }
    case 'analysis_unsynced':
      return { ...session, phase: 'unsynced' };
    case 'analysis_missing_source':
      return { ...session, phase: 'missing_source', missing: action.missing };
    case 'analysis_failed':
      return { ...session, phase: 'failed', errorMessage: action.message };
    case 'analysis_unsupported':
      return { ...session, phase: 'unsupported', errorMessage: action.message };
    case 'patch_group': {
      const groups = session.groups.map((group) =>
        group.id === action.groupId ? applyGroupPatch(group, action.patch) : group,
      );
      return clearDownstream({
        ...session,
        groups,
        inputRevision: session.inputRevision + 1,
        phase: 'requirements',
      });
    }
    case 'results_ready': {
      if (
        action.selectionEpoch !== undefined &&
        session.binding &&
        action.selectionEpoch !== session.binding.selectionEpoch
      ) {
        return session;
      }
      return { ...session, phase: 'results', offers: action.offers, runningStepId: null };
    }
    case 'step_running':
      return { ...session, phase: 'tools', runningStepId: action.stepId };
    case 'pdf_ready':
      return { ...session, pdf: action.pdf, phase: 'review' };
    case 'set_reviewed_reply':
      return { ...session, reviewedReplyHtml: action.html };
    case 'select_offers':
      return { ...session, selectedOfferIds: action.offerIds, pdf: null };
    default:
      return session;
  }
}

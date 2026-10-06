import type {
  QuoteEvidenceProvenance,
  QuoteOffer,
  QuoteSession,
  QuoteSessionAction,
  QuoteSelectionBinding,
  QuoteToolStep,
  StayGroupRequirement,
} from './types';

export function planQuoteSteps(groups: StayGroupRequirement[]): QuoteToolStep[] {
  const steps: QuoteToolStep[] = [];
  const organisation = groups.map((group) => group.organisation).find((value) => Boolean(value?.trim()));
  if (organisation) {
    steps.push({
      id: 'party-lookup',
      kind: 'party_lookup',
      title: `Look up organisation ${organisation}`,
      inputs: { organisation },
      dependsOn: [],
      status: 'ready',
      shareKey: organisation.trim().toLowerCase(),
    });
  }
  const byDates = new Map<string, StayGroupRequirement[]>();
  for (const group of groups) {
    const key = `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}`;
    const list = byDates.get(key) ?? [];
    list.push(group);
    byDates.set(key, list);
  }
  for (const [key, grouped] of byDates) {
    steps.push({
      id: `quote-stay-${key}`,
      kind: 'quote_stay',
      title: `Search availability ${key.replace(':', ' → ')}`,
      inputs: { quoteRequestKey: key, groupIds: grouped.map((group) => group.id) },
      dependsOn: organisation ? ['party-lookup'] : [],
      status: organisation ? 'queued' : 'ready',
      shareKey: key,
    });
  }
  return steps;
}

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
    mailboxStatus: null,
    evidence: null,
  };
}

export function allocationTotal(offers: readonly QuoteOffer[]): number {
  return offers
    .filter((offer) => offer.kind === 'allocation')
    .reduce((sum, offer) => sum + offer.stayTotalMinor, 0);
}

export function evidenceMatchesSession(session: QuoteSession): boolean {
  const evidence = session.evidence;
  if (!evidence) return false;
  if (evidence.inputRevision !== session.inputRevision) return false;
  if (session.binding && evidence.selectionEpoch !== session.binding.selectionEpoch) return false;
  return true;
}

export function canCreatePdf(session: QuoteSession): boolean {
  if (!evidenceMatchesSession(session) || session.evidence?.kind !== 'authorised') return false;
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
    evidence: null,
    reviewedReplyHtml: '',
    errorMessage: null,
  };
}

function requestMatchesCurrent(
  session: QuoteSession,
  selectionEpoch: number,
  inputRevision: number,
): boolean {
  if (!session.binding) return false;
  return (
    session.binding.selectionEpoch === selectionEpoch && session.inputRevision === inputRevision
  );
}

function sameSelectedOfferIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, i) => id === b[i]);
}

function provenanceMatches(
  session: QuoteSession,
  provenance: QuoteEvidenceProvenance,
  selectionEpoch?: number,
  inputRevision?: number,
): boolean {
  if (provenance.inputRevision !== session.inputRevision) return false;
  if (inputRevision !== undefined && inputRevision !== session.inputRevision) return false;
  if (session.binding && provenance.selectionEpoch !== session.binding.selectionEpoch) return false;
  if (
    selectionEpoch !== undefined &&
    session.binding &&
    selectionEpoch !== session.binding.selectionEpoch
  ) {
    return false;
  }
  return true;
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
        steps: planQuoteSteps(action.analysis.groups),
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
      if (!action.provenance) return session;
      if (!provenanceMatches(session, action.provenance, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      return {
        ...session,
        phase: 'results',
        offers: action.offers,
        evidence: action.provenance,
        errorMessage: null,
        runningStepId: null,
        reviewedReplyHtml: action.reviewedReplyHtml ?? session.reviewedReplyHtml,
        steps: session.steps.map((step) =>
          step.status === 'running' || step.id === session.runningStepId
            ? { ...step, status: 'succeeded' as const }
            : step,
        ),
      };
    }
    case 'results_unavailable':
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        offers: [],
        selectedOfferIds: [],
        pdf: null,
        evidence: null,
        errorMessage: action.reason,
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? { ...step, status: 'failed' as const, retryGuidance: action.reason }
            : step,
        ),
      };
    case 'step_running':
      return {
        ...session,
        phase: 'tools',
        runningStepId: action.stepId,
        steps: session.steps.map((step) =>
          step.id === action.stepId ? { ...step, status: 'running' as const } : step,
        ),
      };
    case 'step_failed':
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? { ...step, status: 'failed' as const, retryGuidance: action.retryGuidance }
            : step,
        ),
      };
    case 'pdf_ready':
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      if (!sameSelectedOfferIds(action.selectedOfferIds, session.selectedOfferIds)) {
        return session;
      }
      return { ...session, pdf: action.pdf, phase: 'review' };
    case 'set_reviewed_reply':
      return { ...session, reviewedReplyHtml: action.html };
    case 'select_offers':
      return { ...session, selectedOfferIds: action.offerIds, pdf: null };
    case 'mailbox_status':
      return { ...session, mailboxStatus: action.status };
    default:
      return session;
  }
}

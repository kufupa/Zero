import type {
  ApprovedStayGroup,
  PartyLookupRef,
  QuoteEvidenceProvenance,
  QuoteOffer,
  QuoteSession,
  QuoteSessionAction,
  QuoteSelectionBinding,
  QuoteStepInputs,
  QuoteToolStep,
  StayGroupRequirement,
} from './types';

export function toApprovedStayGroup(group: StayGroupRequirement): ApprovedStayGroup {
  return {
    id: group.id,
    arrivalDate: group.arrivalDate,
    departureDate: group.departureDate,
    quantity: group.quantity,
    roomPreference: group.roomPreference,
    adults: group.adults,
    childrenAges: [...group.childrenAges],
    board: group.board,
    organisation: group.organisation,
    specialRequests: [...group.specialRequests],
  };
}

export function groupsForQuoteStep(session: QuoteSession, step: QuoteToolStep): StayGroupRequirement[] {
  if (step.kind === 'quote_stay' && step.shareKey) {
    return session.groups.filter(
      (group) => `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}` === step.shareKey,
    );
  }
  return session.groups;
}

export function buildQuoteStepInputs(session: QuoteSession, step: QuoteToolStep): QuoteStepInputs {
  const binding = session.binding;
  return {
    stepKind: step.kind,
    binding: {
      transportId: binding?.transportId ?? '',
      mailboxEmail: binding?.mailboxEmail ?? '',
      storeId: binding?.storeId ?? '',
      folderEntryId: binding?.folderEntryId ?? '',
      entryId: binding?.entryId ?? '',
      internetMessageId: binding?.internetMessageId,
      selectionEpoch: binding?.selectionEpoch ?? 0,
    },
    groups: groupsForQuoteStep(session, step).map(toApprovedStayGroup),
    ...(session.partyLookup ? { party: session.partyLookup } : {}),
  };
}

export function planQuoteSteps(groups: StayGroupRequirement[]): QuoteToolStep[] {
  const steps: QuoteToolStep[] = [];
  const organisation = groups.map((group) => group.organisation).find((value) => Boolean(value?.trim()));
  if (organisation) {
    steps.push({
      id: 'party-lookup',
      kind: 'party_lookup',
      title: `Look up organisation ${organisation}`,
      inputs: { organisation, groups: groups.map(toApprovedStayGroup) },
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
      inputs: {
        quoteRequestKey: key,
        groupIds: grouped.map((group) => group.id),
        groups: grouped.map(toApprovedStayGroup),
      },
      dependsOn: organisation ? ['party-lookup'] : [],
      status: organisation ? 'queued' : 'ready',
      shareKey: key,
    });
  }
  return steps;
}

export function requestedQuoteKeys(groups: StayGroupRequirement[]): string[] {
  return [
    ...new Set(groups.map((group) => `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}`)),
  ];
}

export function parseChildrenAges(raw: string): number[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => Number(part))
    .filter((age) => Number.isFinite(age) && age >= 0);
}

export function formatQuoteStepInputs(inputs: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof inputs.organisation === 'string' && inputs.organisation.trim()) {
    bits.push(`Organisation ${inputs.organisation.trim()}`);
  }
  if (typeof inputs.quoteRequestKey === 'string') {
    bits.push(`Dates ${inputs.quoteRequestKey.replace(':', ' → ')}`);
  }
  if (Array.isArray(inputs.groupIds) && inputs.groupIds.length) {
    bits.push(`Stay groups ${inputs.groupIds.map(String).join(', ')}`);
  }
  if (Array.isArray(inputs.groups)) {
    for (const raw of inputs.groups) {
      if (!raw || typeof raw !== 'object') continue;
      const group = raw as Record<string, unknown>;
      const id = typeof group.id === 'string' ? group.id : '?';
      const qty = typeof group.quantity === 'number' ? group.quantity : 1;
      const room = typeof group.roomPreference === 'string' && group.roomPreference.trim()
        ? group.roomPreference
        : 'room';
      const adults = typeof group.adults === 'number' ? `${group.adults} adults` : 'occupancy unset';
      bits.push(`${id}: ${qty} × ${room}, ${adults}`);
    }
  }
  return bits.length ? bits.join(' · ') : 'No current inputs';
}

export function canRunQuoteStep(
  step: QuoteToolStep,
  steps: readonly QuoteToolStep[],
  runningStepId: string | null,
): boolean {
  if (runningStepId) return false;
  if (step.status === 'succeeded' || step.status === 'running' || step.status === 'cancelled') return false;
  return step.dependsOn.every((dep) => steps.find((item) => item.id === dep)?.status === 'succeeded');
}

export function pickNextRunnableStep(
  steps: readonly QuoteToolStep[],
  runningStepId: string | null,
): QuoteToolStep | undefined {
  return steps.find((step) => canRunQuoteStep(step, steps, runningStepId));
}

export function nextSelectedOfferIds(session: QuoteSession, offerId: string): string[] {
  const offer = session.offers.find((item) => item.id === offerId);
  if (!offer) return session.selectedOfferIds;
  if (session.selectedOfferIds.includes(offerId)) {
    return session.selectedOfferIds.filter((id) => id !== offerId);
  }
  if (offer.kind === 'alternative') {
    const hasAllocation = session.selectedOfferIds.some(
      (id) => session.offers.find((item) => item.id === id)?.kind === 'allocation',
    );
    if (hasAllocation) return session.selectedOfferIds;
    return [offerId];
  }
  const kept = session.selectedOfferIds.filter((id) => {
    const other = session.offers.find((item) => item.id === id);
    if (!other || other.kind !== 'allocation') return false;
    return !coversGroupOverlap(other, offer);
  });
  return [...kept, offerId];
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
    partyLookup: null,
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

function coversGroupOverlap(left: QuoteOffer, right: QuoteOffer): boolean {
  return left.coversGroupIds.some((id) => right.coversGroupIds.includes(id));
}

function coveringAllocations(selected: readonly QuoteOffer[], groupId: string): QuoteOffer[] {
  return selected.filter((offer) => offer.coversGroupIds.includes(groupId));
}

function agesMatch(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((age, i) => age === b[i]);
}

function occupancySatisfied(group: StayGroupRequirement, covering: readonly QuoteOffer[]): boolean {
  if (covering.length === 0) return false;
  if (!group.arrivalDate || !group.departureDate) return false;
  if (group.board === 'unknown') return false;
  if (typeof group.quantity !== 'number') return false;
  const dateKey = `${group.arrivalDate}:${group.departureDate}`;
  let haveQty = 0;
  for (const offer of covering) {
    if (typeof offer.quantity !== 'number') return false;
    if (offer.quoteRequestKey !== dateKey) return false;
    if (offer.board !== group.board) return false;
    if (!agesMatch(offer.childrenAges ?? [], group.childrenAges)) return false;
    if (group.adults != null && offer.adults !== group.adults) return false;
    haveQty += offer.quantity;
  }
  return haveQty === group.quantity;
}

export function canCreatePdf(session: QuoteSession): boolean {
  if (!evidenceMatchesSession(session) || session.evidence?.kind !== 'authorised') return false;
  const selected = session.selectedOfferIds
    .map((id) => session.offers.find((offer) => offer.id === id))
    .filter((offer): offer is QuoteOffer => Boolean(offer && offer.kind === 'allocation' && offer.sourceRef));
  if (selected.length === 0 || selected.length !== session.selectedOfferIds.length) return false;
  if (session.groups.length === 0) return false;
  return session.groups.every((group) => occupancySatisfied(group, coveringAllocations(selected, group.id)));
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
    partyLookup: null,
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
        steps: planQuoteSteps(groups),
      });
    }
    case 'results_ready': {
      if (!action.provenance) return session;
      if (!provenanceMatches(session, action.provenance, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      const incomingGroups = new Set(action.offers.flatMap((offer) => offer.coversGroupIds));
      const incomingKeys = new Set(action.offers.map((offer) => offer.quoteRequestKey));
      const kept = incomingGroups.size
        ? session.offers.filter((offer) => !offer.coversGroupIds.some((id) => incomingGroups.has(id)))
        : session.offers.filter((offer) => !incomingKeys.has(offer.quoteRequestKey));
      return {
        ...session,
        phase: 'results',
        offers: [...kept, ...action.offers],
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
    case 'lookup_ready': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) {
        return session;
      }
      const partyRef = action.party.partyRef.trim();
      if (!partyRef) return session;
      const party: PartyLookupRef = {
        organisation: action.party.organisation.trim(),
        partyRef,
      };
      const succeededIds = new Set(
        session.steps
          .filter((step) => step.status === 'succeeded' || step.id === action.stepId)
          .map((step) => step.id),
      );
      return {
        ...session,
        phase: 'tools',
        runningStepId: null,
        errorMessage: null,
        partyLookup: party,
        steps: session.steps.map((step) => {
          if (step.id === action.stepId) {
            return {
              ...step,
              status: 'succeeded' as const,
              resultSummary: `Party ${party.partyRef}`,
            };
          }
          if (step.status === 'queued' && step.dependsOn.every((dep) => succeededIds.has(dep))) {
            return { ...step, status: 'ready' as const };
          }
          return step;
        }),
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
      if (sameSelectedOfferIds(action.offerIds, session.selectedOfferIds)) return session;
      return { ...session, selectedOfferIds: action.offerIds, pdf: null };
    case 'mailbox_status':
      return { ...session, mailboxStatus: action.status };
    default:
      return session;
  }
}

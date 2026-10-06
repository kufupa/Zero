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
  StaffQuoteAllocation,
  StayGroupRequirement,
} from './types';
import { emptyStaffQuoteHeader } from './types';
import { documentFailureItems, projectQuoteReviewItems } from './review-items';
import { approvedExecuteHeader } from './staff-quote-bind';

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

export function stayKeyForGroup(group: StayGroupRequirement): string {
  return `${group.arrivalDate ?? 'unknown'}:${group.departureDate ?? 'unknown'}`;
}

export function planQuoteSteps(groups: StayGroupRequirement[], selectedStayKey: string | null = null): QuoteToolStep[] {
  const steps: QuoteToolStep[] = [];
  const byDates = new Map<string, StayGroupRequirement[]>();
  for (const group of groups) {
    const key = stayKeyForGroup(group);
    const list = byDates.get(key) ?? [];
    list.push(group);
    byDates.set(key, list);
  }
  const keys = [...byDates.keys()];
  const selected = selectedStayKey && byDates.has(selectedStayKey)
    ? selectedStayKey
    : keys.length === 1
      ? keys[0]!
      : null;
  for (const [key, grouped] of byDates) {
    const active = selected === key;
    steps.push({
      id: `quote-stay-${key}`,
      kind: 'quote_stay',
      title: `Search availability ${key.replace(':', ' → ')}`,
      inputs: {
        quoteRequestKey: key,
        groupIds: grouped.map((group) => group.id),
        groups: grouped.map(toApprovedStayGroup),
      },
      dependsOn: [],
      status: active ? 'ready' : 'queued',
      shareKey: key,
      retryGuidance: active
        ? undefined
        : 'Select this date scope to quote. Other stays stay unfinished.',
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
  if (step.status !== 'ready' && step.status !== 'failed') return false;
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

export function admissionKey(binding: QuoteSelectionBinding): string {
  return `${selectionDigest(binding)}|${binding.selectionEpoch}|${binding.scopeEpoch}`;
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
    staffSource: null,
    staffQuote: null,
    staffQuotes: {},
    staffHeader: emptyStaffQuoteHeader(),
    staffActions: [],
    selectedStayKey: null,
    handledSourceKey: null,
    reviewItems: [],
    handledReviewItemIds: [],
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

export function staffQuoteForStay(
  session: Pick<QuoteSession, 'staffQuote' | 'staffQuotes' | 'selectedStayKey'>,
  stayKey = session.selectedStayKey,
): StaffQuoteAllocation | null {
  if (!stayKey) return null;
  return session.staffQuotes[stayKey] ?? (session.staffQuote?.quoteRequestKey === stayKey ? session.staffQuote : null);
}

export function staffSourceReady(session: Pick<QuoteSession, 'staffSource'>): boolean {
  const source = session.staffSource;
  return Boolean(
    source &&
      /^[a-f0-9]{64}$/.test(source.sourceHash) &&
      source.messageId.trim() &&
      source.threadId.trim(),
  );
}

export function reviewSourceKey(session: QuoteSession): string {
  return session.staffSource?.sourceHash ?? '';
}

export function staffQuoteMatchesSession(session: QuoteSession): boolean {
  const quote = staffQuoteForStay(session);
  const source = session.staffSource;
  if (!quote || !source || !session.binding) return false;
  if (quote.totalMinor <= 0) return false;
  if (quote.selectionEpoch !== session.binding.selectionEpoch) return false;
  if (quote.inputRevision !== session.inputRevision) return false;
  if (quote.sourceHash !== source.sourceHash) return false;
  if (quote.messageId !== source.messageId) return false;
  if (!session.selectedStayKey || quote.quoteRequestKey !== session.selectedStayKey) return false;
  if (session.selectedOfferIds.length !== 1 || session.selectedOfferIds[0] !== quote.revisionRef) return false;
  const offer = session.offers.find((item) => item.id === quote.revisionRef);
  if (!offer || offer.kind !== 'allocation' || offer.stayTotalMinor !== quote.totalMinor) return false;
  if (offer.nightly.length) return false;
  const selectedKeys = new Set(
    session.selectedOfferIds
      .map((id) => session.offers.find((item) => item.id === id)?.quoteRequestKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (selectedKeys.size !== 1) return false;
  const current = approvedExecuteHeader(session.staffHeader);
  const approved = quote.approvedHeader;
  if (!approved) return false;
  if (current.company !== approved.company || current.agency !== approved.agency) return false;
  if (current.salesStrategy !== approved.salesStrategy) return false;
  return true;
}

export function canCreatePdf(session: QuoteSession): boolean {
  if (!staffSourceReady(session)) return false;
  if (!evidenceMatchesSession(session) || session.evidence?.kind !== 'authorised') return false;
  const selectedKeys = new Set(
    session.selectedOfferIds
      .map((id) => session.offers.find((item) => item.id === id)?.quoteRequestKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (selectedKeys.size > 1) return false;
  if (staffQuoteForStay(session)) {
    if (!staffQuoteMatchesSession(session)) return false;
    const scoped = session.groups.filter((group) => stayKeyForGroup(group) === session.selectedStayKey);
    return scoped.length > 0;
  }
  const selected = session.selectedOfferIds
    .map((id) => session.offers.find((offer) => offer.id === id))
    .filter((offer): offer is QuoteOffer => Boolean(offer && offer.kind === 'allocation' && offer.sourceRef));
  if (selected.length === 0 || selected.length !== session.selectedOfferIds.length) return false;
  const scoped = session.selectedStayKey
    ? session.groups.filter((group) => stayKeyForGroup(group) === session.selectedStayKey)
    : session.groups;
  if (scoped.length === 0) return false;
  return scoped.every((group) => occupancySatisfied(group, coveringAllocations(selected, group.id)));
}

export function canCreateNativeDraft(session: QuoteSession): boolean {
  if (!session.pdf || !session.reviewedReplyHtml.trim() || !canCreatePdf(session)) return false;
  const quote = staffQuoteForStay(session);
  if (!quote) return true;
  return (
    session.pdf.revisionId === quote.revisionRef &&
    session.pdf.totalMinor === quote.totalMinor &&
    typeof session.pdf.pdfHash === 'string' &&
    /^[a-f0-9]{64}$/.test(session.pdf.pdfHash)
  );
}

function clearDownstream(session: QuoteSession): QuoteSession {
  return {
    ...session,
    offers: [],
    selectedOfferIds: [],
    pdf: null,
    runningStepId: null,
    evidence: null,
    errorMessage: null,
    partyLookup: null,
    staffQuote: null,
    staffQuotes: {},
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

function hasStaffStayEdits(session: QuoteSession): boolean {
  return session.groups.some((group) =>
    Object.values(group.fields).some((provenance) => provenance === 'staff_corrected'),
  );
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
    case 'reset':
      return initialQuoteSession();
    case 'selection': {
      const current = session.binding ? admissionKey(session.binding) : null;
      const next = admissionKey(action.binding);
      if (current === next) {
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
      if (hasStaffStayEdits(session)) {
        const extras = session.reviewItems.filter(
          (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
        );
        return {
          ...session,
          reviewItems: projectQuoteReviewItems(
            session.analysis,
            session.groups,
            extras,
            session.staffActions,
          ),
        };
      }
      if (action.analysis.intent !== 'quote') {
        return {
          ...clearDownstream(session),
          phase: 'non_quote',
          analysis: action.analysis,
          groups: [],
          reviewItems: [],
          handledReviewItemIds: [],
        };
      }
      const keys = requestedQuoteKeys(action.analysis.groups);
      const selectedStayKey = keys.length === 1 ? keys[0]! : session.selectedStayKey && keys.includes(session.selectedStayKey) ? session.selectedStayKey : null;
      const reviewItems = projectQuoteReviewItems(
        action.analysis,
        action.analysis.groups,
        [],
        action.analysis.staffActions ?? session.staffActions,
      );
      const sourceKey = reviewSourceKey({ ...session, analysis: action.analysis });
      const handled = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      const requirementsChanged = session.analysis !== null && JSON.stringify(session.groups) !== JSON.stringify(action.analysis.groups);
      return {
        ...(requirementsChanged ? clearDownstream(session) : session),
        phase: 'requirements',
        analysis: action.analysis,
        groups: action.analysis.groups,
        inputRevision: session.inputRevision + (requirementsChanged ? 1 : 0),
        selectedStayKey,
        steps: planQuoteSteps(action.analysis.groups, selectedStayKey),
        staffActions: action.analysis.staffActions ?? session.staffActions,
        reviewItems,
        handledSourceKey: sourceKey || null,
        handledReviewItemIds: handled.filter((id) => reviewItems.some((item) => item.id === id)),
      };
    }
    case 'analysis_unsynced':
      return { ...session, phase: 'unsynced' };
    case 'analysis_missing_source': {
      const documents = documentFailureItems(action.documents ?? []);
      return {
        ...session,
        phase: 'missing_source',
        missing: action.missing,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, documents, session.staffActions),
      };
    }
    case 'analysis_failed': {
      const failed = {
        id: 'analysis-failed',
        kind: 'analysis_failure' as const,
        rank: 'unread_source' as const,
        text: action.message,
        sourceLabel: 'Selected message',
        blocking: false,
      };
      return {
        ...session,
        phase: 'failed',
        errorMessage: action.message,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, [failed], session.staffActions),
      };
    }
    case 'review_documents_failed': {
      const documents = documentFailureItems(action.documents);
      return {
        ...session,
        reviewItems: projectQuoteReviewItems(session.analysis, session.groups, documents, session.staffActions),
      };
    }
    case 'staff_source_ready': {
      if (!/^[a-f0-9]{64}$/.test(action.source.sourceHash) || !action.source.messageId.trim()) {
        return session;
      }
      const keepHandled = session.handledSourceKey === action.source.sourceHash;
      return {
        ...session,
        staffSource: action.source,
        handledSourceKey: action.source.sourceHash,
        handledReviewItemIds: keepHandled ? session.handledReviewItemIds : [],
      };
    }
    case 'staff_actions_ready': {
      const extras = session.reviewItems.filter(
        (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
      );
      const reviewItems = projectQuoteReviewItems(
        session.analysis,
        session.groups,
        extras,
        action.actions,
      );
      const sourceKey = reviewSourceKey({ ...session, staffActions: action.actions });
      const handled = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      return {
        ...session,
        staffActions: action.actions,
        reviewItems,
        handledSourceKey: sourceKey || session.handledSourceKey,
        handledReviewItemIds: handled.filter((id) => reviewItems.some((item) => item.id === id)),
      };
    }
    case 'patch_staff_header': {
      const staffHeader = { ...session.staffHeader, ...action.header };
      if (action.header.agency !== undefined && !action.header.agency.trim()) {
        staffHeader.agency = '';
      }
      return clearDownstream({
        ...session,
        staffHeader,
        inputRevision: session.inputRevision + 1,
      });
    }
    case 'select_stay_key': {
      if (!session.groups.some((group) => stayKeyForGroup(group) === action.stayKey)) return session;
      if (session.selectedStayKey === action.stayKey) return session;
      return {
        ...session,
        selectedStayKey: action.stayKey,
        selectedOfferIds: [],
        offers: [],
        pdf: null,
        staffQuote: null,
        staffQuotes: {},
        evidence: null,
        steps: planQuoteSteps(session.groups, action.stayKey),
        runningStepId: null,
      };
    }
    case 'staff_quote_ready': {
      if (!requestMatchesCurrent(session, action.selectionEpoch, action.inputRevision)) return session;
      const source = session.staffSource;
      if (!source || source.sourceHash !== action.staffQuote.sourceHash) return session;
      if (source.messageId !== action.staffQuote.messageId) return session;
      if (action.offer.kind !== 'allocation') return session;
      if (action.offer.id !== action.staffQuote.revisionRef) return session;
      if (action.offer.stayTotalMinor !== action.staffQuote.totalMinor) return session;
      if (action.staffQuote.totalMinor <= 0) return session;
      if (action.offer.nightly.length) return session;
      const stayKey = action.offer.quoteRequestKey;
      const staffQuote = { ...action.staffQuote, quoteRequestKey: stayKey };
      const stayCount = requestedQuoteKeys(session.groups).length;
      return {
        ...session,
        phase: stayCount > 1 ? 'tools' : 'results',
        offers: [action.offer],
        selectedOfferIds: [action.offer.id],
        selectedStayKey: stayKey,
        staffQuote,
        staffQuotes: { [stayKey]: staffQuote },
        pdf: null,
        evidence: {
          kind: 'authorised',
          selectionEpoch: action.selectionEpoch,
          inputRevision: action.inputRevision,
        },
        errorMessage: null,
        runningStepId: null,
        reviewedReplyHtml: action.reviewedReplyHtml ?? session.reviewedReplyHtml,
        steps: planQuoteSteps(session.groups, stayKey).map((step) =>
          step.shareKey === stayKey ? { ...step, status: 'succeeded' as const } : step,
        ),
      };
    }
    case 'handle_review_item': {
      const item = session.reviewItems.find((row) => row.id === action.itemId);
      if (!item || item.blocking || item.kind === 'pricing_fact') return session;
      const sourceKey = reviewSourceKey(session);
      const existing = session.handledSourceKey === sourceKey ? session.handledReviewItemIds : [];
      if (existing.includes(action.itemId)) return session;
      return {
        ...session,
        handledSourceKey: sourceKey || null,
        handledReviewItemIds: [...existing, action.itemId],
      };
    }
    case 'unhandle_review_item':
      return {
        ...session,
        handledReviewItemIds: session.handledReviewItemIds.filter((id) => id !== action.itemId),
      };
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
        steps: planQuoteSteps(groups, session.selectedStayKey),
        selectedStayKey: session.selectedStayKey && groups.some((group) => stayKeyForGroup(group) === session.selectedStayKey)
          ? session.selectedStayKey
          : requestedQuoteKeys(groups).length === 1
            ? requestedQuoteKeys(groups)[0]!
            : session.selectedStayKey,
        reviewItems: projectQuoteReviewItems(
          session.analysis,
          groups,
          session.reviewItems.filter(
            (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
          ),
          session.staffActions,
        ),
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
    case 'results_unavailable': {
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
        staffQuote: null,
        staffQuotes: {},
        evidence: null,
        errorMessage: action.reason,
        steps: session.steps.map((step) =>
          step.id === action.stepId
            ? { ...step, status: 'failed' as const, retryGuidance: action.reason }
            : step,
        ),
      };
    }
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

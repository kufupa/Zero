import type {
  QuoteAnalysis,
  QuoteDocumentFailure,
  QuoteReviewItem,
  ReservationistStaffAction,
  StayGroupRequirement,
} from './types';

const PRICING_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'arrivalDate', label: 'Arrival date' },
  { key: 'departureDate', label: 'Departure date' },
  { key: 'adults', label: 'Number of adults' },
];

function isActualQuestionClause(text: string): boolean {
  const clause = text.trim();
  if (clause.length < 8) return false;
  if (/^(parking|shuttle|transfer|children|adults)$/i.test(clause)) return false;
  return /[?]/.test(clause) || /^(is |are |can |could |please |how |what |do |does )/i.test(clause);
}

export function notNoise(item: QuoteReviewItem): boolean {
  return item.kind !== 'signature_noise' && item.positivelyIdentifiedNoise !== true;
}

export function pricingReviewItems(groups: StayGroupRequirement[]): QuoteReviewItem[] {
  const items: QuoteReviewItem[] = [];
  for (const group of groups) {
    const stayNo = groups.indexOf(group) + 1;
    for (const field of PRICING_FIELDS) {
      if (group.fields[field.key] === 'missing') {
        items.push({
          id: `pricing:${group.id}:${field.key}`,
          kind: 'pricing_fact',
          rank: 'pricing',
          text: `${field.label} is missing for Stay ${stayNo}.`,
          sourceLabel: `Stay ${stayNo}`,
          blocking: true,
        });
      }
    }
    if (group.board === 'unknown') {
      items.push({
        id: `pricing:${group.id}:board`,
        kind: 'pricing_fact',
        rank: 'pricing',
        text: `Meal plan is not stated for Stay ${stayNo}.`,
        sourceLabel: `Stay ${stayNo}`,
        blocking: true,
      });
    }
  }
  return items;
}

export function documentFailureIdentity(document: Pick<QuoteDocumentFailure, 'sourceKind' | 'sourceRef' | 'filename'>): string {
  return `document:${document.sourceKind}:${document.sourceRef?.trim() || ''}:${document.filename}`;
}

export function reviewItemSourceIdentity(item: QuoteReviewItem): string {
  if (item.sourceHash && item.sourceRef) return `${item.kind}:${item.sourceHash}:${item.sourceRef}`;
  if (item.sourceRef) return `${item.kind}:${item.sourceRef}:${item.filename ?? item.text}`;
  if (item.kind === 'document_failure' && item.filename) {
    return `document:${item.sourceKind ?? 'attachment'}:${item.sourceRef?.trim() || ''}:${item.filename}`;
  }
  return item.id;
}

export function documentFailureItems(documents: QuoteDocumentFailure[]): QuoteReviewItem[] {
  return documents.map((document) => ({
    id: documentFailureIdentity(document),
    kind: 'document_failure',
    rank: 'unread_source',
    text: `Could not read: ${document.filename}`,
    sourceLabel: document.sourceKind === 'email' ? 'Email text' : 'Attachment',
    filename: document.filename,
    reason: document.reason,
    sourceRef: document.sourceRef,
    sourceKind: document.sourceKind,
    blocking: false,
  }));
}

export function questionReviewItems(analysis: QuoteAnalysis | null): QuoteReviewItem[] {
  if (!analysis) return [];
  return analysis.secondaryAsks.filter(isActualQuestionClause).map((text) => ({
    id: `question:${text.trim().toLowerCase()}`,
    kind: 'question',
    rank: 'secondary',
    text: text.trim(),
    sourceLabel: 'This email',
    blocking: false,
  }));
}

const SOURCE_HASH = /^[a-f0-9]{64}$/;

export function mapStaffActions(actions: readonly ReservationistStaffAction[] | undefined): QuoteReviewItem[] {
  if (!actions) return [];
  const items: QuoteReviewItem[] = [];
  for (const action of actions) {
    if (action.status !== 'open') continue;
    const metadataOnly = action.sourceIdentity === 'metadata_only' && action.sourceHash === undefined &&
      action.kind === 'business_document_failure' && action.sourceKind === 'attachment' && !!action.messageId;
    if (!metadataOnly && (!action.sourceHash || !SOURCE_HASH.test(action.sourceHash))) continue;
    if (typeof action.text !== 'string' || !action.text.trim()) continue;
    if (typeof action.sourceRef !== 'string' || !action.sourceRef.trim()) continue;
    const sourceLabel =
      action.sourceKind === 'attachment'
        ? action.filename ?? 'Attachment'
        : action.sourceKind === 'message'
          ? 'This email'
          : action.filename ?? 'This email';
    const kind =
      action.kind === 'pricing_fact'
        ? 'pricing_fact'
        : action.kind === 'business_document_failure'
          ? 'document_failure'
          : 'question';
    const rank = kind === 'pricing_fact' ? 'pricing' : kind === 'document_failure' ? 'unread_source' : 'secondary';
    items.push({
      id: action.id,
      kind,
      rank,
      text:
        action.kind === 'business_document_failure' && action.filename
          ? `Could not read: ${action.filename}`
          : action.text.trim(),
      sourceLabel,
      sourceRef: action.sourceRef,
      sourceHash: action.sourceHash,
      sourceKind: action.sourceKind,
      messageId: action.messageId,
      filename: action.filename,
      reason: action.reason,
      blocking: action.blockingQuote,
    });
  }
  return items;
}

export function sortReviewItems(items: QuoteReviewItem[]): QuoteReviewItem[] {
  const rank = { pricing: 0, unread_source: 1, secondary: 2 };
  return [...items].sort((left, right) => rank[left.rank] - rank[right.rank] || left.id.localeCompare(right.id));
}

function mergeReviewItems(lists: readonly (readonly QuoteReviewItem[])[]): QuoteReviewItem[] {
  const seen = new Set<string>();
  const out: QuoteReviewItem[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (!notNoise(item)) continue;
      const identity = reviewItemSourceIdentity(item);
      if (seen.has(item.id) || seen.has(identity)) continue;
      seen.add(item.id);
      seen.add(identity);
      out.push(item);
    }
  }
  return sortReviewItems(out);
}

export function projectQuoteReviewItems(
  analysis: QuoteAnalysis | null,
  groups: StayGroupRequirement[],
  extra: QuoteReviewItem[] = [],
  staffActions: readonly ReservationistStaffAction[] | undefined = analysis?.staffActions,
): QuoteReviewItem[] {
  const pricing = pricingReviewItems(groups);
  const fromStaff = mapStaffActions(staffActions);
  const kept = extra.filter(
    (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
  );
  const explicit = (analysis?.reviewItems ?? [])
    .filter(notNoise)
    .filter((item) => item.kind !== 'pricing_fact');
  const questions = fromStaff.length || explicit.length ? [] : questionReviewItems(analysis);
  return mergeReviewItems([pricing, fromStaff, explicit, kept, questions]);
}

export function openReviewItems(session: {
  reviewItems?: QuoteReviewItem[];
  handledReviewItemIds?: string[];
}): QuoteReviewItem[] {
  const handled = new Set(session.handledReviewItemIds ?? []);
  return (session.reviewItems ?? []).filter((item) => {
    if (!notNoise(item)) return false;
    if (item.kind === 'pricing_fact' || item.blocking) return true;
    return !handled.has(item.id);
  });
}

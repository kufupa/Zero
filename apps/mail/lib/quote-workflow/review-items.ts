import type {
  QuoteAnalysis,
  QuoteDocumentFailure,
  QuoteReviewItem,
  StayGroupRequirement,
} from './types';

const PRICING_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'arrivalDate', label: 'Arrival date' },
  { key: 'departureDate', label: 'Departure date' },
  { key: 'adults', label: 'Adult occupancy' },
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
    for (const field of PRICING_FIELDS) {
      if (group.fields[field.key] === 'missing') {
        items.push({
          id: `pricing:${group.id}:${field.key}`,
          kind: 'pricing_fact',
          rank: 'pricing',
          text: `${field.label} is missing for stay group ${group.id}.`,
          sourceLabel: `Stay group ${group.id}`,
          blocking: true,
        });
      }
    }
    if (group.board === 'unknown') {
      items.push({
        id: `pricing:${group.id}:board`,
        kind: 'pricing_fact',
        rank: 'pricing',
        text: `Board is unknown for stay group ${group.id}.`,
        sourceLabel: `Stay group ${group.id}`,
        blocking: true,
      });
    }
  }
  return items;
}

export function documentFailureItems(documents: QuoteDocumentFailure[]): QuoteReviewItem[] {
  return documents.map((document) => ({
    id: `document:${document.filename}`,
    kind: 'document_failure',
    rank: 'unread_source',
    text: document.filename,
    sourceLabel: document.sourceKind === 'email' ? 'Email source' : 'Attachment',
    filename: document.filename,
    reason: document.reason,
    sourceRef: document.sourceRef,
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
    sourceLabel: 'Selected message',
    blocking: false,
  }));
}

export function sortReviewItems(items: QuoteReviewItem[]): QuoteReviewItem[] {
  const rank = { pricing: 0, unread_source: 1, secondary: 2 };
  return [...items].sort((left, right) => rank[left.rank] - rank[right.rank] || left.id.localeCompare(right.id));
}

export function projectQuoteReviewItems(
  analysis: QuoteAnalysis | null,
  groups: StayGroupRequirement[],
  extra: QuoteReviewItem[] = [],
): QuoteReviewItem[] {
  const pricing = pricingReviewItems(groups);
  const explicit = (analysis?.reviewItems ?? []).filter(notNoise);
  if (explicit.length) {
    return sortReviewItems([
      ...pricing,
      ...explicit.filter((item) => item.kind !== 'pricing_fact'),
    ]);
  }
  const kept = extra.filter(
    (item) => item.kind === 'document_failure' || item.kind === 'analysis_failure',
  );
  return sortReviewItems([...pricing, ...kept, ...questionReviewItems(analysis)]);
}

export function openReviewItems(session: {
  reviewItems?: QuoteReviewItem[];
  handledReviewItemIds?: string[];
}): QuoteReviewItem[] {
  const handled = new Set(session.handledReviewItemIds ?? []);
  return (session.reviewItems ?? []).filter((item) => notNoise(item) && !handled.has(item.id));
}

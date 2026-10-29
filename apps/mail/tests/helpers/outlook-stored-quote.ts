import type { ReadyAnalyse, StoredWork } from '../../lib/quote-workflow/backend-bind';

/** Synthetic saved source for Outlook bridge tests; every empty child list explicitly means zero children. */
export function outlookStoredQuote(analysis: ReadyAnalyse): Extract<StoredWork, { status: 'ready' }> {
  const groups = analysis.groups.map((group, index) => ({
    ...group,
    stayId: group.stayId ?? `stay-${index + 1}`,
    sourcePreference: group.sourcePreference ?? {
      roomType: group.roomPreference ?? null,
      board: group.board === 'dinner_bb' ? 'dbb' as const : group.board === 'unknown' ? null : group.board,
    },
  }));
  return {
    status: 'ready', kind: 'quote', workItemId: 'wi-outlook', workItemStatus: 'needs_you', extractionId: 'ex-outlook',
    refs: Object.fromEntries(groups.map((group) => [group.id, { stayId: group.stayId, rowId: group.id }])),
    analysis: { ...analysis, groups },
    contact: { name: null, email: null, phone: null, company: null, endClient: null },
    sourcePartyDigest: 'a'.repeat(64), sourcePartyFields: { company: ['missing'], endClient: ['missing'] },
    language: null, translation: null,
  };
}

export const OUTLOOK_QUOTE_ANALYSIS: ReadyAnalyse = {
  intent: 'quote',
  groups: [{
    id: 'g1', childrenPerRoom: 0, childrenAges: [], board: 'bb', quantity: 1, specialRequests: [],
    fields: { arrivalDate: 'missing', departureDate: 'missing', adults: 'missing' },
  }],
  secondaryAsks: [], alternatives: [],
};

export const outlookRecordEvent = async (input: { value?: unknown }) => ({ aiValue: null, value: input.value ?? null });

export const OUTLOOK_CENTURION_ROOM_TYPES = [
  { code: 'SKNG', label: 'Standard King' },
  { code: 'STQN', label: 'Standard Queen' },
];
export const OUTLOOK_DA_VINCI_ROOM_TYPES = [
  { code: 'STKNG', label: 'Standard King' },
];

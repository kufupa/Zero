import { describe, expect, it } from 'vitest';
import {
  DRAFT_GROUP_ID, caseReviewPending, initialQuoteSession, missingQuoteDetailsReplyOnly,
  quoteDeclineReplyOnly, reduceQuoteSession, withPaneRead,
} from '@/lib/quote-workflow/session';
import type { QuoteAnalysis, StayGroupRequirement } from '@/lib/quote-workflow/types';

const row = (id: string, stayId: string): StayGroupRequirement => ({
  id, stayId, quantity: 1, adults: 2, childrenPerRoom: 0, childrenAges: [], board: 'bb', specialRequests: [], fields: {},
});
const first = row('r_1', 's_1');
const second = row('r_2', 's_2');
const source = (groups: StayGroupRequirement[]): QuoteAnalysis => ({
  intent: 'quote', groups, secondaryAsks: [], alternatives: [], missingQuoteReplyFields: ['Arrival date'],
});
function typedPlaceholder() {
  const loading = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_started' });
  return reduceQuoteSession(loading, { type: 'patch_group', groupId: DRAFT_GROUP_ID, patch: { adults: 3 } });
}

describe('edits made before the case is known', () => {
  it('holds one unassigned edit instead of applying it to every case or drafting a misleading reply', () => {
    const pending = typedPlaceholder();
    const read = withPaneRead(source([first, second]), [first, second], null, 'HRCEN', true);
    const landed = reduceQuoteSession(pending, { type: 'analysis_ready', analysis: read });
    expect(landed.groups).toHaveLength(1);
    expect(landed.groups[0]).toMatchObject({ id: DRAFT_GROUP_ID, adults: 3 });
    expect(caseReviewPending(landed.analysis)).toBe(true);
    expect(missingQuoteDetailsReplyOnly(landed)).toBe(false);
    expect(quoteDeclineReplyOnly({ ...landed, reviewedReplySource: 'quote_decline', reviewedReplyHtml: 'Declined.' })).toBe(false);
    const reread = reduceQuoteSession(landed, { type: 'analysis_ready', analysis: read });
    expect(reread.groups).toMatchObject([{ id: DRAFT_GROUP_ID, adults: 3 }]);
    expect(caseReviewPending(reread.analysis)).toBe(true);
  });

  it('preserves a Centurion single-case placeholder until the edit can be safely re-entered', () => {
    const pending = typedPlaceholder();
    const read = withPaneRead(source([first]), [first], null, 'HRCEN', true);
    const landed = reduceQuoteSession(pending, { type: 'analysis_ready', analysis: read });
    expect(landed.groups).toMatchObject([{ id: DRAFT_GROUP_ID, adults: 3 }]);
    expect(caseReviewPending(landed.analysis)).toBe(true);
  });

  it('keeps a remembered loading edit held after a pane remount', () => {
    const remembered = typedPlaceholder().groups;
    const read = { ...withPaneRead(source([first, second]), [first, second], null, 'HRCEN', true),
      rememberedPlaceholder: remembered } as QuoteAnalysis;
    const landed = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_ready', analysis: read });
    expect(landed.groups).toMatchObject([{ id: DRAFT_GROUP_ID, adults: 3 }]);
    expect(caseReviewPending(landed.analysis)).toBe(true);
  });

  it('still assigns a single-room Da Vinci loading edit', () => {
    const pending = typedPlaceholder();
    const read = withPaneRead(source([first]), null, null, 'HRDAV');
    const landed = reduceQuoteSession(pending, { type: 'analysis_ready', analysis: read });
    expect(landed.groups).toMatchObject([{ id: 'r_1', adults: 3 }]);
    expect(caseReviewPending(landed.analysis)).toBe(false);
  });

  it('does not clear a malformed-source hold when a later read arrives', () => {
    const pending = typedPlaceholder();
    const failed = reduceQuoteSession(pending, { type: 'analysis_failed', message: 'Review manually.', hold: true });
    const read = withPaneRead(source([first, second]), [first, second], null, 'HRCEN', true);
    const landed = reduceQuoteSession(failed, { type: 'analysis_ready', analysis: read });
    expect(landed.groups).toEqual(failed.groups);
    expect(caseReviewPending(landed.analysis)).toBe(true);
  });
});

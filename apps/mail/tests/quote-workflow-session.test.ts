import { describe, expect, it } from 'vitest';
import {
  allocationTotal,
  canCreateNativeDraft,
  canCreatePdf,
  canRunQuoteStep,
  formatQuoteStepInputs,
  initialQuoteSession,
  nextSelectedOfferIds,
  parseChildrenAges,
  pickNextRunnableStep,
  planQuoteSteps,
  quoteRunBlockReason,
  reduceQuoteSession,
  selectionDigest,
  buildQuoteStepInputs,
  staffSourceReady,
  analysisRetryKey,
  hasStaffStayEdits,
} from '../lib/quote-workflow/session';
import { documentFailureItems, openReviewItems, projectQuoteReviewItems } from '../lib/quote-workflow/review-items';
import type {
  LunaAnalysisWire,
  QuoteAnalysis,
  QuoteOffer,
  QuotePdf,
  QuoteReviewItem,
  QuoteSelectionBinding,
  QuoteSessionAction,
  QuoteToolStep,
} from '../lib/quote-workflow/types';

const bind = (over: Partial<QuoteSelectionBinding> = {}): QuoteSelectionBinding => ({
  transportId: 't1',
  mailboxEmail: 'centurion@legacyhotels.co.za',
  storeId: 'store',
  folderEntryId: 'inbox',
  entryId: 'e1',
  internetMessageId: '<a@x>',
  selectionEpoch: 1,
  scopeEpoch: 1,
  ...over,
});

const STAFF_HASH = 'ab'.repeat(32);
const staffSource = (over: { messageId?: string; threadId?: string; sourceHash?: string } = {}) => ({
  messageId: 'mail-1',
  threadId: 'thread-1',
  sourceHash: STAFF_HASH,
  ...over,
});

function withStaffSource(session: ReturnType<typeof initialQuoteSession>) {
  return reduceQuoteSession(session, { type: 'staff_source_ready', source: staffSource() });
}

const quoteAnalysis: QuoteAnalysis = {
  intent: 'quote' as const,
  groups: [
    {
      id: 'g1',
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
      quantity: 1,
      roomPreference: 'standard king',
      adults: 1,
      childrenAges: [] as number[],
      board: 'bb' as const,
      specialRequests: [] as string[],
      fields: { arrivalDate: 'extracted' as const, adults: 'extracted' as const },
    },
  ],
  secondaryAsks: ['Is parking included?'],
  alternatives: ['RO'],
};

describe('quote session', () => {
  it('clears authorised artifacts when the same message is rebound to a new staff scope', () => {
    const session = { ...initialQuoteSession(), binding: bind(), pdf: { fileName: 'old.pdf', bytesBase64: 'JVBERi0=' }, reviewedReplyHtml: '<p>Old staff reply</p>' };
    const changed = reduceQuoteSession(session, { type: 'selection', binding: bind({ scopeEpoch: 2 }) });
    expect(changed.pdf).toBeNull();
    expect(changed.reviewedReplyHtml).toBe('');
    expect(changed.staffQuote).toBeNull();
    expect(reduceQuoteSession(session, { type: 'reset' })).toEqual(initialQuoteSession());
  });
  it('invalidates quote evidence and advances revision when late analysis changes requirements', () => {
    const ready = reduceQuoteSession({ ...initialQuoteSession(), binding: bind() }, { type: 'analysis_ready', analysis: quoteAnalysis });
    const quoted = { ...ready, pdf: { fileName: 'old.pdf', bytesBase64: 'JVBERi0=' }, selectedOfferIds: ['old'], offers: [authorisedOffer] };
    const changed = reduceQuoteSession(quoted, { type: 'analysis_ready', analysis: { ...quoteAnalysis, groups: [{ ...quoteAnalysis.groups[0]!, adults: 2 }] } });
    expect(changed.groups[0]?.adults).toBe(2);
    expect(changed.inputRevision).toBe(quoted.inputRevision + 1);
    expect(changed.pdf).toBeNull();
    expect(changed.offers).toEqual([]);
    expect(changed.selectedOfferIds).toEqual([]);
    expect(canCreateNativeDraft(changed)).toBe(false);
  });
  it('reuses analysis for an unchanged selection digest', () => {
    const a = reduceQuoteSession(initialQuoteSession(), {
      type: 'selection',
      binding: bind(),
    });
    const analysing = reduceQuoteSession(a, { type: 'analysis_started' });
    const ready = reduceQuoteSession(analysing, {
      type: 'analysis_ready',
      analysis: quoteAnalysis,
    });
    const same = reduceQuoteSession(ready, { type: 'selection', binding: bind() });
    expect(same.phase).toBe('requirements');
    expect(same.analysis).toBe(ready.analysis);
    expect(selectionDigest(bind())).toBe(selectionDigest(bind({ selectionEpoch: 1 })));
  });

  it('re-analyses when the selection identity changes', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, { type: 'selection', binding: bind({ entryId: 'e2', selectionEpoch: 2 }) });
    expect(s.phase).toBe('idle');
    expect(s.analysis).toBeNull();
  });

  it('does not open a quoting workflow for non-quote intent', () => {
    const s = reduceQuoteSession(
      reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() }),
      {
        type: 'analysis_ready',
        analysis: {
          intent: 'other',
          groups: [],
          secondaryAsks: [],
          alternatives: [],
          reviewItems: [
            {
              id: 'unread:scan',
              kind: 'document_failure',
              rank: 'unread_source',
              text: 'Attachment scan.pdf could not be read (no extractable text). Review it manually.',
              sourceLabel: 'scan.pdf',
              blocking: true,
            },
          ],
        },
      },
    );
    expect(s.phase).toBe('non_quote');
    expect(s.reviewItems).toHaveLength(1);
    expect(s.reviewItems[0]?.kind).toBe('document_failure');
  });

  it('records unsynced, missing-source, failed, and unsupported states', () => {
    const start = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    expect(reduceQuoteSession(start, { type: 'analysis_unsynced' }).phase).toBe('unsynced');
    expect(reduceQuoteSession(start, { type: 'analysis_missing_source', missing: ['att-1'] }).phase).toBe(
      'missing_source',
    );
    expect(reduceQuoteSession(start, { type: 'analysis_failed', message: 'boom' }).phase).toBe('failed');
    expect(reduceQuoteSession(start, { type: 'analysis_unsupported', message: 'conference' }).phase).toBe(
      'unsupported',
    );
  });

  it('staff edits mint inputRevision and invalidate results/pdf', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [
        {
          id: 'o1',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
          stayTotalMinor: 272000,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'src-1',
          restrictions: [],
          combinable: true,
          quoteRequestKey: '2026-11-12:2026-11-14',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: { fileName: 'Quote.pdf', bytesBase64: 'JVBERw==' },
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: [],
    });
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(s.inputRevision).toBe(2);
    expect(s.offers).toEqual([]);
    expect(s.pdf).toBeNull();
    expect(s.phase).toBe('requirements');
    expect(s.groups.find((g) => g.id === 'g1')?.fields.adults).toBe('staff_corrected');
  });

  it('refuses PDF before a selected allocation with evidence', () => {
    const s = initialQuoteSession();
    expect(canCreatePdf(s)).toBe(false);
    expect(canCreateNativeDraft(s)).toBe(false);
  });

  it('does not sum alternatives as if they were booked', () => {
    const offers: QuoteOffer[] = [
      {
        id: 'alloc',
        kind: 'allocation',
        roomCode: 'SKNG',
        roomLabel: 'Standard King',
        board: 'bb',
        rateCode: 'BAR',
        currency: 'ZAR',
        nightly: [{ date: '2026-11-12', amountMinor: 214000 }],
        stayTotalMinor: 214000,
        observedAt: '2026-10-05T12:00:00Z',
        sourceRef: 'src-a',
        restrictions: [],
        combinable: true,
        quoteRequestKey: 'k1',
        coversGroupIds: ['g1'],
        quantity: 1,
        adults: 1,
      },
      {
        id: 'alt',
        kind: 'alternative',
        roomCode: 'SKNG',
        roomLabel: 'Standard King',
        board: 'room_only',
        rateCode: 'BARRO',
        currency: 'ZAR',
        nightly: [{ date: '2026-11-12', amountMinor: 190000 }],
        stayTotalMinor: 190000,
        observedAt: '2026-10-05T12:00:00Z',
        sourceRef: 'src-b',
        restrictions: [],
        combinable: false,
        quoteRequestKey: 'k1',
        coversGroupIds: ['g1'],
        quantity: 1,
        adults: 1,
      },
    ];
    expect(allocationTotal(offers)).toBe(214000);
  });

  it('discards in-flight results when selection epoch changes during a slow run', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, { type: 'step_running', stepId: 'quote-1' });
    const stale = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    const changed = reduceQuoteSession(s, { type: 'selection', binding: bind({ entryId: 'e2', selectionEpoch: 2 }) });
    const ignored = reduceQuoteSession(changed, {
      type: 'results_ready',
      offers: [
        {
          id: 'stale',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [],
          stayTotalMinor: 1,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'stale',
          restrictions: [],
          combinable: true,
          quoteRequestKey: 'k',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(stale.phase).toBe('results');
    expect(ignored.offers).toEqual([]);
    expect(ignored.phase).toBe('idle');
  });

  it('plans one quote request for same-date groups and distinct requests for staggered dates', () => {
    const same = planQuoteSteps([
      { ...quoteAnalysis.groups[0]!, id: 'a', arrivalDate: '2026-10-16', departureDate: '2026-10-18' },
      { ...quoteAnalysis.groups[0]!, id: 'b', arrivalDate: '2026-10-16', departureDate: '2026-10-18', adults: 1 },
    ]);
    expect(same.filter((step) => step.kind === 'quote_stay')).toHaveLength(1);
    const org = planQuoteSteps([
      { ...quoteAnalysis.groups[0]!, organisation: 'Provincial Treasury' },
    ]);
    expect(org.some((step) => step.kind === 'party_lookup')).toBe(false);
    expect(org.find((step) => step.kind === 'quote_stay')?.status).toBe('ready');
    const staggered = planQuoteSteps([
      { ...quoteAnalysis.groups[0]!, id: 'a', arrivalDate: '2026-11-02', departureDate: '2026-11-04' },
      { ...quoteAnalysis.groups[0]!, id: 'b', arrivalDate: '2026-11-10', departureDate: '2026-11-12' },
    ]);
    expect(staggered.filter((step) => step.kind === 'quote_stay')).toHaveLength(2);
  });

  it('ignores results whose inputRevision or selection no longer match', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    const ignored = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [
        {
          id: 'stale-money',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [{ date: '2026-11-12', amountMinor: 99999 }],
          stayTotalMinor: 99999,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'stale',
          restrictions: [],
          combinable: true,
          quoteRequestKey: 'k',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(ignored.offers).toEqual([]);
    expect(ignored.evidence).toBeNull();
  });

  it('records authorised evidence on results and clears it after staff edits', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [
        {
          id: 'o1',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
          stayTotalMinor: 272000,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'src-1',
          restrictions: [],
          combinable: true,
          quoteRequestKey: '2026-11-12:2026-11-14',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(s.evidence).toEqual({ kind: 'authorised', selectionEpoch: 1, inputRevision: 1 });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    s = withStaffSource(s);
    expect(canCreatePdf(s)).toBe(true);
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(s.evidence).toBeNull();
    expect(canCreatePdf(s)).toBe(false);
  });

  it('does not treat fixture evidence as PDF-eligible', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [
        {
          id: 'fix-1',
          kind: 'allocation',
          roomCode: 'SKNG',
          roomLabel: 'Standard King',
          board: 'bb',
          rateCode: 'BAR',
          currency: 'ZAR',
          nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
          stayTotalMinor: 272000,
          observedAt: '2026-10-05T12:00:00Z',
          sourceRef: 'src-1',
          restrictions: [],
          combinable: true,
          quoteRequestKey: '2026-11-12:2026-11-14',
          coversGroupIds: ['g1'],
          quantity: 1,
          adults: 1,
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'fixture', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['fix-1'] });
    expect(canCreatePdf(s)).toBe(false);
    expect(canCreateNativeDraft(s)).toBe(false);
  });

  it('rejects a late PDF after group edit, selection switch, or offer change', () => {
    const offer: QuoteOffer = {
      id: 'o1',
      kind: 'allocation',
      roomCode: 'SKNG',
      roomLabel: 'Standard King',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
      stayTotalMinor: 272000,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'src-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 1,
      adults: 1,
    };
    const pdf = { fileName: 'Quote-authorised.pdf', bytesBase64: 'JVBERi0xLjQK' };
    let ready = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    ready = reduceQuoteSession(ready, { type: 'analysis_ready', analysis: quoteAnalysis });
    ready = reduceQuoteSession(ready, {
      type: 'results_ready',
      offers: [offer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
      reviewedReplyHtml: '<p>Authorised reply</p>',
    });
    ready = reduceQuoteSession(ready, { type: 'select_offers', offerIds: ['o1'] });
    ready = withStaffSource(ready);

    const afterEdit = reduceQuoteSession(ready, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    const lateAfterEdit = reduceQuoteSession(afterEdit, {
      type: 'pdf_ready',
      pdf,
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(lateAfterEdit.pdf).toBeNull();
    expect(canCreateNativeDraft(lateAfterEdit)).toBe(false);

    const switched = reduceQuoteSession(ready, {
      type: 'selection',
      binding: bind({ entryId: 'e2', selectionEpoch: 2 }),
    });
    const lateAfterSwitch = reduceQuoteSession(switched, {
      type: 'pdf_ready',
      pdf,
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(lateAfterSwitch.pdf).toBeNull();
    expect(canCreateNativeDraft(lateAfterSwitch)).toBe(false);

    const offerChanged = reduceQuoteSession(ready, { type: 'select_offers', offerIds: [] });
    const lateAfterOfferChange = reduceQuoteSession(offerChanged, {
      type: 'pdf_ready',
      pdf,
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(lateAfterOfferChange.pdf).toBeNull();
    expect(canCreateNativeDraft(lateAfterOfferChange)).toBe(false);

    const admitted = reduceQuoteSession(ready, {
      type: 'pdf_ready',
      pdf,
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(admitted.pdf).toEqual(pdf);
    expect(canCreateNativeDraft(admitted)).toBe(true);
  });

  it('ignores a late results_unavailable for a superseded selection or input revision', () => {
    const stepId = 'quote-stay-2026-11-12:2026-11-14';
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, { type: 'step_running', stepId });
    const current = reduceQuoteSession(s, {
      type: 'results_unavailable',
      stepId,
      reason: 'live bind unavailable',
      selectionEpoch: 1,
      inputRevision: 1,
    });
    expect(current.errorMessage).toBe('live bind unavailable');
    expect(current.phase).toBe('tools');

    const switched = reduceQuoteSession(s, {
      type: 'selection',
      binding: bind({ entryId: 'e2', selectionEpoch: 2 }),
    });
    const late = reduceQuoteSession(switched, {
      type: 'results_unavailable',
      stepId,
      reason: 'stale unavailable',
      selectionEpoch: 1,
      inputRevision: 1,
    });
    expect(late.errorMessage).toBeNull();
    expect(late.phase).toBe('idle');

    const patched = reduceQuoteSession(
      s,
      { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } },
    );
    const lateAfterPatch = reduceQuoteSession(patched, {
      type: 'results_unavailable',
      stepId,
      reason: 'stale unavailable',
      selectionEpoch: 1,
      inputRevision: 1,
    });
    expect(lateAfterPatch.errorMessage).toBeNull();
    expect(lateAfterPatch.inputRevision).toBe(2);
  });

  it('records mailbox analyseSelection status without wiping local groups', () => {
    let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    session = reduceQuoteSession(session, { type: 'analysis_ready', analysis: quoteAnalysis });
    session = reduceQuoteSession(session, { type: 'mailbox_status', status: 'unsynced' });
    expect(session.mailboxStatus).toBe('unsynced');
    expect(session.groups).toHaveLength(1);
    expect(session.phase).toBe('requirements');
  });

  it('replans tool steps from edited dates and party', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    expect(s.steps.map((step) => step.id)).toEqual(['quote-stay-2026-11-12:2026-11-14']);
    s = reduceQuoteSession(s, {
      type: 'patch_group',
      groupId: 'g1',
      patch: { arrivalDate: '2026-12-01', departureDate: '2026-12-03', organisation: 'Provincial Treasury' },
    });
    expect(s.steps.map((step) => step.id)).toEqual(['quote-stay-2026-12-01:2026-12-03']);
    expect(s.steps[0]?.status).toBe('ready');
    expect(s.steps[0]?.dependsOn).toEqual([]);
    expect(canRunQuoteStep(s.steps[0]!, s.steps, null)).toBe(true);
    expect(pickNextRunnableStep(s.steps, null)?.id).toBe('quote-stay-2026-12-01:2026-12-03');
  });

  it('lets staff keep allocations across date groups and blocks a partial PDF', () => {
    const twoGroups = {
      ...quoteAnalysis,
      groups: [
        { ...quoteAnalysis.groups[0]!, id: 'stay-a', arrivalDate: '2026-11-02', departureDate: '2026-11-04' },
        { ...quoteAnalysis.groups[0]!, id: 'stay-b', arrivalDate: '2026-11-10', departureDate: '2026-11-12' },
      ],
    };
    const offerA: QuoteOffer = {
      id: 'st-a',
      kind: 'allocation',
      roomCode: 'SKNG',
      roomLabel: 'Standard King',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [{ date: '2026-11-02', amountMinor: 136000 }],
      stayTotalMinor: 272000,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'src-a',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-02:2026-11-04',
      coversGroupIds: ['stay-a'],
      quantity: 1,
      adults: 1,
    };
    const offerB: QuoteOffer = {
      ...offerA,
      id: 'st-b',
      sourceRef: 'src-b',
      quoteRequestKey: '2026-11-10:2026-11-12',
      coversGroupIds: ['stay-b'],
    };
    const alternative: QuoteOffer = {
      ...offerA,
      id: 'alt-ro',
      kind: 'alternative',
      combinable: false,
      sourceRef: 'src-ro',
      quoteRequestKey: '2026-11-02:2026-11-04',
      coversGroupIds: [],
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: twoGroups });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [offerA],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [offerB],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(s.offers.map((offer) => offer.id).sort()).toEqual(['st-a', 'st-b']);
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [offerA, offerB, alternative],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(s.offers.map((offer) => offer.id).sort()).toEqual(['alt-ro', 'st-a', 'st-b']);
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: nextSelectedOfferIds(s, 'st-a') });
    expect(canCreatePdf(s)).toBe(false);
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: nextSelectedOfferIds(s, 'st-b') });
    expect(s.selectedOfferIds).toEqual(['st-a', 'st-b']);
    s = withStaffSource(s);
    expect(canCreatePdf(s)).toBe(false);
    expect(nextSelectedOfferIds(s, 'alt-ro')).toEqual(['st-a', 'st-b']);
  });

  it('does not invent a child aged 0 from a blank ages field', () => {
    expect(parseChildrenAges('')).toEqual([]);
    expect(parseChildrenAges('  , ')).toEqual([]);
    expect(parseChildrenAges('5,')).toEqual([5]);
    expect(parseChildrenAges('0')).toEqual([0]);
    expect(formatQuoteStepInputs({ organisation: 'Treasury', quoteRequestKey: '2026-12-01:2026-12-03' })).toMatch(
      /Organisation Treasury/,
    );
  });

  it('keeps mixed same-date groups selected and rejects a partial PDF', () => {
    const mixed = {
      ...quoteAnalysis,
      groups: [
        {
          ...quoteAnalysis.groups[0]!,
          id: 'g-double',
          arrivalDate: '2026-10-16',
          departureDate: '2026-10-18',
          adults: 2,
          quantity: 1,
          roomPreference: 'twin',
        },
        {
          ...quoteAnalysis.groups[0]!,
          id: 'g-single',
          arrivalDate: '2026-10-16',
          departureDate: '2026-10-18',
          adults: 1,
          quantity: 2,
          roomPreference: 'single',
        },
      ],
    };
    const mixA: QuoteOffer = {
      id: 'mix-a',
      kind: 'allocation',
      roomCode: 'STWN',
      roomLabel: 'Standard Twin',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [{ date: '2026-10-16', amountMinor: 313000 }],
      stayTotalMinor: 626000,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'src-a',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-10-16:2026-10-18',
      coversGroupIds: ['g-double'],
      quantity: 1,
      adults: 2,
      childrenAges: [],
    };
    const mixB: QuoteOffer = {
      ...mixA,
      id: 'mix-b',
      roomCode: 'SQUE',
      roomLabel: 'Standard Queen',
      sourceRef: 'src-b',
      coversGroupIds: ['g-single'],
      quantity: 2,
      adults: 1,
      stayTotalMinor: 566000,
    };
    const mixC: QuoteOffer = {
      ...mixB,
      id: 'mix-c',
      sourceRef: 'src-c',
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: mixed });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [mixA, mixB, mixC],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: nextSelectedOfferIds(s, 'mix-a') });
    expect(s.selectedOfferIds).toEqual(['mix-a']);
    expect(canCreatePdf(s)).toBe(false);
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: nextSelectedOfferIds(s, 'mix-b') });
    expect(s.selectedOfferIds).toEqual(['mix-a', 'mix-b']);
    s = withStaffSource(s);
    expect(canCreatePdf(s)).toBe(true);
    expect(nextSelectedOfferIds(s, 'mix-c')).toEqual(['mix-a', 'mix-c']);
  });

  it('refuses PDF when dates are missing even if a group id is covered', () => {
    const undated = {
      ...quoteAnalysis,
      groups: [{ ...quoteAnalysis.groups[0]!, arrivalDate: undefined, departureDate: undefined }],
    };
    const covered: QuoteOffer = {
      id: 'o2',
      kind: 'allocation',
      roomCode: 'SKNG',
      roomLabel: 'Standard King',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 1,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'src-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: 'unknown:unknown',
      coversGroupIds: ['g1'],
      quantity: 1,
      adults: 1,
      childrenAges: [],
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: undated });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [covered],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o2'] });
    expect(canCreatePdf(s)).toBe(false);
  });

  it('rejects over-quantity, board mismatch, and child-age mismatch as incomplete coverage', () => {
    const extraQty: QuoteOffer = {
      id: 'o1',
      kind: 'allocation',
      roomCode: 'SKNG',
      roomLabel: 'Standard King',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
      stayTotalMinor: 272000,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: 'src-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 2,
      adults: 1,
      childrenAges: [],
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [extraQty],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    expect(canCreatePdf(s)).toBe(false);

    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [{ ...extraQty, quantity: 1, board: 'dinner_bb' }],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(canCreatePdf(s)).toBe(false);

    const withKids = {
      ...quoteAnalysis,
      groups: [{ ...quoteAnalysis.groups[0]!, childrenAges: [8] }],
    };
    let kids = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    kids = reduceQuoteSession(kids, { type: 'analysis_ready', analysis: withKids });
    kids = reduceQuoteSession(kids, {
      type: 'results_ready',
      offers: [{ ...extraQty, quantity: 1, childrenAges: [] }],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    kids = reduceQuoteSession(kids, { type: 'select_offers', offerIds: ['o1'] });
    expect(canCreatePdf(kids)).toBe(false);
    kids = reduceQuoteSession(kids, {
      type: 'results_ready',
      offers: [{ ...extraQty, quantity: 1, childrenAges: [8] }],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    kids = reduceQuoteSession(kids, { type: 'select_offers', offerIds: ['o1'] });
    kids = withStaffSource(kids);
    expect(canCreatePdf(kids)).toBe(true);
  });

  it('makes quote_stay runnable without a separate party execute', () => {
    const withOrg = {
      ...quoteAnalysis,
      groups: [{ ...quoteAnalysis.groups[0]!, organisation: 'Provincial Treasury' }],
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: withOrg });
    const stay = s.steps.find((step) => step.kind === 'quote_stay')!;
    expect(s.steps.some((step) => step.kind === 'party_lookup')).toBe(false);
    expect(stay.status).toBe('ready');
    expect(pickNextRunnableStep(s.steps, null)?.id).toBe(stay.id);
  });

  it('sends the full approved grouped requirements as the stay DTO', () => {
    const withOrg = {
      ...quoteAnalysis,
      groups: [
        {
          ...quoteAnalysis.groups[0]!,
          organisation: 'Provincial Treasury',
          childrenAges: [8],
          board: 'dinner_bb' as const,
          specialRequests: ['late arrival'],
          quantity: 2,
          roomPreference: 'suite',
        },
      ],
    };
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: withOrg });
    const stay = s.steps.find((step) => step.kind === 'quote_stay')!;
    expect(buildQuoteStepInputs(s, stay)).toEqual({
      stepKind: 'quote_stay',
      binding: {
        transportId: 't1',
        mailboxEmail: 'centurion@legacyhotels.co.za',
        storeId: 'store',
        folderEntryId: 'inbox',
        entryId: 'e1',
        internetMessageId: '<a@x>',
        selectionEpoch: 1,
      },
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 2,
          roomPreference: 'suite',
          adults: 1,
          childrenAges: [8],
          board: 'dinner_bb',
          organisation: 'Provincial Treasury',
          specialRequests: ['late arrival'],
        },
      ],
    });
  });
});

const authorisedOffer: QuoteOffer = {
  id: 'o1',
  kind: 'allocation',
  roomCode: 'SKNG',
  roomLabel: 'Standard King',
  board: 'bb',
  rateCode: 'BAR',
  currency: 'ZAR',
  nightly: [{ date: '2026-11-12', amountMinor: 136000 }],
  stayTotalMinor: 272000,
  observedAt: '2026-10-05T12:00:00Z',
  sourceRef: 'src-1',
  restrictions: [],
  combinable: true,
  quoteRequestKey: '2026-11-12:2026-11-14',
  coversGroupIds: ['g1'],
  quantity: 1,
  adults: 1,
};

function emptyHeader() {
  return {
    salesStrategy: 'BAR' as const,
    company: '',
    agency: '',
    attention: '',
    clientEmail: '',
    clientTelephone: '',
  };
}

function analysisReady(analysis = quoteAnalysis) {
  return reduceQuoteSession(
    reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() }),
    { type: 'analysis_ready', analysis },
  );
}

const STAY_A = '2026-11-12:2026-11-14';
const STAY_B = '2026-12-01:2026-12-03';

function twoDateAnalysis(): QuoteAnalysis {
  return {
    intent: 'quote',
    groups: [
      quoteAnalysis.groups[0]!,
      { ...quoteAnalysis.groups[0]!, id: 'g2', arrivalDate: '2026-12-01', departureDate: '2026-12-03' },
    ],
    secondaryAsks: [],
    alternatives: [],
  };
}

function twoDateSession() {
  return withStaffSource(analysisReady(twoDateAnalysis()));
}

function stepFor(session: { steps: QuoteToolStep[] }, stayKey: string): QuoteToolStep {
  return session.steps.find((step) => step.shareKey === stayKey)!;
}

function staffQuoteFor(
  stayKey: string,
  revisionRef: string,
  totalMinor: number,
  inputRevision: number,
): QuoteSessionAction {
  return {
    type: 'staff_quote_ready',
    offer: {
      ...authorisedOffer,
      id: revisionRef,
      sourceRef: revisionRef,
      nightly: [],
      stayTotalMinor: totalMinor,
      quoteRequestKey: stayKey,
      coversGroupIds: [stayKey === STAY_A ? 'g1' : 'g2'],
    },
    staffQuote: {
      workflowRunId: `run-${revisionRef}`,
      revisionRef,
      factRefs: [],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: STAFF_HASH,
      selectionEpoch: 1,
      inputRevision,
      inputDigest: `digest-${revisionRef}`,
      totalMinor,
      currency: 'ZAR',
      quoteRequestKey: stayKey,
      approvedHeader: emptyHeader(),
    },
    selectionEpoch: 1,
    inputRevision,
  };
}

function quotePdf(revisionId: string, totalMinor = 850000): QuotePdf {
  return {
    fileName: `Quote-${revisionId}.pdf`,
    bytesBase64: 'JVBERi0xLjQK',
    pdfHash: 'cd'.repeat(32),
    revisionId,
    totalMinor,
  };
}

describe('quote session staff review items', () => {
  it('projects a clean selected quote with no Items for you', () => {
    const s = analysisReady({ intent: 'quote', groups: quoteAnalysis.groups, secondaryAsks: [], alternatives: [] });
    expect(s.reviewItems).toEqual([]);
    expect(openReviewItems(s)).toEqual([]);
  });

  it('keeps the actual unanswered question clause, not a truncated parking token', () => {
    const s = analysisReady({
      ...quoteAnalysis,
      secondaryAsks: ['Is parking included?', 'parking', 'parking included'],
    });
    expect(s.reviewItems.map((item) => item.text)).toEqual(['Is parking included?']);
    expect(s.reviewItems[0]).toMatchObject({ kind: 'question', rank: 'secondary', blocking: false });
  });

  it('names a failed business document by filename and reason', () => {
    const start = analysisReady();
    const s = reduceQuoteSession(start, {
      type: 'analysis_missing_source',
      missing: ['att-1'],
      documents: [
        {
          filename: 'rooming-list.pdf',
          reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
          sourceKind: 'attachment',
        },
      ],
    });
    expect(s.phase).toBe('missing_source');
    expect(s.groups).toEqual(quoteAnalysis.groups);
    expect(s.reviewItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'document_failure',
          text: 'Unread: rooming-list.pdf',
          filename: 'rooming-list.pdf',
          sourceLabel: 'Unread attachment',
          reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
          blocking: false,
        }),
        expect.objectContaining({ text: 'Is parking included?' }),
      ]),
    );
  });

  it('suppresses only positively identified signature or logo noise', () => {
    const noise: QuoteReviewItem = {
      id: 'noise-sig',
      kind: 'signature_noise',
      rank: 'unread_source',
      text: 'Hotel logo.png',
      sourceLabel: 'Signature block',
      blocking: false,
      positivelyIdentifiedNoise: true,
    };
    const unread: QuoteReviewItem = {
      id: 'unread-png',
      kind: 'document_failure',
      rank: 'unread_source',
      text: 'unknown-scan.png',
      sourceLabel: 'Attachment',
      filename: 'unknown-scan.png',
      reason: 'Unread image was not identified as signature or logo noise.',
      blocking: false,
    };
    const s = analysisReady({
      ...quoteAnalysis,
      secondaryAsks: [],
      reviewItems: [noise, unread],
    });
    expect(s.reviewItems.map((item) => item.id)).toEqual(['unread-png']);
  });

  it('handles and undoes a source-bound item without treating handling as pricing approval', () => {
    let s = analysisReady();
    const questionId = s.reviewItems.find((item) => item.kind === 'question')!.id;
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    s = withStaffSource(s);
    expect(canCreatePdf(s)).toBe(true);
    s = reduceQuoteSession(s, { type: 'handle_review_item', itemId: questionId });
    expect(openReviewItems(s)).toEqual([]);
    expect(s.handledReviewItemIds).toEqual([questionId]);
    expect(canCreatePdf(s)).toBe(true);
    s = reduceQuoteSession(s, { type: 'unhandle_review_item', itemId: questionId });
    expect(openReviewItems(s).map((item) => item.id)).toEqual([questionId]);
  });

  it('clears handling on selection change and keeps it across stay edits that drop PDF', () => {
    let s = analysisReady();
    const questionId = s.reviewItems.find((item) => item.kind === 'question')!.id;
    s = reduceQuoteSession(s, { type: 'handle_review_item', itemId: questionId });
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: { fileName: 'Quote-authorised.pdf', bytesBase64: 'JVBERi0xLjQK' },
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(s.pdf).not.toBeNull();
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(s.pdf).toBeNull();
    expect(canCreatePdf(s)).toBe(false);
    expect(s.handledReviewItemIds).toEqual([questionId]);
    const switched = reduceQuoteSession(s, {
      type: 'selection',
      binding: bind({ entryId: 'e2', selectionEpoch: 2 }),
    });
    expect(switched.handledReviewItemIds).toEqual([]);
    expect(switched.reviewItems).toEqual([]);
  });

  it('does not let a secondary ask block an otherwise authorised unsent insertion', () => {
    let s = analysisReady();
    expect(openReviewItems(s).some((item) => item.kind === 'question')).toBe(true);
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      reviewedReplyHtml: '<p>Full staff-edited reply</p>',
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    s = withStaffSource(s);
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: { fileName: 'Quote-authorised.pdf', bytesBase64: 'JVBERi0xLjQK' },
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
    });
    expect(canCreatePdf(s)).toBe(true);
    expect(canCreateNativeDraft(s)).toBe(true);
    expect(s.reviewedReplyHtml).toBe('<p>Full staff-edited reply</p>');
  });

  it('still blocks PDF when a pricing-critical fact is missing', () => {
    let s = analysisReady({
      intent: 'quote',
      groups: [
        {
          ...quoteAnalysis.groups[0]!,
          arrivalDate: undefined,
          fields: { ...quoteAnalysis.groups[0]!.fields, arrivalDate: 'missing' },
        },
      ],
      secondaryAsks: [],
      alternatives: [],
    });
    expect(s.reviewItems.some((item) => item.kind === 'pricing_fact' && item.blocking)).toBe(true);
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    expect(canCreatePdf(s)).toBe(false);
    expect(canCreateNativeDraft(s)).toBe(false);
  });

  it('keeps staffAction sourceHash, messageId, and sourceRef on the projected item', () => {
    let s = analysisReady({ intent: 'quote', groups: quoteAnalysis.groups, secondaryAsks: [], alternatives: [] });
    s = withStaffSource(s);
    s = reduceQuoteSession(s, {
      type: 'staff_actions_ready',
      actions: [
        {
          id: 'sa-park',
          kind: 'unanswered_question',
          text: 'Is parking included?',
          sourceRef: 'message:mail-1:12-40',
          sourceHash: STAFF_HASH,
          sourceKind: 'message',
          messageId: 'mail-1',
          blockingQuote: false,
          status: 'open',
        },
      ],
    });
    expect(s.reviewItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sa-park',
          sourceHash: STAFF_HASH,
          sourceRef: 'message:mail-1:12-40',
          messageId: 'mail-1',
        }),
      ]),
    );
  });

  it('uses source identity for document failures so the same filename does not collide', () => {
    const documents = [
      {
        filename: 'rooming-list.pdf',
        reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
        sourceKind: 'attachment' as const,
        sourceRef: 'att-1',
      },
      {
        filename: 'rooming-list.pdf',
        reason: 'Second copy was not authorised.',
        sourceKind: 'attachment' as const,
        sourceRef: 'att-2',
      },
    ];
    const items = documentFailureItems(documents);
    expect(items.map((item) => item.id)).toEqual([
      'document:attachment:att-1:rooming-list.pdf',
      'document:attachment:att-2:rooming-list.pdf',
    ]);
    expect(items.map((item) => item.text)).toEqual([
      'Unread: rooming-list.pdf',
      'Unread: rooming-list.pdf',
    ]);
  });

  it('merges extra document failures with explicit review items instead of dropping them', () => {
    const explicit = {
      id: 'q-shuttle',
      kind: 'question' as const,
      rank: 'secondary' as const,
      text: 'Is an airport shuttle available?',
      sourceLabel: 'Selected message',
      blocking: false,
    };
    const extra = documentFailureItems([
      {
        filename: 'rooming-list.pdf',
        reason: 'Authorised attachment content is missing. Filenames are not document bytes.',
        sourceKind: 'attachment',
        sourceRef: 'att-1',
      },
    ]);
    const merged = projectQuoteReviewItems(
      { intent: 'quote', groups: quoteAnalysis.groups, secondaryAsks: [], alternatives: [], reviewItems: [explicit] },
      quoteAnalysis.groups,
      extra,
    );
    expect(merged.map((item) => item.id).sort()).toEqual(
      ['document:attachment:att-1:rooming-list.pdf', 'q-shuttle'].sort(),
    );
  });

  it('does not hide pricing blocks or treat Mark handled as satisfying missing pricing facts', () => {
    let s = analysisReady({
      intent: 'quote',
      groups: [
        {
          ...quoteAnalysis.groups[0]!,
          arrivalDate: undefined,
          fields: { ...quoteAnalysis.groups[0]!.fields, arrivalDate: 'missing' },
        },
      ],
      secondaryAsks: ['Is parking included?'],
      alternatives: [],
    });
    const pricingId = s.reviewItems.find((item) => item.kind === 'pricing_fact')!.id;
    s = reduceQuoteSession(s, { type: 'handle_review_item', itemId: pricingId });
    expect(s.handledReviewItemIds).toEqual([]);
    expect(openReviewItems(s).some((item) => item.id === pricingId)).toBe(true);
    s = {
      ...s,
      handledReviewItemIds: [pricingId],
    };
    expect(openReviewItems(s).some((item) => item.id === pricingId)).toBe(true);
    s = withStaffSource(s);
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    expect(canCreatePdf(s)).toBe(false);
  });

  it('resets handled state when staffQuoteSource hash changes and keeps it for the same hash', () => {
    let s = withStaffSource(analysisReady());
    const questionId = s.reviewItems.find((item) => item.kind === 'question')!.id;
    s = reduceQuoteSession(s, { type: 'handle_review_item', itemId: questionId });
    expect(s.handledReviewItemIds).toEqual([questionId]);
    expect(s.handledSourceKey).toBe(STAFF_HASH);
    s = reduceQuoteSession(s, { type: 'staff_source_ready', source: staffSource() });
    expect(s.handledReviewItemIds).toEqual([questionId]);
    s = reduceQuoteSession(s, {
      type: 'staff_source_ready',
      source: staffSource({ sourceHash: 'cd'.repeat(32) }),
    });
    expect(s.handledReviewItemIds).toEqual([]);
    expect(s.handledSourceKey).toBe('cd'.repeat(32));
  });

  it('does not treat Outlook selection binding as quote authorisation without staffQuoteSource', () => {
    let s = analysisReady();
    s = reduceQuoteSession(s, {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    expect(Boolean(s.binding)).toBe(true);
    expect(staffSourceReady(s)).toBe(false);
    expect(canCreatePdf(s)).toBe(false);
    s = withStaffSource(s);
    expect(staffSourceReady(s)).toBe(true);
    expect(canCreatePdf(s)).toBe(true);
  });

  it('keeps approved execute company/agency on the quote and invalidates PDF if they change', () => {
    const approvedHeader = {
      salesStrategy: 'BAR' as const,
      company: 'Provincial Treasury',
      agency: '',
      attention: '',
      clientEmail: '',
      clientTelephone: '',
    };
    const offer: QuoteOffer = {
      id: 'rev-1',
      kind: 'allocation',
      roomCode: '',
      roomLabel: 'Selected allocation',
      board: 'bb',
      rateCode: '',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 850000,
      observedAt: '',
      sourceRef: 'rev-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 1,
    };
    let s = analysisReady();
    s = {
      ...s,
      staffHeader: { ...s.staffHeader, ...approvedHeader },
    };
    s = withStaffSource(s);
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer,
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader,
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    expect(s.staffQuote?.approvedHeader).toEqual(approvedHeader);
    expect(s.staffQuote?.approvedHeader.agency).toBe('');
    expect(canCreatePdf(s)).toBe(true);
    const aliased = { ...s, staffHeader: { ...s.staffHeader, company: s.groups[0]?.organisation || 'Display alias' } };
    expect(canCreatePdf(aliased)).toBe(false);
    const changed = reduceQuoteSession(s, { type: 'patch_staff_header', header: { company: 'Other company' } });
    expect(changed.staffQuote).toBeNull();
    expect(canCreatePdf(changed)).toBe(false);
  });

  it('preserves a running quote when delayed analysis has unchanged requirements', () => {
    let s = analysisReady();
    const stepId = s.steps[0]!.id;
    s = reduceQuoteSession(s, { type: 'step_running', stepId });
    const next = reduceQuoteSession(s, { type: 'analysis_ready', analysis: quoteAnalysis });
    expect(next.runningStepId).toBe(stepId);
    expect(next.steps).toEqual(s.steps);
    expect(next.inputRevision).toBe(s.inputRevision);
  });

  it('does not let delayed analysis overwrite staff stay edits', () => {
    let s = analysisReady();
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 4 } });
    expect(s.groups[0]?.adults).toBe(4);
    expect(s.inputRevision).toBe(2);
    const analysis = s.analysis;
    s = reduceQuoteSession(s, {
      type: 'analysis_ready',
      analysis: {
        ...quoteAnalysis,
        groups: [{ ...quoteAnalysis.groups[0]!, adults: 1 }],
      },
    });
    expect(s.groups[0]?.adults).toBe(4);
    expect(s.inputRevision).toBe(2);
    expect(s.analysis).toBe(analysis);
  });

  it('clears quote authority on a new submission and never restores an old stay', () => {
    const g2 = {
      ...quoteAnalysis.groups[0]!,
      id: 'g2',
      arrivalDate: '2026-12-01',
      departureDate: '2026-12-03',
    };
    let s = analysisReady({
      intent: 'quote',
      groups: [quoteAnalysis.groups[0]!, g2],
      secondaryAsks: [],
      alternatives: [],
    });
    s = withStaffSource(s);
    const firstOffer: QuoteOffer = {
      ...authorisedOffer,
      id: 'rev-a',
      sourceRef: 'rev-a',
      nightly: [],
      stayTotalMinor: 850000,
      quoteRequestKey: '2026-11-12:2026-11-14',
    };
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer: firstOffer,
      staffQuote: {
        workflowRunId: 'run-a',
        revisionRef: 'rev-a',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest-a',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader: emptyHeader(),
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    expect(Object.keys(s.staffQuotes)).toEqual(['2026-11-12:2026-11-14']);
    const switched = reduceQuoteSession(s, { type: 'select_stay_key', stayKey: '2026-12-01:2026-12-03' });
    // Option A's result stays for later; the unrun option B gets no authority from it.
    expect(switched.staffQuote).toBeNull();
    expect(Object.keys(switched.staffQuotes)).toEqual(['2026-11-12:2026-11-14']);
    expect(switched.offers.map((offer) => offer.id)).toEqual(['rev-a']);
    expect(switched.selectedOfferIds).toEqual([]);
    expect(switched.pdf).toBeNull();
  });

  it('keeps option A when option B runs, and B waits until A has its PDF', () => {
    let s = twoDateSession();
    expect(s.steps.map((step) => step.status)).toEqual(['ready', 'ready']);
    expect(canRunQuoteStep(stepFor(s, STAY_B), s.steps, stepFor(s, STAY_A).id)).toBe(false);
    expect(pickNextRunnableStep(s.steps, null)?.shareKey).toBe(STAY_A);

    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    expect(stepFor(s, STAY_A).status).toBe('succeeded');
    expect(stepFor(s, STAY_B).status).toBe('ready');
    expect(quoteRunBlockReason(s, stepFor(s, STAY_B))).toBe(
      'Finish the PDF for option A first, then run option B.',
    );

    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: quotePdf('rev-a'),
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      selectedOfferIds: ['rev-a'],
    });
    expect(quoteRunBlockReason(s, stepFor(s, STAY_B))).toBeNull();

    s = reduceQuoteSession(s, staffQuoteFor(STAY_B, 'rev-b', 920000, s.inputRevision));
    expect(stepFor(s, STAY_A).status).toBe('succeeded');
    expect(stepFor(s, STAY_B).status).toBe('succeeded');
    expect(s.staffQuotes[STAY_A]?.revisionRef).toBe('rev-a');
    expect(s.stayPdfs[STAY_A]?.revisionId).toBe('rev-a');
    expect(s.offers.map((offer) => offer.id).sort()).toEqual(['rev-a', 'rev-b']);
    expect(s.selectedStayKey).toBe(STAY_B);
    expect(s.pdf).toBeNull();
  });

  it('selecting a date option keeps every result and shows only that option PDF', () => {
    let s = twoDateSession();
    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: quotePdf('rev-a'),
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      selectedOfferIds: ['rev-a'],
    });
    s = reduceQuoteSession(s, staffQuoteFor(STAY_B, 'rev-b', 920000, s.inputRevision));

    const toA = reduceQuoteSession(s, { type: 'select_stay_key', stayKey: STAY_A });
    expect(Object.keys(toA.staffQuotes).sort()).toEqual([STAY_A, STAY_B]);
    expect(toA.offers.map((offer) => offer.id).sort()).toEqual(['rev-a', 'rev-b']);
    expect(toA.staffQuote?.revisionRef).toBe('rev-a');
    expect(toA.selectedOfferIds).toEqual(['rev-a']);
    expect(toA.pdf?.revisionId).toBe('rev-a');
    expect(stepFor(toA, STAY_A).status).toBe('succeeded');
    expect(stepFor(toA, STAY_B).status).toBe('succeeded');
    const reviewed = reduceQuoteSession(toA, { type: 'set_reviewed_reply', html: '<p>Reply for A</p>' });
    expect(canCreateNativeDraft(reviewed)).toBe(true);

    const toB = reduceQuoteSession(toA, { type: 'select_stay_key', stayKey: STAY_B });
    expect(toB.staffQuote?.revisionRef).toBe('rev-b');
    expect(toB.pdf).toBeNull();
    expect(canCreateNativeDraft(reduceQuoteSession(toB, { type: 'set_reviewed_reply', html: '<p>B</p>' }))).toBe(false);

    // Re-reading the same email must not reopen option A.
    const reread = reduceQuoteSession(toB, { type: 'analysis_ready', analysis: twoDateAnalysis() });
    expect(stepFor(reread, STAY_A).status).toBe('succeeded');
    expect(Object.keys(reread.staffQuotes).sort()).toEqual([STAY_A, STAY_B]);
  });

  it('a failed later option keeps the earlier option result', () => {
    let s = twoDateSession();
    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: quotePdf('rev-a'),
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      selectedOfferIds: ['rev-a'],
    });
    const stepB = stepFor(s, STAY_B).id;
    s = reduceQuoteSession(s, { type: 'step_running', stepId: stepB });
    s = reduceQuoteSession(s, {
      type: 'results_unavailable',
      stepId: stepB,
      reason: 'HMS did not answer. Run option B again.',
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    expect(stepFor(s, STAY_B).status).toBe('failed');
    expect(stepFor(s, STAY_A).status).toBe('succeeded');
    expect(s.staffQuotes[STAY_A]?.revisionRef).toBe('rev-a');
    expect(s.stayPdfs[STAY_A]).toBeDefined();
    expect(s.errorMessage).toBe('HMS did not answer. Run option B again.');
    expect(quoteRunBlockReason(s, stepFor(s, STAY_B))).toBeNull();
    expect(canRunQuoteStep(stepFor(s, STAY_B), s.steps, null)).toBe(true);
  });

  it('a header change clears every date result and makes each option runnable again', () => {
    let s = twoDateSession();
    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    s = reduceQuoteSession(s, { type: 'patch_staff_header', header: { company: 'Acme' } });
    expect(s.staffQuotes).toEqual({});
    expect(s.stayPdfs).toEqual({});
    expect(s.steps.map((step) => step.status)).toEqual(['ready', 'ready']);
  });

  it('keeps the full reply on repricing but requires a reviewed current PDF', () => {
    let s = analysisReady({ intent: 'quote', groups: quoteAnalysis.groups, secondaryAsks: [], alternatives: [] });
    s = withStaffSource(s);
    s = reduceQuoteSession(s, { type: 'set_reviewed_reply', html: '<p>Full staff-edited reply</p>' });
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer: { ...authorisedOffer, id: 'rev-1', sourceRef: 'rev-1', nightly: [], stayTotalMinor: 850000 },
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader: emptyHeader(),
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    expect(s.reviewedReplyHtml).toBe('<p>Full staff-edited reply</p>');
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 2 } });
    expect(s.reviewedReplyHtml).toBe('<p>Full staff-edited reply</p>');
    expect(s.pdf).toBeNull();
    expect(s.staffQuote).toBeNull();
    expect(canCreateNativeDraft(s)).toBe(false);
  });

  it('retries analysis when unsynced mailbox committed count advances', () => {
    expect(analysisRetryKey('sel|1|1', 'requirements', 4)).toBe('sel|1|1');
    expect(analysisRetryKey('sel|1|1', 'unsynced')).toBe('sel|1|1');
    expect(analysisRetryKey('sel|1|1', 'unsynced', 4)).toBe('sel|1|1|committed:4');
    expect(analysisRetryKey('sel|1|1', 'unsynced', 5)).toBe('sel|1|1|committed:5');
  });

  it('re-runs analysis when staff submit a Tell Luna note', () => {
    expect(initialQuoteSession().staffNote).toBeNull();
    let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: '4 twins at R1800' });
    expect(session.staffNote).toBe('4 twins at R1800');
    expect(analysisRetryKey('sel|1|1', 'requirements', undefined, null, '4 twins at R1800')).toBe(
      'sel|1|1|note:4 twins at R1800',
    );
  });

  it('applies Tell Luna analysis even after staff stay edits', () => {
    let session = analysisReady();
    session = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { adults: 9 } });
    expect(hasStaffStayEdits(session)).toBe(true);
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: '2 twins' });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        ...quoteAnalysis,
        groups: [{ ...quoteAnalysis.groups[0]!, adults: 2, quantity: 2 }],
      },
    });
    expect(session.groups[0]?.adults).toBe(2);
    expect(session.groups[0]?.quantity).toBe(2);
    expect(session.staffNote).toBe('2 twins');
  });

  it('re-runs analysis when staff treat-as quote or booking', () => {
    expect(initialQuoteSession().treatAs).toBeNull();
    let session = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    session = reduceQuoteSession(session, { type: 'treat_as', treatAs: 'quote' });
    expect(session.treatAs).toBe('quote');
    expect(analysisRetryKey('sel|1|1', 'non_quote', undefined, 'quote')).toBe(
      'sel|1|1|treatAs:quote',
    );
    session = reduceQuoteSession(session, { type: 'treat_as', treatAs: 'create_booking' });
    expect(session.treatAs).toBe('create_booking');
  });

  it('starts with a null bookingDraft and clears it downstream', () => {
    expect(initialQuoteSession().bookingDraft).toBeNull();
    let s = analysisReady();
    s = {
      ...s,
      bookingDraft: {
        draft: { rooms: [], rateCheck: [], missing: [], flags: [] },
        options: { track: [], sourceOfBusiness: [], guaranteeType: [] },
        messageId: 'mail-1',
        selectionEpoch: 1,
        inputRevision: 1,
        revisionRef: 'rev-1',
      },
    };
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    expect(s.bookingDraft).toBeNull();
  });

  it('accepts a matching booking_draft_ready and ignores a stale selectionEpoch', () => {
    const payload = {
      draft: {
        rooms: [
          {
            groupId: 'g1',
            roomIndex: 1,
            request: { agency: 'XYZ TRAVEL', roomType: 'STQN', ratePlan: 'TAXYZ' },
            schemaErrors: [] as string[],
          },
        ],
        rateCheck: [],
        missing: [],
        flags: [] as string[],
      },
      options: { track: ['BAR'], sourceOfBusiness: ['Travel Agent'], guaranteeType: ['Guaranteed By Agent'] },
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: 1,
      revisionRef: 'rev-1',
    };
    let s = analysisReady();
    s = withStaffSource(s);
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer: { ...authorisedOffer, id: 'rev-1', sourceRef: 'rev-1', nightly: [], stayTotalMinor: 850000 },
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader: emptyHeader(),
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    const stale = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: { ...payload, selectionEpoch: 9 },
      sourceHash: STAFF_HASH,
    });
    expect(stale.bookingDraft).toBeNull();
    const ready = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload,
      sourceHash: STAFF_HASH,
    });
    expect(ready.bookingDraft?.draft.rooms).toHaveLength(1);
    const otherRevision = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: { ...payload, revisionRef: 'rev-other' },
      sourceHash: STAFF_HASH,
    });
    expect(otherRevision.bookingDraft).toBeNull();
    const patched = reduceQuoteSession(ready, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    expect(patched.bookingDraft).toBeNull();
  });

  it('prefills government party into company and salesStrategy when header is empty', () => {
    const s = analysisReady({
      ...quoteAnalysis,
      luna: {
        workflow: 'quote',
        flags: [],
        groups: [],
        party: { kind: 'government', name: 'Dept X', reference: null },
        rateClaims: [],
        missing: [],
        evidence: [],
        tasks: [],
      },
    });
    expect(s.staffHeader.company).toBe('Dept X');
    expect(s.staffHeader.salesStrategy).toBe('Government');
    expect(s.staffHeader.agency).toBe('');
  });

  it('does not overwrite a staff-edited header with luna.party', () => {
    let s = analysisReady();
    s = reduceQuoteSession(s, { type: 'patch_staff_header', header: { company: 'Staff Co' } });
    s = reduceQuoteSession(s, {
      type: 'analysis_ready',
      analysis: {
        ...quoteAnalysis,
        luna: {
          workflow: 'quote',
          flags: [],
          groups: [],
          party: { kind: 'government', name: 'Dept X', reference: null },
          rateClaims: [],
          missing: [],
          evidence: [],
          tasks: [],
        },
      },
    });
    expect(s.staffHeader.company).toBe('Staff Co');
    expect(s.staffHeader.salesStrategy).toBe('BAR');
  });

  it('prefills a per-person dinner allowance and ignores room rates that include dinner', () => {
    const allowance = analysisReady({
      ...quoteAnalysis,
      luna: lunaQuote({
        rateClaims: [
          {
            kind: 'exact',
            amount: '450',
            currency: 'ZAR',
            basis: 'unknown',
            taxBasis: 'gross_included',
            quote: 'Dinner allowance R450 per person per night',
          },
        ],
      }),
    });
    expect(allowance.staffHeader.dinnerAllowanceMinor).toBe(45000);
    const included = analysisReady({
      ...quoteAnalysis,
      luna: lunaQuote({
        rateClaims: [
          {
            kind: 'exact',
            amount: '1560',
            currency: 'ZAR',
            basis: 'per_room_per_night',
            taxBasis: 'gross_included',
            quote: 'R1,560 per room per night including dinner',
          },
        ],
      }),
    });
    expect(included.staffHeader.dinnerAllowanceMinor).toBeUndefined();
  });

  it('checks shuttle only when the email mentions a shuttle or transfer', () => {
    const dinnerOnly = analysisReady({
      ...quoteAnalysis,
      luna: lunaQuote({ flags: ['extras'] }),
    });
    expect(dinnerOnly.staffHeader.shuttleRequested).toBeUndefined();
    const shuttle = analysisReady({
      ...quoteAnalysis,
      luna: lunaQuote({
        flags: ['extras'],
        evidence: [{ field: 'specialRequests', quote: 'Please add an airport shuttle' }],
      }),
    });
    expect(shuttle.staffHeader.shuttleRequested).toBe(true);
  });

  it('applies the approved quote header without bumping inputRevision', () => {
    let s = analysisReady();
    s = withStaffSource(s);
    const approvedHeader = {
      salesStrategy: 'BAR' as const,
      company: 'Acme Corp',
      agency: 'XYZ TRAVEL',
      attention: '',
      clientEmail: '',
      clientTelephone: '',
    };
    const offer: QuoteOffer = {
      id: 'rev-1',
      kind: 'allocation',
      roomCode: '',
      roomLabel: 'Selected allocation',
      board: 'bb',
      rateCode: '',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 850000,
      observedAt: '',
      sourceRef: 'rev-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 1,
    };
    const quoted = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer,
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader,
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      approvedHeader,
    });
    expect(quoted.inputRevision).toBe(s.inputRevision);
    expect(quoted.staffHeader.company).toBe('Acme Corp');
    expect(quoted.staffHeader.agency).toBe('XYZ TRAVEL');
    expect(canCreatePdf(quoted)).toBe(true);
  });

  it('applies restored stay groups so a short booking email can still create a PDF', () => {
    let s = analysisReady({
      ...quoteAnalysis,
      groups: [{ ...quoteAnalysis.groups[0]!, arrivalDate: undefined, departureDate: undefined }],
    });
    s = withStaffSource(s);
    const approvedHeader = emptyHeader();
    const restored = {
      ...quoteAnalysis.groups[0]!,
      arrivalDate: '2026-11-12',
      departureDate: '2026-11-14',
    };
    const offer: QuoteOffer = {
      id: 'rev-1',
      kind: 'allocation',
      roomCode: '',
      roomLabel: 'Selected allocation',
      board: 'bb',
      rateCode: '',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 850000,
      observedAt: '',
      sourceRef: 'rev-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 1,
    };
    const quoted = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer,
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: '2026-11-12:2026-11-14',
        approvedHeader,
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      approvedHeader,
      groups: [restored],
    });
    expect(quoted.groups[0]?.arrivalDate).toBe('2026-11-12');
    expect(canCreatePdf(quoted)).toBe(true);
  });

  it('replaces previous quote-extras review items with the latest notes', () => {
    let s = analysisReady();
    s = withStaffSource(s);
    const approvedHeader = emptyHeader();
    const offer: QuoteOffer = {
      id: 'rev-1',
      kind: 'allocation',
      roomCode: '',
      roomLabel: 'Selected allocation',
      board: 'bb',
      rateCode: '',
      currency: 'ZAR',
      nightly: [],
      stayTotalMinor: 850000,
      observedAt: '',
      sourceRef: 'rev-1',
      restrictions: [],
      combinable: true,
      quoteRequestKey: '2026-11-12:2026-11-14',
      coversGroupIds: ['g1'],
      quantity: 1,
    };
    const staffQuote = {
      workflowRunId: 'run-1',
      revisionRef: 'rev-1',
      factRefs: [] as string[],
      messageId: 'mail-1',
      threadId: 'thread-1',
      sourceHash: STAFF_HASH,
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      inputDigest: 'digest',
      totalMinor: 850000,
      currency: 'ZAR',
      quoteRequestKey: '2026-11-12:2026-11-14',
      approvedHeader,
    };
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer,
      staffQuote,
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      extrasReviewItems: ['Shuttle requested — add a price or answer in the reply'],
    });
    expect(s.reviewItems.some((item) => /Shuttle requested/i.test(item.text))).toBe(true);
    s = reduceQuoteSession(s, {
      type: 'staff_quote_ready',
      offer,
      staffQuote,
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      extrasReviewItems: [],
    });
    expect(s.reviewItems.some((item) => item.sourceLabel === 'Quote extras')).toBe(false);
  });
});

describe('Tell Luna runs racing staff stay edits', () => {
  const twoAdultsTwoRooms = { ...quoteAnalysis.groups[0]!, adults: 2, quantity: 2 };

  it('keeps stay edits made after Tell Luna was submitted while the run is in flight', () => {
    let session = analysisReady();
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: '2 twins' });
    session = reduceQuoteSession(session, { type: 'analysis_started' });
    session = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { adults: 9 } });
    const late = { ...quoteAnalysis, groups: [twoAdultsTwoRooms] };
    session = reduceQuoteSession(session, { type: 'analysis_ready', analysis: late });
    expect(session.groups[0]?.adults).toBe(9);
    expect(session.groups[0]?.quantity).toBe(1);
    expect(session.analysis).toEqual(late);
    expect(session.phase).toBe('requirements');
    expect(session.staffNote).toBe('2 twins');
  });

  it('still applies the Tell Luna note result when staff only edit the header during the run', () => {
    let session = analysisReady();
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: 'arrive 1 Dec, leave 3 Dec' });
    session = reduceQuoteSession(session, { type: 'analysis_started' });
    session = reduceQuoteSession(session, {
      type: 'patch_staff_header',
      header: { company: 'Staff Co', agency: 'XYZ TRAVEL' },
    });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: {
        ...quoteAnalysis,
        groups: [{ ...twoAdultsTwoRooms, arrivalDate: '2026-12-01', departureDate: '2026-12-03' }],
      },
    });
    expect(session.groups[0]?.arrivalDate).toBe('2026-12-01');
    expect(session.groups[0]?.departureDate).toBe('2026-12-03');
    expect(session.groups[0]?.adults).toBe(2);
    expect(session.phase).toBe('requirements');
    expect(session.staffHeader.company).toBe('Staff Co');
    expect(session.staffHeader.agency).toBe('XYZ TRAVEL');
    expect(session.staffNote).toBe('arrive 1 Dec, leave 3 Dec');
  });

  it('keeps stay groups restored by a re-quote when a Tell Luna run lands afterwards', () => {
    let session = withStaffSource(analysisReady());
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: 'arrive 1 Dec, leave 3 Dec' });
    session = reduceQuoteSession(session, { type: 'analysis_started' });
    const restored = { ...twoAdultsTwoRooms, arrivalDate: '2026-12-01', departureDate: '2026-12-03' };
    const stayKey = '2026-12-01:2026-12-03';
    const offer: QuoteOffer = {
      ...authorisedOffer,
      id: 'rev-1',
      sourceRef: 'rev-1',
      nightly: [],
      stayTotalMinor: 850000,
      quoteRequestKey: stayKey,
      coversGroupIds: ['g1'],
      quantity: 2,
    };
    session = reduceQuoteSession(session, {
      type: 'staff_quote_ready',
      offer,
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: session.inputRevision,
        inputDigest: 'digest',
        totalMinor: 850000,
        currency: 'ZAR',
        quoteRequestKey: stayKey,
        approvedHeader: emptyHeader(),
      },
      selectionEpoch: 1,
      inputRevision: session.inputRevision,
      groups: [restored],
    });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: { ...quoteAnalysis, groups: [twoAdultsTwoRooms] },
    });
    expect(session.groups[0]?.arrivalDate).toBe('2026-12-01');
    expect(session.groups[0]?.departureDate).toBe('2026-12-03');
  });

  it('applies the Tell Luna result when staff did not edit during the run', () => {
    let session = analysisReady();
    session = reduceQuoteSession(session, { type: 'staff_note', staffNote: '2 twins' });
    session = reduceQuoteSession(session, { type: 'analysis_started' });
    session = reduceQuoteSession(session, {
      type: 'analysis_ready',
      analysis: { ...quoteAnalysis, groups: [twoAdultsTwoRooms] },
    });
    expect(session.groups[0]?.adults).toBe(2);
    expect(session.groups[0]?.quantity).toBe(2);
    expect(session.phase).toBe('requirements');
  });

  it('finishes the loading state when a re-run after earlier stay edits applies no note', () => {
    let session = analysisReady();
    session = reduceQuoteSession(session, { type: 'patch_group', groupId: 'g1', patch: { adults: 9 } });
    session = reduceQuoteSession(session, { type: 'treat_as', treatAs: 'quote' });
    session = reduceQuoteSession(session, { type: 'analysis_started' });
    session = reduceQuoteSession(session, { type: 'analysis_ready', analysis: quoteAnalysis });
    expect(session.phase).toBe('requirements');
    expect(session.groups[0]?.adults).toBe(9);
  });
});

function lunaQuote(over: Partial<LunaAnalysisWire> = {}): LunaAnalysisWire {
  return {
    workflow: 'quote',
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
    ...over,
  };
}

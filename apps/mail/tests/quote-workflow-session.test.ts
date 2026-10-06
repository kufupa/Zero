import { describe, expect, it } from 'vitest';
import {
  allocationTotal,
  canCreateNativeDraft,
  canCreatePdf,
  initialQuoteSession,
  planQuoteSteps,
  reduceQuoteSession,
  selectionDigest,
} from '../lib/quote-workflow/session';
import type { QuoteOffer, QuoteSelectionBinding } from '../lib/quote-workflow/types';

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

const quoteAnalysis = {
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
        analysis: { intent: 'other', groups: [], secondaryAsks: [], alternatives: [] },
      },
    );
    expect(s.phase).toBe('non_quote');
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
    expect(org.some((step) => step.kind === 'party_lookup')).toBe(true);
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
        },
      ],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
    expect(s.evidence).toEqual({ kind: 'authorised', selectionEpoch: 1, inputRevision: 1 });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
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
});

import { describe, expect, it } from 'vitest';
import {
  allocationTotal,
  canCreateNativeDraft,
  canCreatePdf,
  initialQuoteSession,
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
    });
    s = reduceQuoteSession(s, { type: 'pdf_ready', pdf: { fileName: 'Quote.pdf', bytesBase64: 'JVBERw==' } });
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
    });
    expect(stale.phase).toBe('results');
    expect(ignored.offers).toEqual([]);
    expect(ignored.phase).toBe('idle');
  });
});

import { describe, expect, it } from 'vitest';
import {
  allocationTotal,
  autoRunHeader,
  canCreateNativeDraft,
  canCreatePdf,
  canRunQuoteStep,
  formatQuoteStepInputs,
  initialQuoteSession,
  nextSelectedOfferIds,
  parseChildrenAges,
  pdfBlocker,
  pickNextRunnableStep,
  planQuoteSteps,
  quoteRunBlockReason,
  quoteRunIsCurrent,
  reduceQuoteSession,
  selectionDigest,
  buildQuoteStepInputs,
  staffSourceReady,
  analysisRetryKey,
  hasStaffStayEdits,
  dinnerAddOnInputProblem,
  dinnerAllowanceStillRequired,
  missingQuoteDetailsReplyOnly,
  isMultiStay,
  quoteDeclineReplyOnly,
  missingQuoteReplyFieldsForGroups,
  groupStays,
  removedStayFor,
  rowRoomCode,
  stayIdOf,
  stayTotals,
} from '../lib/quote-workflow/session';
import { documentFailureItems, openReviewItems, projectQuoteReviewItems } from '../lib/quote-workflow/review-items';
import {
  defaultStaffStayExtras,
  emptyStaffQuoteHeader,
  staffHeaderFieldProblem,
  staffStayExtrasFor,
} from '../lib/quote-workflow/types';
import { approvedExecuteHeader, staffHeaderForStay } from '../lib/quote-workflow/staff-quote-bind';
import { workbookRequestFor } from '../lib/quote-workflow/quote-workbook-download';
import { quoteWrapperHtml } from '../lib/quote-proposal/copy';
import { pdfBlockReason } from '../components/quote-workflow/document-review';
import type {
  LunaAnalysisWire,
  QuoteAnalysis,
  QuoteOffer,
  QuotePdf,
  QuoteReviewItem,
  QuoteSelectionBinding,
  QuoteSession,
  QuoteSessionAction,
  QuoteToolStep,
  RateOption,
  StaffQuoteAllocation,
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
  it('does not tick shuttle for a bank transfer, but does for an airport transfer', () => {
    const analysisWith = (request: string) => ({
      ...quoteAnalysis,
      groups: [{ ...quoteAnalysis.groups[0]!, specialRequests: [request] }],
    });
    const bank = reduceQuoteSession(
      { ...initialQuoteSession(), binding: bind() },
      { type: 'analysis_ready', analysis: analysisWith('Please confirm the bank transfer details') },
    );
    expect(bank.staffHeader.shuttleRequested).toBeFalsy();
    const airport = reduceQuoteSession(
      { ...initialQuoteSession(), binding: bind() },
      { type: 'analysis_ready', analysis: analysisWith('Airport transfer on arrival') },
    );
    expect(airport.staffHeader.shuttleRequested).toBe(true);
  });

  it('defaults Dinner B&B asks to Government unless staff already chose a rate strategy', () => {
    const dinnerAnalysis: QuoteAnalysis = {
      ...quoteAnalysis,
      groups: quoteAnalysis.groups.map((group) => ({ ...group, board: 'dinner_bb' as const })),
    };
    const defaulted = reduceQuoteSession(initialQuoteSession(), {
      type: 'analysis_ready',
      analysis: dinnerAnalysis,
    });
    expect(defaulted.staffHeader.salesStrategy).toBe('Government');

    const staffBar = reduceQuoteSession(initialQuoteSession(), {
      type: 'patch_staff_header',
      header: { salesStrategy: 'BAR' },
    });
    const preserved = reduceQuoteSession(staffBar, {
      type: 'analysis_ready',
      analysis: dinnerAnalysis,
    });
    expect(preserved.staffSalesStrategyEdited).toBe(true);
    expect(preserved.staffHeader.salesStrategy).toBe('BAR');

    const governmentBAndB: QuoteAnalysis = {
      ...dinnerAnalysis,
      groups: quoteAnalysis.groups.map((group) => ({ ...group, board: 'bb' as const })),
      luna: {
        ...dinnerAnalysis.luna!,
        party: { kind: 'government', name: 'Department X', reference: null },
      },
    };
    const preservedForGovernmentParty = reduceQuoteSession(staffBar, {
      type: 'analysis_ready',
      analysis: governmentBAndB,
    });
    expect(preservedForGovernmentParty.staffHeader.salesStrategy).toBe('BAR');
    expect(preservedForGovernmentParty.staffHeader.company).toBe('Department X');
  });

  it('keeps the existing Government-party default for B&B asks', () => {
    const analysis: QuoteAnalysis = {
      ...quoteAnalysis,
      luna: {
        workflow: 'quote',
        flags: [],
        groups: [],
        party: { kind: 'government', name: 'Department X', reference: null },
        rateClaims: [],
        missing: [],
        evidence: [],
        tasks: [],
      },
    };
    const ready = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_ready', analysis });

    expect(ready.staffHeader.salesStrategy).toBe('Government');
    expect(ready.staffHeader.company).toBe('Department X');
  });

  it('an unreadable amount blocks the run and the PDF until it is fixed, without clearing results', () => {
    const start = initialQuoteSession();
    const errored = reduceQuoteSession(start, {
      type: 'patch_staff_header',
      header: { fieldErrors: { dinnerAllowance: 'Enter an amount in rand, like 450 or 1,250.50' } },
    });
    expect(errored.inputRevision).toBe(start.inputRevision);
    expect(staffHeaderFieldProblem(errored.staffHeader)).toBe(
      'Dinner allowance: Enter an amount in rand, like 450 or 1,250.50',
    );
    expect(canCreatePdf(errored)).toBe(false);
    const step = { kind: 'quote_stay', shareKey: 'stay-1' } as never;
    expect(quoteRunBlockReason(errored, step)).toMatch(/^Fix the amounts before running this search\./);
    const fixed = reduceQuoteSession(errored, { type: 'patch_staff_header', header: { fieldErrors: {} } });
    expect(staffHeaderFieldProblem(fixed.staffHeader)).toBeNull();
    expect(quoteRunBlockReason(fixed, step)).toBeNull();
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

  it('staff edits clear the edited stay results and PDF without minting a revision', () => {
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
    expect(s.inputRevision).toBe(1);
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
    // Staff edit the stay while its run is in flight, so the run's result is stale.
    s = reduceQuoteSession(s, { type: 'step_running', stepId: s.steps[0]!.id });
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
    expect(stepFor(current, '2026-11-12:2026-11-14').retryGuidance).toBe('live bind unavailable');
    expect(current.errorMessage).toBeNull();
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
  });

  it('keeps only the child ages a work item can save: whole years 0 to 17, at most 9', () => {
    expect(parseChildrenAges('5, 18, 3.5, 2, -1')).toEqual([5, 2]);
    expect(parseChildrenAges('1,2,3,4,5,6,7,8,9,10')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(formatQuoteStepInputs({ organisation: 'Treasury', quoteRequestKey: '2026-12-01:2026-12-03' })).toMatch(
      /Company Treasury/,
    );
  });

  it('labels rows by room type and count, not by ordinal', () => {
    const line = formatQuoteStepInputs({
      quoteRequestKey: '2026-11-02:2026-11-06',
      groups: [
        { quantity: 15, roomPreference: 'STQN', adults: 1 },
        { quantity: 15, roomPreference: 'STWN', adults: 2 },
      ],
    });
    expect(line).toBe('Dates 2026-11-02 → 2026-11-06 · Standard Queen ×15, 1 adult · Standard Twin ×15, 2 adults');
    expect(line).not.toMatch(/Stay \d/);
    expect(formatQuoteStepInputs({ groups: [{ roomPreference: ' ' }] })).toBe('Room type needed ×1, adults not set');
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

function declinedQuoteSession() {
  const session = withStaffSource(analysisReady());
  return reduceQuoteSession(session, {
    type: 'results_unavailable',
    stepId: stepFor(session, STAY_A).id,
    reason: 'No supported rate was returned',
    declineReplyHtml: '<p>Unfortunately, we are fully booked.</p>',
    selectionEpoch: session.binding!.selectionEpoch,
    inputRevision: session.inputRevision,
  });
}

const quoteDeclineInputEdits: Array<[string, QuoteSessionAction]> = [
  ['company', { type: 'patch_staff_header', header: { company: 'Another company' } }],
  ['agency', { type: 'patch_staff_header', header: { agency: 'Another agency' } }],
  ['rate strategy', { type: 'patch_staff_header', header: { salesStrategy: 'Government' } }],
  ['dates', { type: 'patch_group', groupId: 'g1', patch: { arrivalDate: '2026-11-13' } }],
  ['room count', { type: 'patch_group', groupId: 'g1', patch: { quantity: 2 } }],
  ['board', { type: 'patch_group', groupId: 'g1', patch: { board: 'room_only' } }],
];

describe('generated quote-decline freshness', () => {
  it('does not create a whole-request decline after another stay is added during a search', () => {
    const session = withStaffSource(analysisReady());
    const firstStayStep = stepFor(session, STAY_A);
    const running = reduceQuoteSession(session, { type: 'step_running', stepId: firstStayStep.id });
    const multiStay = reduceQuoteSession(running, { type: 'add_stay', token: 'second' });
    const refused = reduceQuoteSession(multiStay, {
      type: 'results_unavailable',
      stepId: firstStayStep.id,
      reason: 'No supported rate was returned',
      declineReplyHtml: '<p>decline</p>',
      selectionEpoch: session.binding!.selectionEpoch,
      inputRevision: session.inputRevision,
    });

    expect(isMultiStay(multiStay)).toBe(true);
    expect(refused.reviewedReplyHtml).toBe('');
    expect(refused.reviewedReplySource).toBeUndefined();
    expect(quoteDeclineReplyOnly(refused)).toBe(false);
    expect(refused.steps.find((step) => step.id === firstStayStep.id)?.status).toBe('failed');
  });

  it('keeps a reply staff wrote during the search when the search is refused', () => {
    const session = withStaffSource(analysisReady());
    const step = stepFor(session, STAY_A);
    const running = reduceQuoteSession(session, { type: 'step_running', stepId: step.id });
    const edited = reduceQuoteSession(running, { type: 'set_reviewed_reply', html: '<p>Staff text</p>', staffEdited: true });
    const refused = reduceQuoteSession(edited, {
      type: 'results_unavailable',
      stepId: step.id,
      reason: 'No supported rate was returned',
      declineReplyHtml: '<p>decline</p>',
      selectionEpoch: session.binding!.selectionEpoch,
      inputRevision: session.inputRevision,
    });

    expect(refused.reviewedReplyHtml).toBe('<p>Staff text</p>');
    expect(refused.reviewedReplySource).toBeUndefined();
  });

  it('keeps the decline marker while staff clear the suggestion and type their own', () => {
    const declined = declinedQuoteSession();
    const cleared = reduceQuoteSession(declined, { type: 'set_reviewed_reply', html: '', staffEdited: true });
    expect(cleared.reviewedReplySource).toBe('quote_decline');
    expect(quoteDeclineReplyOnly(cleared)).toBe(false);

    const typed = reduceQuoteSession(cleared, { type: 'set_reviewed_reply', html: '<p>Own words</p>', staffEdited: true });
    expect(quoteDeclineReplyOnly(typed)).toBe(true);
  });

  it.each(quoteDeclineInputEdits)('clears the decline when %s changes', (_input, action) => {
    const declined = declinedQuoteSession();
    expect(quoteDeclineReplyOnly(declined)).toBe(true);

    const edited = reduceQuoteSession(declined, action);

    expect(edited.reviewedReplyHtml).toBe('');
    expect(edited.reviewedReplySource).toBeUndefined();
    expect(quoteDeclineReplyOnly(edited)).toBe(false);
  });
});

function stepFor(session: { steps: QuoteToolStep[] }, stayKey: string): QuoteToolStep {
  return session.steps.find((step) => step.shareKey === stayKey)!;
}

describe('mixed complete and incomplete quote dates', () => {
  it('allows the complete date option to run without sending the incomplete sibling to HMS', () => {
    const analysis = {
      ...twoDateAnalysis(),
      groups: [
        twoDateAnalysis().groups[0]!,
        { ...twoDateAnalysis().groups[1]!, arrivalDate: undefined, departureDate: undefined },
      ],
      missingQuoteReplyFields: ['Arrival date for stay 2', 'Departure date for stay 2'],
    };
    const session = analysisReady(analysis);

    expect(quoteRunBlockReason(session, stepFor(session, STAY_A))).toBeNull();
    expect(quoteRunBlockReason(session, stepFor(session, 'unknown:unknown'))).toMatch(/missing arrival and departure/i);
    expect(missingQuoteDetailsReplyOnly(session)).toBe(false);
  });

  it('derives missing reply fields from deterministic groups when the Luna read falls back', () => {
    const analysis = twoDateAnalysis();
    const fallback = analysisReady({
      ...analysis,
      groups: [
        {
          ...analysis.groups[0]!,
          arrivalDate: undefined,
          quantity: undefined,
          adults: undefined,
          fields: { arrivalDate: 'missing', adults: 'missing' },
        },
        {
          ...analysis.groups[1]!,
          departureDate: undefined,
          quantity: 2,
          adults: undefined,
          fields: {
            ...analysis.groups[1]!.fields,
            departureDate: 'missing',
            quantity: 'extracted',
            adults: 'missing',
          },
        },
      ],
      source: 'regex_fallback',
      fallbackReason: 'error',
      aiUnavailable: true,
      luna: null,
    });

    expect(fallback.analysis?.missingQuoteReplyFields).toEqual([
      'Arrival date for stay 1',
      'Number of rooms and occupancy per room for stay 1',
      'Departure date for stay 2',
      'Number of guests per room for stay 2',
    ]);
    expect(missingQuoteDetailsReplyOnly(fallback)).toBe(true);
  });

  it('derives only the quote details that remain missing from the current groups', () => {
    const group = {
      ...quoteAnalysis.groups[0]!,
      arrivalDate: '2026-11-12',
      departureDate: undefined,
    };

    expect(missingQuoteReplyFieldsForGroups([group])).toEqual(['Departure date for stay 1']);
  });

  it('clears only Nava’s generated missing-date reply after the stay becomes complete', () => {
    const incompleteGroup = {
      ...quoteAnalysis.groups[0]!,
      arrivalDate: undefined,
      fields: { ...quoteAnalysis.groups[0]!.fields, arrivalDate: 'missing' as const },
    };
    const session = analysisReady({
      ...quoteAnalysis,
      groups: [incompleteGroup],
      missingQuoteReplyFields: ['Arrival date for stay 1'],
    });
    const automatic = reduceQuoteSession(session, {
      type: 'set_reviewed_reply',
      html: '<p>Please confirm the arrival date.</p>',
      source: 'missing_quote_details',
    });
    const completed = reduceQuoteSession(automatic, {
      type: 'patch_group',
      groupId: incompleteGroup.id,
      patch: { arrivalDate: '2026-11-12' },
    });

    expect(completed.reviewedReplyHtml).toBe('');
    expect(completed.reviewedReplySource).toBeUndefined();

    const manual = reduceQuoteSession(automatic, {
      type: 'set_reviewed_reply',
      html: '<p>Staff wrote this reply.</p>',
      staffEdited: true,
    });
    const completedManual = reduceQuoteSession(manual, {
      type: 'patch_group',
      groupId: incompleteGroup.id,
      patch: { arrivalDate: '2026-11-12' },
    });
    expect(completedManual.reviewedReplyHtml).toBe('<p>Staff wrote this reply.</p>');
  });
});

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
          text: 'Could not read: rooming-list.pdf',
          filename: 'rooming-list.pdf',
          sourceLabel: 'Attachment',
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

  it('prefills a blank reply when its single-stay PDF is ready, but keeps staff-edited text', () => {
    const preparedReply = '<p>Good day David,</p>';
    const quoteReady = () => {
      let s = analysisReady();
      s = reduceQuoteSession(s, {
        type: 'results_ready',
        offers: [authorisedOffer],
        selectionEpoch: 1,
        inputRevision: 1,
        provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
      });
      s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
      return withStaffSource(s);
    };
    const preparePdf = (s: QuoteSession) => reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: { fileName: 'Quote-authorised.pdf', bytesBase64: 'JVBERi0xLjQK' },
      selectionEpoch: 1,
      inputRevision: 1,
      selectedOfferIds: ['o1'],
      reviewedReplyHtml: preparedReply,
    });

    const prepared = preparePdf(quoteReady());
    expect(prepared.reviewedReplyHtml).toBe(preparedReply);

    const typed = reduceQuoteSession(quoteReady(), {
      type: 'set_reviewed_reply',
      html: '<p>Staff typed this first.</p>',
      staffEdited: true,
    });
    expect(preparePdf(typed).reviewedReplyHtml).toBe('<p>Staff typed this first.</p>');
  });

  describe('generated quotation reply freshness', () => {
    const quoteWithDinner = (
      session: QuoteSession,
      revisionRef: string,
      dinnerAmountMinor: number,
      dinnerTotalMinor: number,
      totalMinor: number,
    ) => {
      const action = staffQuoteFor(STAY_A, revisionRef, totalMinor, session.inputRevision);
      if (action.type !== 'staff_quote_ready') throw new Error('expected a staff quote run');
      return reduceQuoteSession(session, {
        ...action,
        staffQuote: {
          ...action.staffQuote,
          dinnerAddOn: {
            label: 'Dinner allowance',
            amountMinor: dinnerAmountMinor,
            unit: 'per_person_per_night',
            totalMinor: dinnerTotalMinor,
          },
        },
      });
    };

    const preparePdf = (session: QuoteSession) => {
      const quote = session.staffQuote!;
      return reduceQuoteSession(session, {
        type: 'pdf_ready',
        pdf: quotePdf(quote.revisionRef, quote.totalMinor),
        selectionEpoch: session.binding!.selectionEpoch,
        inputRevision: session.inputRevision,
        selectedOfferIds: session.selectedOfferIds,
        reviewedReplyHtml: quoteWrapperHtml('', 'R Opperman', {
          ...(quote.dinnerAddOn ? { dinnerAddOn: quote.dinnerAddOn } : {}),
          totalMinor: quote.totalMinor,
        }),
      });
    };

    it('keeps the generated cover reply unpriced after a new quote run', () => {
      let session = withStaffSource(analysisReady());
      session = quoteWithDinner(session, 'rev-dinner-200', 20_000, 40_000, 160_000);
      session = preparePdf(session);
      const originalReply = session.reviewedReplyHtml;
      expect(originalReply).toContain('Please see attached quotation.');
      expect(originalReply).not.toMatch(/R\d+\.\d{2}/);

      session = reduceQuoteSession(session, {
        type: 'patch_staff_stay_extras',
        stayKey: STAY_A,
        extras: {
          dinnerEnabled: true,
          dinnerAllowanceMinor: 25_000,
          dinnerAllowanceUnit: 'per_person_per_night',
        },
      });
      session = quoteWithDinner(session, 'rev-dinner-250', 25_000, 50_000, 170_000);
      session = preparePdf(session);

      expect(session.reviewedReplyHtml).toBe(originalReply);
      expect(session.reviewedReplyHtml).not.toMatch(/R\d+\.\d{2}/);
      expect(session.reviewedReplySource).toBe('quote_generated');
    });

    it('keeps generated reply provenance through a combined PDF so a later single-stay quote can refresh it', () => {
      let session = withStaffSource(analysisReady());
      session = quoteWithDinner(session, 'rev-dinner-200', 20_000, 40_000, 160_000);
      session = preparePdf(session);
      const originalReply = session.reviewedReplyHtml;

      session = reduceQuoteSession(session, { type: 'add_stay', token: 'second' });
      const secondGroup = session.groups.at(-1)!;
      session = reduceQuoteSession(session, {
        type: 'patch_group',
        groupId: secondGroup.id,
        patch: { arrivalDate: '2026-12-01', departureDate: '2026-12-03' },
      });
      const secondStayKey = stepFor(session, STAY_B).shareKey!;
      session = reduceQuoteSession(session, staffQuoteFor(secondStayKey, 'rev-second-stay', 180_000, session.inputRevision));
      session = reduceQuoteSession(session, {
        type: 'pdf_ready',
        pdf: quotePdf('combined-stays', 340_000),
        selectionEpoch: session.binding!.selectionEpoch,
        inputRevision: session.inputRevision,
        selectedOfferIds: [
          session.staffQuotes[STAY_A]!.revisionRef,
          session.staffQuotes[secondStayKey]!.revisionRef,
        ],
      });

      expect(session.reviewedReplySource).toBe('quote_generated');
      session = reduceQuoteSession(session, { type: 'remove_stay', stayId: stayIdOf(secondGroup) });
      session = reduceQuoteSession(session, {
        type: 'patch_staff_stay_extras',
        stayKey: STAY_A,
        extras: {
          dinnerEnabled: true,
          dinnerAllowanceMinor: 25_000,
          dinnerAllowanceUnit: 'per_person_per_night',
        },
      });
      session = quoteWithDinner(session, 'rev-dinner-250-after-multi', 25_000, 50_000, 170_000);
      session = preparePdf(session);

      expect(session.reviewedReplyHtml).toBe(originalReply);
      expect(session.reviewedReplyHtml).not.toMatch(/R\d+\.\d{2}/);
    });

    it('keeps staff edits to a generated quotation reply across another quote run', () => {
      let session = withStaffSource(analysisReady());
      session = quoteWithDinner(session, 'rev-dinner-200', 20_000, 40_000, 160_000);
      session = preparePdf(session);
      session = reduceQuoteSession(session, {
        type: 'set_reviewed_reply',
        html: '<p>Staff-edited reply</p>',
        staffEdited: true,
      });
      expect(session.reviewedReplySource).toBeUndefined();

      session = reduceQuoteSession(session, {
        type: 'patch_staff_stay_extras',
        stayKey: STAY_A,
        extras: {
          dinnerEnabled: true,
          dinnerAllowanceMinor: 25_000,
          dinnerAllowanceUnit: 'per_person_per_night',
        },
      });
      session = quoteWithDinner(session, 'rev-dinner-250', 25_000, 50_000, 170_000);
      session = preparePdf(session);

      expect(session.reviewedReplyHtml.includes('Staff-edited reply')).toBe(true);
      expect(session.reviewedReplyHtml.includes('R250.00')).toBe(false);
      expect(session.reviewedReplySource).toBeUndefined();
    });

    it('does not restore a reply staff cleared while its repriced PDF was being prepared', () => {
      let session = withStaffSource(analysisReady());
      session = quoteWithDinner(session, 'rev-dinner-200', 20_000, 40_000, 160_000);
      session = preparePdf(session);
      session = reduceQuoteSession(session, {
        type: 'patch_staff_stay_extras',
        stayKey: STAY_A,
        extras: {
          dinnerEnabled: true,
          dinnerAllowanceMinor: 25_000,
          dinnerAllowanceUnit: 'per_person_per_night',
        },
      });
      session = quoteWithDinner(session, 'rev-dinner-250-pending', 25_000, 50_000, 170_000);
      const quote = session.staffQuote!;
      const pendingPdf: QuoteSessionAction = {
        type: 'pdf_ready',
        pdf: quotePdf(quote.revisionRef, quote.totalMinor),
        selectionEpoch: session.binding!.selectionEpoch,
        inputRevision: session.inputRevision,
        selectedOfferIds: session.selectedOfferIds,
        reviewedReplyHtml: quoteWrapperHtml('', 'R Opperman', {
          ...(quote.dinnerAddOn ? { dinnerAddOn: quote.dinnerAddOn } : {}),
          totalMinor: quote.totalMinor,
        }),
      };

      session = reduceQuoteSession(session, { type: 'set_reviewed_reply', html: '', staffEdited: true });
      session = reduceQuoteSession(session, pendingPdf);

      expect(session.reviewedReplyHtml).toBe('');
      expect(session.reviewedReplySource).toBeUndefined();
      expect(session.reviewedReplyEdited).toBe(true);
    });
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
      'Could not read: rooming-list.pdf',
      'Could not read: rooming-list.pdf',
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
    expect(s.inputRevision).toBe(1);
    const analysis = s.analysis;
    s = reduceQuoteSession(s, {
      type: 'analysis_ready',
      analysis: {
        ...quoteAnalysis,
        groups: [{ ...quoteAnalysis.groups[0]!, adults: 1 }],
      },
    });
    expect(s.groups[0]?.adults).toBe(4);
    expect(s.inputRevision).toBe(1);
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

  it('keeps option A when option B runs, and B is not held back by a PDF for A', () => {
    let s = twoDateSession();
    expect(s.steps.map((step) => step.status)).toEqual(['ready', 'ready']);
    expect(canRunQuoteStep(stepFor(s, STAY_B), s.steps, stepFor(s, STAY_A).id)).toBe(false);
    expect(pickNextRunnableStep(s.steps, null)?.shareKey).toBe(STAY_A);

    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    expect(stepFor(s, STAY_A).status).toBe('succeeded');
    // Both options end in one combined quote, so no option waits for a PDF of its own.
    expect(stepFor(s, STAY_B).status).toBe('ready');
    expect(quoteRunBlockReason(s, stepFor(s, STAY_B))).toBeNull();

    s = reduceQuoteSession(s, staffQuoteFor(STAY_B, 'rev-b', 920000, s.inputRevision));
    expect(stepFor(s, STAY_A).status).toBe('succeeded');
    expect(stepFor(s, STAY_B).status).toBe('succeeded');
    expect(s.staffQuotes[STAY_A]?.revisionRef).toBe('rev-a');
    expect(s.stayPdfs).toEqual({});
    expect(s.offers.map((offer) => offer.id).sort()).toEqual(['rev-a', 'rev-b']);
    expect(s.selectedStayKey).toBe(STAY_B);
    expect(s.pdf).toBeNull();
  });

  it('selecting a date option keeps every result and the one combined PDF', () => {
    let s = twoDateSession();
    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
    s = reduceQuoteSession(s, staffQuoteFor(STAY_B, 'rev-b', 920000, s.inputRevision));
    s = reduceQuoteSession(s, {
      type: 'pdf_ready',
      pdf: quotePdf('quotes:abc', 1770000),
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      // A combined PDF names the runs of every stay it was built from.
      selectedOfferIds: ['rev-a', 'rev-b'],
    });
    expect(s.stayPdfs).toEqual({});
    expect(canCreatePdf(s)).toBe(true);

    const toA = reduceQuoteSession(s, { type: 'select_stay_key', stayKey: STAY_A });
    expect(Object.keys(toA.staffQuotes).sort()).toEqual([STAY_A, STAY_B]);
    expect(toA.offers.map((offer) => offer.id).sort()).toEqual(['rev-a', 'rev-b']);
    expect(toA.staffQuote?.revisionRef).toBe('rev-a');
    expect(toA.selectedOfferIds).toEqual(['rev-a']);
    // The combined PDF covers every stay, so it stays on screen whichever option is selected.
    expect(toA.pdf?.revisionId).toBe('quotes:abc');
    expect(reduceQuoteSession(toA, { type: 'select_stay_key', stayKey: STAY_B }).pdf?.revisionId).toBe('quotes:abc');
    expect(canCreateNativeDraft(toA)).toBe(true);

    // A re-quote of one stay makes the combined PDF stale, so it is cleared.
    const requoted = reduceQuoteSession(toA, staffQuoteFor(STAY_A, 'rev-a2', 850000, toA.inputRevision));
    expect(requoted.pdf).toBeNull();
    expect(Object.keys(requoted.staffQuotes).sort()).toEqual([STAY_A, STAY_B]);

    // Re-reading the same email must not reopen option A.
    const reread = reduceQuoteSession(toA, { type: 'analysis_ready', analysis: twoDateAnalysis() });
    expect(stepFor(reread, STAY_A).status).toBe('succeeded');
    expect(Object.keys(reread.staffQuotes).sort()).toEqual([STAY_A, STAY_B]);
  });

  it('a failed later option keeps the earlier option result', () => {
    let s = twoDateSession();
    s = reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-a', 850000, s.inputRevision));
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
    expect(stepFor(s, STAY_B).retryGuidance).toBe('HMS did not answer. Run option B again.');
    expect(s.errorMessage).toBeNull();
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
    s = reduceQuoteSession(s, {
      type: 'set_reviewed_reply',
      html: '<p>Full staff-edited reply</p>',
      staffEdited: true,
    });
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

  it('starts with no booking drafts and clears them downstream', () => {
    expect(initialQuoteSession().bookingDrafts).toEqual({});
    let s = analysisReady();
    s = {
      ...s,
      bookingDrafts: {
        [STAY_A]: {
          draft: { rooms: [], rateCheck: [], missing: [], flags: [] },
          options: { track: [], sourceOfBusiness: [], guaranteeType: [], roomType: [] },
          messageId: 'mail-1',
          selectionEpoch: 1,
          inputRevision: 1,
          revisionRef: 'rev-1',
        },
      },
    };
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    expect(s.bookingDrafts).toEqual({});
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
      options: {
        track: ['BAR'],
        sourceOfBusiness: ['Travel Agent'],
        guaranteeType: ['Guaranteed By Agent'],
        roomType: ['STQN'],
      },
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
    expect(stale.bookingDrafts).toEqual({});
    const ready = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload,
      sourceHash: STAFF_HASH,
    });
    expect(ready.bookingDrafts[STAY_A]?.draft.rooms).toHaveLength(1);
    const otherRevision = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: { ...payload, revisionRef: 'rev-other' },
      sourceHash: STAFF_HASH,
    });
    expect(otherRevision.bookingDrafts).toEqual({});
    const patched = reduceQuoteSession(ready, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    expect(patched.bookingDrafts).toEqual({});
  });

  it('keys an unquoted booking_draft_ready by stay when there is no staff quote', () => {
    const payload = {
      draft: {
        rooms: [
          {
            groupId: 'g1',
            roomIndex: 1,
            request: { arrival: '2026-11-12', departure: '2026-11-14', roomType: 'STQN' },
            schemaErrors: [] as string[],
          },
        ],
        rateCheck: [],
        missing: [],
        flags: [] as string[],
      },
      options: {
        track: [] as string[],
        sourceOfBusiness: [] as string[],
        guaranteeType: [] as string[],
        roomType: [] as string[],
      },
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: 1,
      revisionRef: 'unquoted',
    };
    let s = analysisReady();
    s = withStaffSource(s);
    expect(s.staffQuotes).toEqual({});
    const ready = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload,
      sourceHash: STAFF_HASH,
    });
    expect(ready.bookingDrafts[STAY_A]?.revisionRef).toBe('unquoted');
    expect(ready.bookingDrafts[STAY_A]?.draft.rooms).toHaveLength(1);
    const otherMail = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: { ...payload, messageId: 'other' },
      sourceHash: STAFF_HASH,
    });
    expect(otherMail.bookingDrafts).toEqual({});
    const pricedStale = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: { ...payload, revisionRef: 'rev-stale' },
      sourceHash: STAFF_HASH,
    });
    expect(pricedStale.bookingDrafts).toEqual({});
    const withQuote = reduceQuoteSession(s, {
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
        quoteRequestKey: STAY_A,
        approvedHeader: emptyHeader(),
      },
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
    });
    const besideQuote = reduceQuoteSession(withQuote, {
      type: 'booking_draft_ready',
      payload,
      sourceHash: STAFF_HASH,
    });
    expect(besideQuote.bookingDrafts).toEqual({});
  });

  it('drops an unquoted draft on multi-stay mail', () => {
    const s = twoDateSession();
    const ready = reduceQuoteSession(s, {
      type: 'booking_draft_ready',
      payload: {
        draft: {
          rooms: [
            {
              groupId: 'g1',
              roomIndex: 1,
              request: { arrival: '2026-11-12', departure: '2026-11-14', roomType: 'STQN' },
              schemaErrors: [] as string[],
            },
          ],
          rateCheck: [],
          missing: [],
          flags: [] as string[],
        },
        options: { track: [], sourceOfBusiness: [], guaranteeType: [], roomType: [] },
        messageId: 'mail-1',
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        revisionRef: 'unquoted',
      },
      sourceHash: STAFF_HASH,
    });
    expect(ready.bookingDrafts).toEqual({});
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

  it('does not treat email rate claims as installed staff dinner add-on prices', () => {
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
    expect(allowance.staffHeader.dinnerAllowanceMinor).toBeUndefined();
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

  it('does not infer a dinner charging basis from an amount without staff or hotel configuration', () => {
    const extras = defaultStaffStayExtras({
      ...emptyStaffQuoteHeader(),
      dinnerAllowanceMinor: 45_000,
    });
    expect(extras.dinnerAllowanceUnit).toBeUndefined();
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
      extrasReviewItems: [
        'Shuttle requested — add a price or answer in the reply',
        'Other charge R300.00 has no label — add a label or answer in the reply',
      ],
    });
    expect(s.reviewItems.some((item) => /Shuttle requested/i.test(item.text))).toBe(true);
    expect(s.reviewItems.some((item) => /Other charge R300\.00 has no label/.test(item.text))).toBe(true);
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

describe('staff dinner B&B fallback', () => {
  const dinnerSession = () =>
    ({
      ...initialQuoteSession(),
      groups: [
        {
          id: 'g1',
          arrivalDate: '2026-11-12',
          departureDate: '2026-11-14',
          quantity: 1,
          adults: 2,
          childrenAges: [],
          board: 'dinner_bb',
          specialRequests: [],
          fields: {},
        },
      ],
    }) as unknown as ReturnType<typeof initialQuoteSession>;

  it('moves dinner groups to B&B and requires a per-stay allowance without inventing a price', () => {
    const before = dinnerSession();
    const after = reduceQuoteSession(before, {
      type: 'staff_dinner_bb_fallback',
      groupIds: ['g1'],
    });
    const stayKey = '2026-11-12:2026-11-14';
    const extras = after.staffHeader.stayExtrasByKey?.[stayKey];
    expect(after.groups[0]?.board).toBe('bb');
    expect(extras).toMatchObject({ dinnerEnabled: true, dinnerAllowanceRequired: true, dinnerAllowanceGroupIds: ['g1'] });
    expect(extras?.dinnerAllowanceMinor).toBeUndefined();
    expect(after.inputRevision).toBe(before.inputRevision);
    expect(dinnerAllowanceStillRequired(after.staffHeader)).toBe(true);
    const priceEntered = {
      ...after.staffHeader,
      stayExtrasByKey: {
        ...after.staffHeader.stayExtrasByKey,
        [stayKey]: {
          ...staffStayExtrasFor(after.staffHeader, stayKey),
          dinnerAllowanceMinor: 45_000,
          dinnerAllowanceUnit: 'per_person_per_night' as const,
        },
      },
    };
    expect(dinnerAllowanceStillRequired(priceEntered)).toBe(true);
    expect(dinnerAddOnInputProblem(priceEntered)).toBe(
      'Run Get rates again to apply the dinner price before preparing documents.',
    );
    expect(reduceQuoteSession(before, { type: 'staff_dinner_bb_fallback', groupIds: [] })).toBe(
      before,
    );
  });

  it('clears the required allowance after a priced B&B quote with no fallback group ids', () => {
    const analysis = {
      ...quoteAnalysis,
      groups: quoteAnalysis.groups.map((group) => ({ ...group, board: 'dinner_bb' as const })),
    };
    let before = withStaffSource(analysisReady(analysis));
    // The B&B-plus-dinner fallback is the BAR path; a Dinner B&B ask now defaults to Government.
    before = reduceQuoteSession(before, { type: 'patch_staff_header', header: { salesStrategy: 'BAR' } });
    before = reduceQuoteSession(before, { type: 'staff_dinner_bb_fallback', groupIds: ['g1'] });
    before = reduceQuoteSession(before, {
      type: 'patch_staff_stay_extras',
      stayKey: STAY_A,
      extras: { dinnerAllowanceMinor: 45_000, dinnerAllowanceUnit: 'per_person_per_night' },
    });

    const action = staffQuoteFor(STAY_A, 'rev-dinner-bb', 850_000, before.inputRevision);
    if (action.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    const after = reduceQuoteSession(before, {
      ...action,
      staffQuote: {
        ...action.staffQuote,
        dinnerAddOn: {
          label: 'Dinner add-on',
          amountMinor: 45_000,
          unit: 'per_person_per_night',
          totalMinor: 90_000,
        },
      },
    });

    expect(after.staffHeader.stayExtrasByKey?.[STAY_A]).toMatchObject({
      dinnerEnabled: true,
      dinnerAllowanceRequired: false,
      dinnerAllowanceMinor: 45_000,
      dinnerAllowanceUnit: 'per_person_per_night',
      dinnerAllowanceGroupIds: ['g1'],
    });
    expect(dinnerAllowanceStillRequired(after)).toBe(false);
    expect(canCreatePdf(after)).toBe(true);
    expect(workbookRequestFor(after).status).toBe('ok');
  });

  it('blocks documents when a normal B&B result requires a dinner unit without fallback group ids', () => {
    let before = withStaffSource(analysisReady());
    before = reduceQuoteSession(before, {
      type: 'patch_staff_stay_extras',
      stayKey: STAY_A,
      extras: { dinnerEnabled: true, dinnerAllowanceMinor: 45_000 },
    });
    const action = staffQuoteFor(STAY_A, 'rev-dinner-unit', 850_000, before.inputRevision);
    if (action.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    const after = reduceQuoteSession(before, {
      ...action,
      staffQuote: { ...action.staffQuote, dinnerAddOnRequired: true },
    });

    expect(after.staffQuote).toMatchObject({ dinnerAddOnRequired: true });
    expect(after.staffQuote?.dinnerFallbackGroupIds).toBeUndefined();
    expect(after.staffHeader.stayExtrasByKey?.[STAY_A]).toMatchObject({
      dinnerEnabled: true,
      dinnerAllowanceRequired: true,
      dinnerAllowanceMinor: 45_000,
    });
    expect(pdfBlockReason(after)).toBe('Choose how the dinner price is charged.');
    expect(canCreatePdf(after)).toBe(false);
    expect(workbookRequestFor(after)).toEqual({
      status: 'unavailable',
      reason: 'Choose how the dinner price is charged.',
    });
  });

  it('treats a quote run as current only while its selection epoch and input revision are still the session', () => {
    const session = {
      ...initialQuoteSession(),
      inputRevision: 3,
      binding: { selectionEpoch: 2 },
    } as unknown as ReturnType<typeof initialQuoteSession>;
    expect(quoteRunIsCurrent(session, { selectionEpoch: 2, inputRevision: 3 })).toBe(true);
    expect(quoteRunIsCurrent(session, { selectionEpoch: 2, inputRevision: 2 })).toBe(false);
    expect(quoteRunIsCurrent(session, { selectionEpoch: 1, inputRevision: 3 })).toBe(false);
  });

  it('clears a stale running step without clearing a newer step run', () => {
    const session = analysisReady(twoDateAnalysis());
    const stepA = stepFor(session, STAY_A);
    const staleAction = {
      type: 'step_stale' as const,
      stepId: stepA.id,
      selectionEpoch: session.binding?.selectionEpoch ?? 0,
      inputRevision: session.inputRevision,
    };
    const runningA = reduceQuoteSession(session, { type: 'step_running', stepId: stepA.id });
    const staleA = reduceQuoteSession(runningA, staleAction);

    expect(staleA.runningStepId).toBeNull();
    expect(stepFor(staleA, STAY_A).status).toBe('ready');

    const runningB = reduceQuoteSession(staleA, {
      type: 'step_running',
      stepId: stepFor(staleA, STAY_B).id,
    });
    expect(reduceQuoteSession(runningB, staleAction)).toBe(runningB);
  });

  it('treats the dinner fallback as stale once a row was edited after its run, though the input revision held', () => {
    const before = dinnerSession();
    const run = { selectionEpoch: before.binding?.selectionEpoch ?? 0, inputRevision: before.inputRevision, stayRevision: before.stayRevision };
    expect(quoteRunIsCurrent(before, run)).toBe(true);
    const groupId = before.groups[0]!.id;
    const edited = reduceQuoteSession(before, { type: 'patch_group', groupId, patch: { board: 'room_only' } });
    expect(edited.inputRevision).toBe(before.inputRevision);
    expect(quoteRunIsCurrent(edited, run)).toBe(false);
  });

  it('records which groups fell back, so the allowance can be charged to those guests only', () => {
    const after = reduceQuoteSession(dinnerSession(), {
      type: 'staff_dinner_bb_fallback',
      groupIds: ['g1'],
    });
    expect(after.staffHeader.stayExtrasByKey?.['2026-11-12:2026-11-14']?.dinnerAllowanceGroupIds).toEqual(['g1']);
  });

  it('a search result for one stay keeps the extras staff entered on another stay meanwhile', () => {
    let before = withStaffSource(analysisReady());
    const stale = { ...defaultStaffStayExtras(before.staffHeader), dinnerEnabled: false };
    const fresh = { ...defaultStaffStayExtras(before.staffHeader), dinnerEnabled: true, dinnerAllowanceMinor: 30_000, dinnerAllowanceUnit: 'per_person_per_night' as const };
    const approvedA = { ...defaultStaffStayExtras(before.staffHeader), dinnerEnabled: false };
    before = {
      ...before,
      staffHeader: { ...before.staffHeader, salesStrategy: 'BAR', stayExtrasByKey: { [STAY_A]: approvedA, 'other-stay': fresh } },
    };
    const action = staffQuoteFor(STAY_A, 'rev-two-stays', 85_000, before.inputRevision);
    if (action.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    const after = reduceQuoteSession(before, {
      ...action,
      approvedHeader: { ...before.staffHeader, stayExtrasByKey: { [STAY_A]: approvedA, 'other-stay': stale } },
    } as typeof action);
    expect(after.staffHeader.stayExtrasByKey?.['other-stay']).toEqual(fresh);
    expect(after.staffHeader.stayExtrasByKey?.[STAY_A]).toEqual(approvedA);
  });

  it('keeps a staff-approved whole-stay dinner charge when the server retried only some rooms as B&B', () => {
    let before = withStaffSource(analysisReady());
    before = {
      ...before,
      staffHeader: {
        ...before.staffHeader,
        salesStrategy: 'BAR',
        stayExtrasByKey: {
          ...before.staffHeader.stayExtrasByKey,
          [STAY_A]: {
            ...defaultStaffStayExtras(before.staffHeader),
            dinnerEnabled: true,
            dinnerAllowanceMinor: 35_000,
            dinnerAllowanceUnit: 'per_person_per_night',
          },
        },
      },
    };
    const action = staffQuoteFor(STAY_A, 'rev-mixed', 85_000, before.inputRevision);
    if (action.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    const after = reduceQuoteSession(before, {
      ...action,
      staffQuote: {
        ...action.staffQuote,
        dinnerFallbackGroupIds: ['g1'],
        dinnerAddOn: { label: 'Dinner add-on', amountMinor: 35_000, unit: 'per_person_per_night', totalMinor: 140_000 },
      },
    });
    expect(after.staffHeader.stayExtrasByKey?.[STAY_A]?.dinnerAllowanceGroupIds).toBeUndefined();
  });

  it.each([
    { name: 'short', qualifier: 'Set menu' },
    { name: '120-character', qualifier: 'x'.repeat(120) },
  ])('keeps a $name dinner qualifier separate from its display label', ({ qualifier }) => {
    let before = withStaffSource(analysisReady());
    before = {
      ...before,
      staffHeader: {
        ...before.staffHeader,
        salesStrategy: 'BAR',
        stayExtrasByKey: {
          ...before.staffHeader.stayExtrasByKey,
          [STAY_A]: {
            ...defaultStaffStayExtras(before.staffHeader),
            dinnerEnabled: true,
            dinnerAllowanceMinor: 35_000,
            dinnerAllowanceUnit: 'per_person_per_night',
            dinnerAllowanceLabel: qualifier,
          },
        },
      },
    };
    const action = staffQuoteFor(STAY_A, 'rev-dinner', 85_000, before.inputRevision);
    if (action.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    const displayLabel = `Dinner add-on (${qualifier})`;
    const after = reduceQuoteSession(before, {
      ...action,
      staffQuote: {
        ...action.staffQuote,
        dinnerFallbackGroupIds: ['g1'],
        dinnerAddOn: {
          label: displayLabel,
          amountMinor: 35_000,
          unit: 'per_person_per_night',
          totalMinor: 140_000,
        },
      },
    });

    expect(after.staffQuote?.dinnerAddOn?.label).toBe(displayLabel);
    const nextSearch = approvedExecuteHeader(staffHeaderForStay(after.staffHeader, STAY_A), ['g1']);
    expect(nextSearch.dinnerAllowanceLabel).toBe(qualifier);
  });
});

describe('type chosen by staff after stay edits', () => {
  it('applies Booking from the re-read and keeps the edited stay', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: { ...quoteAnalysis, luna: lunaQuote() } });
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    s = reduceQuoteSession(s, { type: 'treat_as', treatAs: 'create_booking' });
    s = reduceQuoteSession(s, { type: 'analysis_started' });
    s = reduceQuoteSession(s, {
      type: 'analysis_ready',
      analysis: { ...quoteAnalysis, luna: lunaQuote({ workflow: 'create_booking' }) },
    });
    expect(s.analysis?.luna?.workflow).toBe('create_booking');
    expect(s.groups[0]?.adults).toBe(3);
  });

  it('a re-read without a type change still keeps the staff edits and the earlier analysis', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    const first = { ...quoteAnalysis, luna: lunaQuote() };
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: first });
    s = reduceQuoteSession(s, { type: 'patch_group', groupId: 'g1', patch: { adults: 3 } });
    s = reduceQuoteSession(s, { type: 'analysis_started' });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: { ...quoteAnalysis, luna: lunaQuote() } });
    expect(s.analysis).toBe(first);
    expect(s.groups[0]?.adults).toBe(3);
  });
});

describe('a header patched while Nava reads', () => {
  // The panel copies the agency and company from the contact while the read is in flight. That changes the header,
  // not the stays, so the read that lands next must still lay out its stays.
  const oneStayTwoRows: QuoteAnalysis = {
    intent: 'quote',
    groups: [
      { ...quoteAnalysis.groups[0]!, id: 'r1', stayId: 'stay-1', roomPreference: 'single', quantity: 1 },
      { ...quoteAnalysis.groups[0]!, id: 'r2', stayId: 'stay-1', roomPreference: 'double', quantity: 1 },
    ],
    secondaryAsks: [],
    alternatives: [],
  };

  it('keeps the stays and the read when the header is patched before the read lands', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'patch_staff_header', header: { agency: 'Agency A' } });
    s = reduceQuoteSession(s, { type: 'analysis_started' });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: oneStayTwoRows });
    expect(s.groups.map((group) => group.id)).toEqual(['r1', 'r2']);
    expect(groupStays(s.groups).map((stay) => stay.rows.length)).toEqual([2]);
    expect(s.analysis).toEqual(oneStayTwoRows);
  });
});

describe('type changed after rates', () => {
  it('drops the old rates and booking cards so Get rates runs again for the chosen type, keeping the stays', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: { ...quoteAnalysis, luna: lunaQuote() } });
    const withRates = { ...s, staffQuote: { stayKey: 'k' } as unknown as typeof s.staffQuote, phase: 'review' as const };
    const groups = withRates.groups;
    const after = reduceQuoteSession(withRates, { type: 'treat_as', treatAs: 'create_booking' });
    expect(after.treatAs).toBe('create_booking');
    expect(after.staffQuote).toBeNull();
    expect(after.bookingDrafts).toEqual({});
    expect(after.phase).toBe('requirements');
    expect(after.inputRevision).toBe(withRates.inputRevision + 1);
    expect(after.groups).toEqual(groups);
  });

  it('changes only the type when there are no rates yet', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = reduceQuoteSession(s, { type: 'analysis_ready', analysis: { ...quoteAnalysis, luna: lunaQuote() } });
    const after = reduceQuoteSession(s, { type: 'treat_as', treatAs: 'create_booking' });
    expect(after.treatAs).toBe('create_booking');
    expect(after.inputRevision).toBe(s.inputRevision);
  });
});

describe('stay edits: rows, stays and their rates', () => {
  type Row = QuoteSession['groups'][number];
  const dateA = { arrivalDate: '2026-11-12', departureDate: '2026-11-14' };
  const dateB = { arrivalDate: '2026-12-01', departureDate: '2026-12-03' };
  const keyA = '2026-11-12:2026-11-14';
  const keyB = '2026-12-01:2026-12-03';

  function row(id: string, dates: typeof dateA, over: Partial<Row> = {}): Row {
    return {
      id,
      ...dates,
      board: 'bb',
      quantity: 1,
      adults: 2,
      roomPreference: 'STWN',
      childrenAges: [],
      specialRequests: [],
      fields: {},
      ...over,
    };
  }

  function offerFor(id: string, quoteRequestKey: string): QuoteOffer {
    return {
      id,
      kind: 'allocation',
      roomCode: 'STWN',
      roomLabel: 'Standard Twin',
      board: 'bb',
      rateCode: 'BAR',
      currency: 'ZAR',
      nightly: [{ date: quoteRequestKey.slice(0, 10), amountMinor: 100 }],
      stayTotalMinor: 100,
      observedAt: '2026-10-05T12:00:00Z',
      sourceRef: id,
      restrictions: [],
      combinable: true,
      quoteRequestKey,
      coversGroupIds: [],
      quantity: 1,
      adults: 2,
    };
  }

  /** A session at the requirements step with both stays rated, as after a Get rates run for each. */
  function ratedSession(groups: Row[]): QuoteSession {
    const allocation = (key: string, revisionRef: string) =>
      ({ revisionRef, inputRevision: 1, quoteRequestKey: key, totalMinor: 100 }) as QuoteSession['staffQuotes'][string];
    const staffQuotes = { [keyA]: allocation(keyA, 'oa'), [keyB]: allocation(keyB, 'ob') };
    return {
      ...initialQuoteSession(),
      phase: 'results',
      groups,
      steps: planQuoteSteps(groups, staffQuotes),
      offers: [offerFor('oa', keyA), offerFor('ob', keyB)],
      staffQuotes,
      stayPdfs: { [keyA]: { fileName: 'A.pdf', bytesBase64: 'QQ==' }, [keyB]: { fileName: 'B.pdf', bytesBase64: 'Qg==' } },
    };
  }

  it('editing stay 2 keeps stay 1 rates, the revision and its step', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const next = reduceQuoteSession(s, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(next.inputRevision).toBe(s.inputRevision);
    expect(next.offers.map((offer) => offer.id)).toEqual(['oa']);
    expect(Object.keys(next.staffQuotes)).toEqual([keyA]);
    expect(Object.keys(next.stayPdfs)).toEqual([keyA]);
    expect(next.steps.find((step) => step.shareKey === keyA)?.status).toBe('succeeded');
    expect(next.steps.find((step) => step.shareKey === keyB)?.status).toBe('ready');
  });

  it('a row edit on the running stay mints a revision and clears the rates', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const running = { ...s, runningStepId: s.steps.find((step) => step.shareKey === keyB)!.id };
    const next = reduceQuoteSession(running, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(next.inputRevision).toBe(s.inputRevision + 1);
    expect(next.offers).toEqual([]);
    expect(next.staffQuotes).toEqual({});
  });

  function rateCardFor(groupId: string): RateOption {
    return {
      id: `rate-${groupId}`,
      groupId,
      board: 'bb',
      boardLabel: 'Bed & breakfast',
      rateCode: 'BAR',
      rateLabel: 'Best available',
      roomCode: 'STWN',
      roomLabel: 'Standard Twin',
      contract: false,
      onlyContract: false,
      matchesRequest: true,
      perNightMinor: 136000,
      totalMinor: 272000,
      currency: 'ZAR',
      priced: 'full',
      selected: false,
    };
  }

  it('a patch with a rate pin keeps that row cards and clears the others', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const withCards = { ...s, rateOptions: [rateCardFor('a1'), rateCardFor('b1')] };
    const next = reduceQuoteSession(withCards, {
      type: 'patch_group',
      groupId: 'b1',
      patch: { board: 'dinner_bb', rateCode: 'DBB' },
    });
    expect(next.rateOptions?.map((option) => option.groupId)).toEqual(['a1', 'b1']);
    const cleared = reduceQuoteSession(withCards, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(cleared.rateOptions?.map((option) => option.groupId)).toEqual(['a1']);
  });

  it('duplicating a stay copies its rows under new ids and a new stay', () => {
    const s = ratedSession([row('a1', dateA), row('a2', dateA, { roomPreference: 'DLXQN' }), row('b1', dateB)]);
    const dup = reduceQuoteSession(s, { type: 'duplicate_stay', stayId: stayIdOf(s.groups[0]!), token: 't1' });
    expect(dup.groups.map((group) => group.id)).toEqual(['a1', 'a2', 'r_t1_0', 'r_t1_1', 'b1']);
    const copies = dup.groups.slice(2, 4);
    expect(copies.every((group) => group.stayId === 's_t1')).toBe(true);
    expect(copies.map((group) => group.roomPreference)).toEqual(['STWN', 'DLXQN']);
    expect(groupStays(dup.groups).map((stay) => stay.rows.length)).toEqual([2, 2, 1]);
    // The copies share their dates with stay 1, so that date option's rates go; stay 2 keeps its own.
    expect(dup.offers.map((offer) => offer.id)).toEqual(['ob']);
  });

  it('adding a room joins its stay with the stay dates and no room type yet', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const after = reduceQuoteSession(s, { type: 'add_row', stayId: stayIdOf(s.groups[1]!), token: 'x' });
    const added = after.groups.find((group) => group.id === 'r_x');
    expect(added).toBeDefined();
    expect(added?.arrivalDate).toBe(dateB.arrivalDate);
    expect(added?.departureDate).toBe(dateB.departureDate);
    expect(stayIdOf(added!)).toBe(stayIdOf(s.groups[1]!));
    expect(rowRoomCode(added!)).toBeNull();
  });

  it.each(['add_row', 'duplicate_row'] as const)(
    'moves a single-row total to stay level when %s adds another room row',
    (actionType) => {
      const source = quoteAnalysis.groups[0]!;
      const analysis: QuoteAnalysis = {
        ...quoteAnalysis,
        requestedRoomsByStay: { g1: 6 },
        groups: [{ ...source, stayId: 'g1', quantity: 6, fields: { ...source.fields, quantity: 'defaulted' } }],
      };
      const ready = reduceQuoteSession(
        { ...initialQuoteSession(), binding: bind() },
        { type: 'analysis_ready', analysis },
      );

      const after =
        actionType === 'add_row'
          ? reduceQuoteSession(ready, { type: 'add_row', stayId: stayIdOf(ready.groups[0]!), token: 'more' })
          : reduceQuoteSession(ready, { type: 'duplicate_row', groupId: ready.groups[0]!.id, token: 'more' });

      expect(after.groups.map((group) => group.quantity ?? null)).toEqual([null, null]);
      expect(after.groups[0]?.fields.quantity).toBe('missing');
      if (actionType === 'duplicate_row') expect(after.groups[1]?.fields.quantity).toBe('missing');
      expect(after.analysis?.requestedRoomsByStay).toEqual({ g1: 6 });
    },
  );

  it('restores a one-row total after the added row is removed', () => {
    const source = quoteAnalysis.groups[0]!;
    const analysis: QuoteAnalysis = {
      ...quoteAnalysis,
      requestedRoomsByStay: { g1: 6 },
      groups: [{ ...source, stayId: 'g1', quantity: 6, fields: { ...source.fields, quantity: 'defaulted' } }],
    };
    const ready = reduceQuoteSession(
      { ...initialQuoteSession(), binding: bind() },
      { type: 'analysis_ready', analysis },
    );
    const withExtraRow = reduceQuoteSession(ready, { type: 'add_row', stayId: 'g1', token: 'more' });

    const backToOne = reduceQuoteSession(withExtraRow, { type: 'remove_row', groupId: 'r_more' });

    expect(backToOne.groups).toHaveLength(1);
    expect(backToOne.groups[0]).toMatchObject({ quantity: 6, fields: { quantity: 'defaulted' } });
  });

  it('a stay keeps its last room, and add stay makes an undated stay', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB), row('b2', dateB)]);
    expect(reduceQuoteSession(s, { type: 'remove_row', groupId: 'a1' })).toBe(s);
    const removed = reduceQuoteSession(s, { type: 'remove_row', groupId: 'b2' });
    expect(removed.groups.map((group) => group.id)).toEqual(['a1', 'b1']);
    const added = reduceQuoteSession(s, { type: 'add_stay', token: 'y' });
    expect(added.groups.at(-1)).toMatchObject({ id: 'r_y', stayId: 's_y', board: 'bb' });
    expect(added.groups.at(-1)?.arrivalDate).toBeUndefined();
  });

  it('removing a stay then undoing it restores its rows, their order and its rates', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB), row('b2', dateB, { roomPreference: 'SKNG' })]);
    const stayId = stayIdOf(s.groups[1]!);
    const removal = removedStayFor(s, stayId);
    expect(removal?.rows.map((group) => group.id)).toEqual(['b1', 'b2']);
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId });
    expect(gone.groups.map((group) => group.id)).toEqual(['a1']);
    expect(gone.offers.map((offer) => offer.id)).toEqual(['oa']);
    const back = reduceQuoteSession(gone, { type: 'restore_stay', removal: removal! });
    expect(back.groups).toEqual(s.groups);
    expect(back.offers.map((offer) => offer.id).sort()).toEqual(['oa', 'ob']);
    expect(Object.keys(back.stayPdfs).sort()).toEqual([keyA, keyB]);
    // Restoring a stay that is already back changes nothing.
    expect(reduceQuoteSession(back, { type: 'restore_stay', removal: removal! })).toBe(back);
  });

  it('undo brings the rows back but not the rates when the revision has moved since the removal', () => {
    const s = ratedSession([row('a1', dateA), row('b1', dateB), row('b2', dateB)]);
    const stayId = stayIdOf(s.groups[1]!);
    const removal = removedStayFor(s, stayId)!;
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId });
    const moved = reduceQuoteSession(gone, { type: 'patch_staff_header', header: { notes: 'later' } });
    const back = reduceQuoteSession(moved, { type: 'restore_stay', removal });
    expect(back.groups.map((group) => group.id)).toEqual(['a1', 'b1', 'b2']);
    expect(back.offers.some((offer) => offer.id === 'ob')).toBe(false);
  });

  it('undo of the selected stay brings back its rate cards, evidence, selection and PDF', () => {
    const base = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const s: QuoteSession = {
      ...base,
      phase: 'review',
      rateOptions: [rateCardFor('a1'), rateCardFor('b1')],
      evidence: { kind: 'authorised', selectionEpoch: 0, inputRevision: base.inputRevision },
      selectedStayKey: keyB,
      selectedOfferIds: ['ob'],
      staffQuote: base.staffQuotes[keyB]!,
      pdf: base.stayPdfs[keyB]!,
    };
    const stayId = stayIdOf(s.groups[1]!);
    const removal = removedStayFor(s, stayId)!;
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId });
    expect(gone.staffQuote).toBeNull();
    expect(gone.rateOptions?.map((option) => option.groupId)).toEqual(['a1']);
    const back = reduceQuoteSession(gone, { type: 'restore_stay', removal });
    expect(back.rateOptions?.map((option) => option.groupId).sort()).toEqual(['a1', 'b1']);
    expect(back.selectedStayKey).toBe(keyB);
    expect(back.selectedOfferIds).toEqual(['ob']);
    expect(back.staffQuote).toBe(s.staffQuote);
    expect(back.pdf).toBe(s.pdf);
    expect(back.evidence).toEqual(s.evidence);
    expect(back.phase).toBe('review');
  });

  it('undo after removing the only rated stay keeps the evidence the rates rest on', () => {
    const base = ratedSession([row('b1', dateB)]);
    const s: QuoteSession = {
      ...base,
      staffQuotes: { [keyB]: base.staffQuotes[keyB]! },
      offers: base.offers.filter((offer) => offer.id === 'ob'),
      evidence: { kind: 'authorised', selectionEpoch: 0, inputRevision: base.inputRevision },
    };
    const stayId = stayIdOf(s.groups[0]!);
    const removal = removedStayFor(s, stayId)!;
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId });
    expect(gone.evidence).toBeNull();
    const back = reduceQuoteSession(gone, { type: 'restore_stay', removal });
    expect(back.evidence).toEqual(s.evidence);
    expect(Object.keys(back.staffQuotes)).toEqual([keyB]);
  });

  it('undo does nothing once staff have moved to another email', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = { ...ratedSession([row('a1', dateA), row('b1', dateB)]), binding: s.binding };
    const stayId = stayIdOf(s.groups[1]!);
    const removal = removedStayFor(s, stayId)!;
    let other = reduceQuoteSession(s, { type: 'selection', binding: bind({ entryId: 'e2', selectionEpoch: 2 }) });
    other = { ...other, groups: [row('x1', dateA)] };
    expect(reduceQuoteSession(other, { type: 'restore_stay', removal })).toBe(other);
  });

  it('a run that read the rows before a stay edit cannot overwrite that edit', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = { ...s, phase: 'requirements', groups: [row('a1', dateA), row('b1', dateB)], staffSource: staffSource() };
    const readAt = s.stayRevision;
    const edited = reduceQuoteSession(s, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(edited.inputRevision).toBe(s.inputRevision);
    const ready = {
      type: 'staff_quote_ready' as const,
      offer: { ...offerFor('rev-1', keyA), nightly: [] },
      staffQuote: {
        workflowRunId: 'run-1',
        revisionRef: 'rev-1',
        factRefs: [],
        messageId: 'mail-1',
        threadId: 'thread-1',
        sourceHash: STAFF_HASH,
        selectionEpoch: 1,
        inputRevision: s.inputRevision,
        inputDigest: 'd',
        totalMinor: 100,
        currency: 'ZAR',
        quoteRequestKey: keyA,
        approvedHeader: {
          salesStrategy: 'BAR',
          company: '',
          agency: '',
          attention: '',
          clientEmail: '',
          clientTelephone: '',
        },
      } satisfies StaffQuoteAllocation,
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      groups: [row('a1', dateA), row('b1', dateB)],
    };
    // Without the read revision the run would land and put the old row back.
    expect(reduceQuoteSession(edited, ready).groups[1]?.adults).toBe(2);
    const stale = reduceQuoteSession(edited, { ...ready, stayRevision: readAt });
    expect(stale).toBe(edited);
    expect(stale.groups[1]?.adults).toBe(3);
  });

  it('undo does not bring back the rates of dates whose other stay changed since the removal', () => {
    // Two stays on the same dates share one run. Remove one, change the other's occupancy, then undo.
    const s = ratedSession([row('a1', dateA), row('b1', dateB, { stayId: 's_b1' }), row('b2', dateB, { stayId: 's_b2' })]);
    const removal = removedStayFor(s, 's_b2')!;
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId: 's_b2' });
    const changed = reduceQuoteSession(gone, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(changed.inputRevision).toBe(s.inputRevision);
    const back = reduceQuoteSession(changed, { type: 'restore_stay', removal });
    expect(back.groups.map((group) => group.id)).toEqual(['a1', 'b1', 'b2']);
    expect(back.offers.map((offer) => offer.id)).toEqual(['oa']);
    expect(Object.keys(back.staffQuotes)).toEqual([keyA]);
    expect(Object.keys(back.stayPdfs)).toEqual([keyA]);
  });

  it('a copied room or stay keeps the dinner allowance of the row it was copied from', () => {
    const base = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const s = { ...base, staffHeader: { ...base.staffHeader, dinnerAllowanceRequired: true, dinnerAllowanceGroupIds: ['a1'] } };
    const rowCopy = reduceQuoteSession(s, { type: 'duplicate_row', groupId: 'a1', token: 'c1' });
    expect(rowCopy.staffHeader.dinnerAllowanceGroupIds).toEqual(['a1', 'r_c1']);
    const stayCopy = reduceQuoteSession(s, { type: 'duplicate_stay', stayId: stayIdOf(s.groups[0]!), token: 'c2' });
    expect(stayCopy.staffHeader.dinnerAllowanceGroupIds).toEqual(['a1', 'r_c2_0']);
    const other = reduceQuoteSession(s, { type: 'duplicate_row', groupId: 'b1', token: 'c3' });
    expect(other.staffHeader.dinnerAllowanceGroupIds).toEqual(['a1']);
  });

  it('removing one stay does not move its extras onto the other stay', () => {
    const base = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const s: QuoteSession = {
      ...base,
      staffHeader: {
        ...base.staffHeader,
        stayExtrasByKey: {
          [keyA]: { shuttleEnabled: true, shuttleMinor: 45_000, shuttleTrips: 1, lunchEnabled: false, dinnerEnabled: false, otherEnabled: false },
          [keyB]: { shuttleEnabled: false, lunchEnabled: false, dinnerEnabled: false, otherEnabled: false },
        },
      },
      staffQuotes: {
        [keyA]: { ...base.staffQuotes[keyA]!, onceExtras: true },
        [keyB]: { ...base.staffQuotes[keyB]!, onceExtras: false },
      },
    };
    const kept = reduceQuoteSession(s, { type: 'add_row', stayId: stayIdOf(s.groups[1]!), token: 'n' });
    expect(Object.keys(kept.staffQuotes)).toEqual([keyA]);
    const gone = reduceQuoteSession(s, { type: 'remove_stay', stayId: stayIdOf(s.groups[0]!) });
    expect(gone.groups.map((group) => group.id)).toEqual(['b1']);
    expect(gone.staffQuotes[keyB]).toBe(s.staffQuotes[keyB]);
    expect(gone.staffHeader.stayExtrasByKey?.[keyB]?.shuttleEnabled).toBe(false);
    expect(gone.offers.map((offer) => offer.id)).toContain('ob');
    expect(gone.steps.find((step) => step.shareKey === keyB)?.status).toBe('succeeded');
  });

  it('undo restores a stay without changing either stay\'s extras selection', () => {
    const base = ratedSession([row('a1', dateA), row('b1', dateB)]);
    const s: QuoteSession = {
      ...base,
      staffHeader: {
        ...base.staffHeader,
        stayExtrasByKey: {
          [keyA]: { shuttleEnabled: true, shuttleMinor: 45_000, shuttleTrips: 1, lunchEnabled: false, dinnerEnabled: false, otherEnabled: false },
          [keyB]: { shuttleEnabled: false, lunchEnabled: false, dinnerEnabled: false, otherEnabled: false },
        },
      },
      staffQuotes: {
        [keyA]: { ...base.staffQuotes[keyA]!, onceExtras: true },
        [keyB]: { ...base.staffQuotes[keyB]!, onceExtras: false },
      },
    };
    const stayA = stayIdOf(s.groups[0]!);
    const removal = removedStayFor(s, stayA)!;
    const withoutA = reduceQuoteSession(s, { type: 'remove_stay', stayId: stayA });
    expect(withoutA.staffQuotes[keyB]).toBe(s.staffQuotes[keyB]);
    const back = reduceQuoteSession(withoutA, { type: 'restore_stay', removal });
    expect(back.groups.map((group) => group.id)).toEqual(['a1', 'b1']);
    expect(back.staffQuotes[keyA]).toBe(s.staffQuotes[keyA]);
    expect(back.staffQuotes[keyB]).toBe(s.staffQuotes[keyB]);
    expect(back.staffHeader.stayExtrasByKey?.[keyA]?.shuttleEnabled).toBe(true);
    expect(back.staffHeader.stayExtrasByKey?.[keyB]?.shuttleEnabled).toBe(false);
  });

  it('keeps a booking draft that lands after another stay was edited', () => {
    let s = reduceQuoteSession(initialQuoteSession(), { type: 'selection', binding: bind() });
    s = { ...ratedSession([row('a1', dateA), row('b1', dateB)]), binding: s.binding, staffSource: staffSource() };
    const preparedAt = s.stayRevision;
    const edited = reduceQuoteSession(s, { type: 'patch_group', groupId: 'b1', patch: { adults: 3 } });
    expect(edited.stayRevision).not.toBe(preparedAt);
    const payload = {
      draft: { rooms: [] },
      options: {},
      messageId: 'mail-1',
      selectionEpoch: 1,
      inputRevision: s.inputRevision,
      revisionRef: 'oa',
    } as unknown as Extract<QuoteSessionAction, { type: 'booking_draft_ready' }>['payload'];
    // The pane used to send the whole session's stay revision from when it asked, which any edit moved.
    const asked = { type: 'booking_draft_ready', payload, sourceHash: STAFF_HASH, stayRevision: preparedAt };
    const landed = reduceQuoteSession(edited, asked as QuoteSessionAction);
    expect(Object.keys(landed.bookingDrafts)).toEqual([keyA]);
    // A draft for the stay that was edited has no run left, so it is dropped.
    const stale = reduceQuoteSession(edited, {
      type: 'booking_draft_ready',
      payload: { ...payload, revisionRef: 'ob' },
      sourceHash: STAFF_HASH,
    });
    expect(stale).toBe(edited);
  });

  it('counts rooms and guests over every row', () => {
    const groups = [row('t', dateA, { quantity: 20, adults: 2 }), row('s', dateA, { quantity: 10, adults: 1, roomPreference: 'STQN' })];
    expect(stayTotals(groups)).toEqual({ rooms: 30, guests: 50 });
  });
});

describe('why the PDF cannot be made: the reason names the check that failed', () => {
  /** One stay, rated by a live staff run: the PDF can be made. */
  function ratedSingleStay(): QuoteSession {
    const s = withStaffSource(analysisReady());
    return reduceQuoteSession(s, staffQuoteFor(STAY_A, 'rev-1', 850000, s.inputRevision));
  }

  /** One stay with two room types on the same dates (STQN and STWN), priced by one live staff run. */
  function ratedMixedTypeStay(): QuoteSession {
    const analysis: QuoteAnalysis = {
      ...quoteAnalysis,
      groups: [
        { ...quoteAnalysis.groups[0]!, id: 'g1', quantity: 20, roomPreference: 'STQN' },
        { ...quoteAnalysis.groups[0]!, id: 'g2', quantity: 10, roomPreference: 'STWN' },
      ],
    };
    const s = withStaffSource(analysisReady(analysis));
    const run = staffQuoteFor(STAY_A, 'rev-1', 850000, s.inputRevision);
    if (run.type !== 'staff_quote_ready') throw new Error('expected a staff run');
    // One run prices the whole stay, and its offer covers every group on it (allocationFromStaffQuote).
    return reduceQuoteSession(s, { ...run, offer: { ...run.offer, coversGroupIds: ['g1', 'g2'], quantity: 30 } });
  }

  /** One stay with authorised (non-staff-run) results, nothing picked yet. */
  function authorisedResults(offers: QuoteOffer[] = [authorisedOffer]): QuoteSession {
    return reduceQuoteSession(withStaffSource(analysisReady()), {
      type: 'results_ready',
      offers,
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'authorised', selectionEpoch: 1, inputRevision: 1 },
    });
  }

  function expectBlocked(session: QuoteSession, kind: string, reason: string) {
    expect(pdfBlocker(session)?.kind).toBe(kind);
    expect(canCreatePdf(session)).toBe(false);
    expect(pdfBlockReason(session)).toBe(reason);
  }

  it('gives no reason once the PDF can be made', () => {
    const s = ratedSingleStay();
    expect(pdfBlocker(s)).toBeNull();
    expect(canCreatePdf(s)).toBe(true);
    expect(pdfBlockReason(s)).toBeNull();
  });

  it('gives no reason for a mixed-type stay that one live run priced (no staff tick)', () => {
    const s = ratedMixedTypeStay();
    expect(s.groups.map((group) => group.roomPreference)).toEqual(['STQN', 'STWN']);
    expect(pdfBlocker(s)).toBeNull();
    expect(canCreatePdf(s)).toBe(true);
    expect(pdfBlockReason(s)).toBeNull();
  });

  it('asks to fix an unreadable amount first', () => {
    const s = reduceQuoteSession(ratedSingleStay(), {
      type: 'patch_staff_header',
      header: { fieldErrors: { dinnerAllowance: 'Enter an amount in rand, like 450 or 1,250.50' } },
    });
    expectBlocked(
      s,
      'amounts',
      'Fix the amounts first. Dinner allowance: Enter an amount in rand, like 450 or 1,250.50',
    );
  });

  it('says the email is still loading, not "Get rates first", while its mailbox copy is not linked', () => {
    const s: QuoteSession = { ...ratedSingleStay(), staffSource: null };
    expectBlocked(s, 'source_not_ready', 'Nava is still loading this email. If this does not clear, select the email again.');
    expectBlocked({ ...s, mailboxStatus: 'unsynced' }, 'source_not_ready', 'Waiting for this email to finish syncing.');
  });

  it('keeps "Get rates first." only for an email with no rates at all', () => {
    expectBlocked(withStaffSource(analysisReady()), 'no_rates', 'Search availability first.');
  });

  it('says the rates are out of date when the run is there but its evidence is gone or for older inputs', () => {
    const rated = ratedSingleStay();
    const stale = 'The rates are out of date. The details changed after they were found. Search availability again.';
    // The live proof: the run happened, then the evidence was dropped. Staff must not be told to get rates first.
    expectBlocked({ ...rated, evidence: null }, 'rates_stale', stale);
    expectBlocked({ ...rated, inputRevision: rated.inputRevision + 1 }, 'rates_stale', stale);
    // Evidence still current, but the staff run is for another copy of the email.
    expectBlocked(
      { ...rated, staffSource: staffSource({ sourceHash: 'cd'.repeat(32) }) },
      'rates_stale',
      stale,
    );
  });

  it('says sample rates cannot make a PDF', () => {
    let s = reduceQuoteSession(withStaffSource(analysisReady()), {
      type: 'results_ready',
      offers: [authorisedOffer],
      selectionEpoch: 1,
      inputRevision: 1,
      provenance: { kind: 'fixture', selectionEpoch: 1, inputRevision: 1 },
    });
    s = reduceQuoteSession(s, { type: 'select_offers', offerIds: ['o1'] });
    expectBlocked(s, 'sample_rates', 'These are sample rates, so no PDF can be made. Open a live email to continue.');
  });

  it('counts rated stays on a combined quote', () => {
    const s = reduceQuoteSession(twoDateSession(), staffQuoteFor(STAY_A, 'rev-a', 272000, twoDateSession().inputRevision));
    expectBlocked(s, 'stays_unrated', '1 of 2 stays rated');
  });

  it('says options from more than one date search were picked for a one-stay quote', () => {
    const other: QuoteOffer = { ...authorisedOffer, id: 'o2', sourceRef: 'src-2', quoteRequestKey: STAY_B };
    const s = reduceQuoteSession(authorisedResults([authorisedOffer, other]), {
      type: 'select_offers',
      offerIds: ['o1', 'o2'],
    });
    expectBlocked(
      s,
      'mixed_stays',
      'Pick room options from one stay only. Separate date searches do not prove that all stays are available together.',
    );
  });

  it('asks for the rated option back when only the pick moved off it', () => {
    const s = reduceQuoteSession(ratedSingleStay(), { type: 'select_offers', offerIds: [] });
    expectBlocked(s, 'rated_option_not_picked', 'Pick the room option the rates were found for, or get rates again.');
  });

  it('asks to pick a room option when none is picked', () => {
    expectBlocked(authorisedResults(), 'nothing_picked', 'Pick a room option first.');
  });

  it('says a picked option is no longer in the results', () => {
    const s = reduceQuoteSession(authorisedResults(), { type: 'select_offers', offerIds: ['gone'] });
    expectBlocked(s, 'pick_gone', 'A picked room option is no longer in the results. Pick again.');
  });

  it('says the picked rooms do not match the rooms and guests asked for', () => {
    const twoRooms: QuoteOffer = { ...authorisedOffer, quantity: 2 };
    const s = reduceQuoteSession(authorisedResults([twoRooms]), { type: 'select_offers', offerIds: ['o1'] });
    expectBlocked(
      s,
      'occupancy',
      'The picked rooms do not match the rooms and guests asked for. Pick rooms that match.',
    );
  });

  it('asks to pick the stay when no stay row matches the selected stay', () => {
    const s = reduceQuoteSession(authorisedResults(), { type: 'select_offers', offerIds: ['o1'] });
    expect(canCreatePdf(s)).toBe(true);
    expectBlocked({ ...s, selectedStayKey: STAY_B }, 'no_stay', 'Pick the stay to quote first.');
  });
});

describe('rowRoomCode: staff picks beat the projected room type', () => {
  const row = (over: Record<string, unknown>) =>
    ({ roomTypeCode: 'STQN', roomPreference: 'Standard Queen', ...over }) as Parameters<typeof rowRoomCode>[0];

  it('uses the projected room type while staff have not picked another', () => {
    expect(rowRoomCode(row({}))).toBe('STQN');
  });

  it('a rate-card pick (roomCodes) wins over the projected room type', () => {
    expect(rowRoomCode(row({ roomCodes: ['SKNG'] }))).toBe('SKNG');
  });

  it('a select choice (roomPreference) wins over a stale projected room type', () => {
    expect(rowRoomCode(row({ roomPreference: 'SKNG' }))).toBe('SKNG');
  });

  it('a cleared select leaves the row with no room type', () => {
    expect(rowRoomCode(row({ roomPreference: '', roomTypeCode: undefined }))).toBeNull();
  });
});

describe('autoRunHeader', () => {
  const header = { ...emptyStaffQuoteHeader(), salesStrategy: 'Government' as const };

  it('mirrors the background prepare: Government only when every row is Dinner B&B, else BAR', () => {
    expect(autoRunHeader({ staffHeader: emptyStaffQuoteHeader(), groups: [{ board: 'dinner_bb' }] as never }).salesStrategy).toBe(
      'Government',
    );
    expect(autoRunHeader({ staffHeader: header, groups: [{ board: 'bb' }] as never }).salesStrategy).toBe('BAR');
    expect(
      autoRunHeader({ staffHeader: header, groups: [{ board: 'dinner_bb' }, { board: 'bb' }] as never }).salesStrategy,
    ).toBe('BAR');
  });
});

it('a mixed Dinner B&B + B&B mail keeps the session default on BAR', () => {
  const mixed: QuoteAnalysis = {
    ...quoteAnalysis,
    groups: quoteAnalysis.groups.flatMap((group, index) =>
      index === 0
        ? [{ ...group, board: 'dinner_bb' as const }, { ...group, id: `${group.id}-bb`, board: 'bb' as const }]
        : [group],
    ),
  };
  const session = reduceQuoteSession(initialQuoteSession(), { type: 'analysis_ready', analysis: mixed });
  expect(session.staffHeader.salesStrategy).toBe('BAR');
});

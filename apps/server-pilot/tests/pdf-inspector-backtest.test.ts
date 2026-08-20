import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PDF_BACKTEST_ADJUDICATION_LABELS,
  PDF_BACKTEST_DISCREPANCY_CLASSES,
  PDF_BACKTEST_SCOPE_BUCKETS,
  aggregatePdfInspectorBacktest,
  comparePdfParserOutcomes,
  parsePdfInspectorProvenance,
  renderPdfInspectorAggregateReport,
  renderPrivatePdfSideBySideReview,
  withPdfAdjudication,
} from '../src/ops/pdf-inspector-backtest.js';

type ParserName = 'poppler' | 'inspector';

const inspectorDiagnostics = {
  pdfType: 'TextBased' as const,
  confidence: 0.99,
  ocrPages: [] as number[],
  tablePages: [] as number[],
  columnPages: [] as number[],
  hasEncodingIssues: false,
  isComplexLayout: false,
};

const validInspectorProvenance = {
  backtestOnly: false,
  packageVersion: '1.12.0',
  lopdfVersion: '0.42.0',
  runtimeVerified: true,
  implementationFingerprint: {
    algorithm: 'sha256',
    value: 'a'.repeat(64),
  },
} as const;

function outcome(
  parser: ParserName,
  options: {
    text?: string | null;
    markdown?: string | null;
    status?: 'ok' | 'manual_required';
    reason?: string;
    pageCount?: number | null;
    elapsedMs?: number;
    sourceRef?: string;
    diagnostics?: typeof inspectorDiagnostics;
  } = {},
) {
  const base = {
    parser,
    status: options.status ?? 'ok',
    reason: options.reason ?? 'text',
    pageCount: options.pageCount === undefined ? 1 : options.pageCount,
    text: options.text === undefined ? 'Reservation confirmed' : options.text,
    markdown: options.markdown === undefined ? null : options.markdown,
    elapsedMs: options.elapsedMs ?? 10,
    sourceRef: options.sourceRef ?? 'opaque/private/ref-1',
  };
  if (parser === 'inspector') {
    return {
      ...base,
      diagnostics: options.diagnostics ?? inspectorDiagnostics,
    };
  }
  return base;
}

function comparison(
  popplerOptions: Parameters<typeof outcome>[1] = {},
  inspectorOptions: Parameters<typeof outcome>[1] = {},
  scopeBucketOrMembership:
    | (typeof PDF_BACKTEST_SCOPE_BUCKETS)[number]
    | { full_corpus: boolean; current_runtime_subset: boolean } = 'full_corpus',
  sourceRef = 'opaque/private/ref-1',
) {
  const scopeMembership =
    typeof scopeBucketOrMembership === 'string'
      ? {
          full_corpus: true,
          current_runtime_subset:
            scopeBucketOrMembership === 'current_runtime_subset',
        }
      : scopeBucketOrMembership;
  return comparePdfParserOutcomes({
    scopeMembership,
    sourceRef,
    poppler: outcome('poppler', { ...popplerOptions, sourceRef }),
    inspector: outcome('inspector', { ...inspectorOptions, sourceRef }),
  });
}

function adjudicated(
  label: (typeof PDF_BACKTEST_ADJUDICATION_LABELS)[number],
  current = comparison(),
  rationaleCodes = ['normalized_match'] as const,
  sourceRef = current.private.sourceRef,
) {
  return withPdfAdjudication(current, {
    sourceRef: sourceRef!,
    label,
    rationaleCodes: [...rationaleCodes],
  });
}

function reportInput(
  comparisons: readonly ReturnType<typeof comparison>[],
  provenance = validInspectorProvenance,
) {
  return {
    comparisons,
    scopeDenominators: {
      full_corpus: { eligible: comparisons.length, attempted: comparisons.length },
      current_runtime_subset: { eligible: 0, attempted: 0 },
    },
    packageVersions: { pdfInspector: '1.12.0' },
    toolVersions: { poppler: '24.02.0' },
    inspectorProvenance: provenance,
    gates: {
      adjudicationComplete: true,
      safetyGatePassed: true,
      promotionGatePassed: true,
      explicitPromotionApproved: true,
    },
  };
}

describe('PDF Inspector parser-neutral backtest contracts', () => {
  it('exports exact scope, discrepancy, and adjudication bins', () => {
    expect(PDF_BACKTEST_SCOPE_BUCKETS).toEqual([
      'full_corpus',
      'current_runtime_subset',
    ]);
    expect(PDF_BACKTEST_DISCREPANCY_CLASSES).toEqual([
      'equivalent',
      'inspector_better_candidate',
      'poppler_better_candidate',
      'status_mismatch',
      'extraction_failure_mismatch',
      'needs_ocr',
      'manual_unreadable',
    ]);
    expect(PDF_BACKTEST_ADJUDICATION_LABELS).toEqual([
      'equivalent',
      'inspector_better',
      'poppler_better',
      'both_insufficient',
      'needs_ocr',
      'unreadable',
    ]);
  });

  it('normalizes only comparison material and retains private raw values', () => {
    const result = comparison(
      {
        text: '\uFEFFBooking\r\nReference\u0000  ABC-123',
        markdown: 'PRIVATE POPPLER MARKDOWN',
      },
      {
        text: 'booking reference ABC-123',
        markdown: 'PRIVATE INSPECTOR MARKDOWN',
      },
    );

    expect(result.aggregate.discrepancyClass).toBe('equivalent');
    expect(result.private.poppler.text).toBe('\uFEFFBooking\r\nReference\u0000  ABC-123');
    expect(result.private.poppler.markdown).toBe('PRIVATE POPPLER MARKDOWN');
    expect(result.private.inspector.markdown).toBe('PRIVATE INSPECTOR MARKDOWN');
    expect(result.aggregate).not.toHaveProperty('sourceRef');
    expect(JSON.stringify(result.aggregate)).not.toContain('PRIVATE');
  });

  it.each([
    [
      'equivalent',
      comparison(
        { text: 'Booking reference ABC-123' },
        { text: 'Booking  reference\r\nABC-123' },
      ),
    ],
    [
      'inspector_better_candidate',
      comparison(
        { text: 'ABC-123' },
        {
          text: 'ABC-123 Guest Jane Doe Arrival 2026-08-10 Departure 2026-08-12',
        },
      ),
    ],
    [
      'poppler_better_candidate',
      comparison(
        {
          text: 'ABC-123 Guest Jane Doe Arrival 2026-08-10 Departure 2026-08-12',
        },
        { text: 'ABC-123' },
      ),
    ],
    [
      'status_mismatch',
      comparison(
        {
          status: 'manual_required',
          reason: 'encrypted',
          pageCount: null,
          text: null,
          markdown: null,
        },
        {
          status: 'manual_required',
          reason: 'malformed',
          pageCount: null,
          text: null,
          markdown: null,
        },
      ),
    ],
    [
      'extraction_failure_mismatch',
      comparison(
        {
          status: 'manual_required',
          reason: 'parser_failure',
          pageCount: null,
          text: null,
          markdown: null,
        },
        { text: 'ABC-123' },
      ),
    ],
    [
      'needs_ocr',
      comparison(
        {
          status: 'manual_required',
          reason: 'no_embedded_text',
          pageCount: 2,
          text: null,
          markdown: null,
        },
        {
          status: 'manual_required',
          reason: 'no_embedded_text',
          pageCount: 2,
          text: null,
          markdown: null,
          diagnostics: {
            ...inspectorDiagnostics,
            pdfType: 'Scanned',
            confidence: 0.94,
            ocrPages: [1, 2],
          },
        },
      ),
    ],
    [
      'manual_unreadable',
      comparison(
        {
          status: 'manual_required',
          reason: 'malformed',
          pageCount: null,
          text: null,
          markdown: null,
        },
        {
          status: 'manual_required',
          reason: 'malformed',
          pageCount: null,
          text: null,
          markdown: null,
          diagnostics: {
            ...inspectorDiagnostics,
            pdfType: null,
            confidence: null,
          },
        },
      ),
    ],
  ])('classifies %s exactly', (expected, result) => {
    expect(result.aggregate.discrepancyClass).toBe(expected);
  });

  it('keeps high overlap routing-only and does not call it equivalent', () => {
    const shared = Array.from({ length: 24 }, (_, index) => `token-${index}`);
    const result = comparison(
      { text: shared.join(' ') },
      { text: `${shared.join(' ')} extra-token` },
    );

    expect(result.aggregate.textAgreement.band).toBe('high');
    expect(result.aggregate.textAgreement.routingSimilarity).toBeLessThan(1);
    expect(result.aggregate.discrepancyClass).not.toBe('equivalent');
  });

  it('emits deterministic length, agreement, and Markdown structure bands', () => {
    const result = comparison(
      {
        text: '# Title\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        markdown: '# Title\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      },
      {
        text: '# Title\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |',
        markdown: '# Title\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      },
    );

    expect(result.aggregate.lengthBands).toEqual({
      poppler: 'short',
      inspector: 'short',
    });
    expect(result.aggregate.textAgreement.band).toBe('exact');
    expect(result.aggregate.textAgreement.routingSimilarity).toBe(1);
    expect(result.aggregate.markdownStructure.poppler).toMatchObject({
      headingCount: 1,
      listItemCount: 2,
      tableCount: 1,
    });
    expect(result.aggregate.markdownStructure.inspector).toEqual(
      result.aggregate.markdownStructure.poppler,
    );
  });

  it('records both scope buckets without exposing source identity', () => {
    const full = comparison({}, {}, 'full_corpus');
    const subset = comparison(
      { text: 'subset' },
      { text: 'subset' },
      'current_runtime_subset',
    );

    expect(full.aggregate.scopeMembership).toEqual({
      full_corpus: true,
      current_runtime_subset: false,
    });
    expect(subset.aggregate.scopeMembership).toEqual({
      full_corpus: true,
      current_runtime_subset: true,
    });
    expect(full.aggregate).not.toHaveProperty('sourceRef');
    expect(subset.aggregate).not.toHaveProperty('sourceRef');
  });

  it('stores adjudication labels and rationale/sourceRef only in private material', () => {
    const result = adjudicated('inspector_better', comparison({ text: 'A' }, { text: 'A B C' }), [
      'inspector_has_more_text',
    ]);

    expect(result.private.adjudication).toEqual({
      sourceRef: 'opaque/private/ref-1',
      label: 'inspector_better',
      rationaleCodes: ['inspector_has_more_text'],
    });
    expect(result.aggregate).not.toHaveProperty('adjudication');
    expect(result.aggregate).not.toHaveProperty('rationaleCodes');
    expect(JSON.stringify(result.aggregate)).not.toContain('opaque/private/ref-1');
  });

  it('renders private side-by-side review separately from aggregate JSON', () => {
    const result = adjudicated(
      'equivalent',
      comparison(
        { text: 'PRIVATE BODY', markdown: 'PRIVATE POPPLER MD' },
        { text: 'PRIVATE BODY', markdown: 'PRIVATE INSPECTOR MD' },
      ),
    );

    const privateReview = renderPrivatePdfSideBySideReview([result]);
    expect(privateReview).toContain('PRIVATE BODY');
    expect(privateReview).toContain('PRIVATE INSPECTOR MD');
    expect(privateReview).toContain('opaque/private/ref-1');

    const publicReport = aggregatePdfInspectorBacktest({
      comparisons: [result],
      scopeDenominators: {
        full_corpus: { eligible: 1, attempted: 1 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: { pdfInspector: '1.12.0' },
      toolVersions: { poppler: '24.02.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: true,
        safetyGatePassed: false,
        promotionGatePassed: false,
        explicitPromotionApproved: false,
      },
    });
    const publicJson = renderPdfInspectorAggregateReport(publicReport);
    expect(publicJson).not.toContain('PRIVATE');
    expect(publicJson).not.toContain('opaque/private/ref-1');
    expect(publicJson).not.toContain('sourceRef');
  });

  it('aggregates denominators, bins, reasons, adjudications, and p50/p95 timings', () => {
    const comparisons = [
      adjudicated(
        'equivalent',
        comparison(
          { elapsedMs: 40 },
          { elapsedMs: 80 },
          'full_corpus',
          'opaque/private/ref-1',
        ),
      ),
      adjudicated(
        'inspector_better',
        comparison(
          { text: 'A', elapsedMs: 10 },
          { text: 'A B C', elapsedMs: 20 },
          'full_corpus',
          'opaque/private/ref-2',
        ),
        ['inspector_has_more_text'],
      ),
      adjudicated(
        'needs_ocr',
        comparison(
          {
            status: 'manual_required',
            reason: 'no_embedded_text',
            pageCount: 1,
            text: null,
            markdown: null,
          },
          {
            status: 'manual_required',
            reason: 'no_embedded_text',
            pageCount: 1,
            text: null,
            markdown: null,
            diagnostics: {
              ...inspectorDiagnostics,
              pdfType: 'Scanned',
              ocrPages: [1],
            },
          },
          'current_runtime_subset',
          'opaque/private/ref-3',
        ),
        ['ocr_signal'],
      ),
    ];

    const report = aggregatePdfInspectorBacktest({
      comparisons,
      scopeDenominators: {
        full_corpus: { eligible: 10, attempted: 3 },
        current_runtime_subset: { eligible: 3, attempted: 1 },
      },
      packageVersions: { pdfInspector: '1.12.0', zod: '3.25.67' },
      toolVersions: { poppler: '24.02.0', bwrap: '0.8.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: true,
        safetyGatePassed: false,
        promotionGatePassed: false,
        explicitPromotionApproved: false,
      },
    });

    expect(report.scopeDenominators).toEqual({
      full_corpus: {
        eligible: 10,
        attempted: 3,
        unprocessed: 7,
      },
      current_runtime_subset: {
        eligible: 3,
        attempted: 1,
        unprocessed: 2,
      },
    });
    expect(report.counts.byDiscrepancy.equivalent).toBe(1);
    expect(report.counts.byDiscrepancy.inspector_better_candidate).toBe(1);
    expect(report.counts.byDiscrepancy.needs_ocr).toBe(1);
    expect(report.counts.byAdjudication.inspector_better).toBe(1);
    expect(report.counts.byAdjudication.needs_ocr).toBe(1);
    expect(report.counts.byReason.poppler.parser_failure).toBe(0);
    expect(report.counts.byReason.inspector.no_embedded_text).toBe(1);
    expect(report.timingsMs.poppler).toEqual({ p50: 10, p95: 40 });
    expect(report.timingsMs.inspector).toEqual({ p50: 20, p95: 80 });
  });

  it('defaults to blocked Poppler recommendation when gates or adjudication are incomplete', () => {
    const candidates = [
      comparison(
        { text: 'A' },
        { text: 'A B C D E F G H I J' },
      ),
    ];

    const report = aggregatePdfInspectorBacktest({
      comparisons: candidates,
      scopeDenominators: {
        full_corpus: { eligible: 1, attempted: 1 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: { pdfInspector: '1.12.0' },
      toolVersions: { poppler: '24.02.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: false,
        safetyGatePassed: true,
        promotionGatePassed: true,
        explicitPromotionApproved: true,
      },
    });

    expect(report.recommendation).toEqual({
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'ADJUDICATION_INCOMPLETE',
    });
  });

  it('does not auto-promote from similarity without explicit gates', () => {
    const report = aggregatePdfInspectorBacktest({
      comparisons: [
        adjudicated(
          'inspector_better',
          comparison({ text: 'A' }, { text: 'A much longer extraction' }),
          ['inspector_has_more_text'],
        ),
      ],
      scopeDenominators: {
        full_corpus: { eligible: 1, attempted: 1 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: { pdfInspector: '1.12.0' },
      toolVersions: { poppler: '24.02.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: true,
        safetyGatePassed: false,
        promotionGatePassed: false,
        explicitPromotionApproved: false,
      },
    });

    expect(report.recommendation.parser).toBe('poppler');
    expect(report.recommendation.state).toBe('blocked');
    expect(report.recommendation.reasonCode).toBe('SAFETY_GATE_INCOMPLETE');
  });

  it('allows Inspector recommendation only after complete explicit adjudication and gates', () => {
    const report = aggregatePdfInspectorBacktest({
      comparisons: [
        adjudicated(
          'inspector_better',
          comparison({ text: 'A' }, { text: 'A much longer extraction' }),
          ['inspector_has_more_text'],
        ),
      ],
      scopeDenominators: {
        full_corpus: { eligible: 1, attempted: 1 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: { pdfInspector: '1.12.0' },
      toolVersions: { poppler: '24.02.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: true,
        safetyGatePassed: true,
        promotionGatePassed: true,
        explicitPromotionApproved: true,
      },
    });

    expect(report.recommendation).toEqual({
      parser: 'inspector',
      state: 'approved',
      reasonCode: 'EXPLICIT_PROMOTION_APPROVED',
    });
  });

  it('rejects forbidden public fields at runtime, including cast-as-any input', () => {
    const report = aggregatePdfInspectorBacktest({
      comparisons: [adjudicated('equivalent')],
      scopeDenominators: {
        full_corpus: { eligible: 1, attempted: 1 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: { pdfInspector: '1.12.0' },
      toolVersions: { poppler: '24.02.0' },
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: true,
        safetyGatePassed: true,
        promotionGatePassed: true,
        explicitPromotionApproved: true,
      },
    });

    expect(() =>
      renderPdfInspectorAggregateReport({
        ...report,
        sourceRef: 'opaque/private/ref-1',
      } as any),
    ).toThrow(/forbidden/i);
    expect(() =>
      renderPdfInspectorAggregateReport({
        ...report,
        scopeDenominators: {
          ...report.scopeDenominators,
          full_corpus: {
            ...report.scopeDenominators.full_corpus,
            s3Key: 'private/key.pdf',
          },
        },
      } as any),
    ).toThrow(/forbidden/i);
    expect(() =>
      renderPdfInspectorAggregateReport({
        ...report,
        versions: {
          ...(report as any).versions,
          sourceRef: 'opaque/private/ref-1',
        },
      } as any),
    ).toThrow(/forbidden/i);
  });

  it('rejects invalid denominators, elapsed values, and unknown public fields', () => {
    expect(() =>
      aggregatePdfInspectorBacktest({
        comparisons: [],
        scopeDenominators: {
          full_corpus: { eligible: 1, attempted: 2 },
          current_runtime_subset: { eligible: 0, attempted: 0 },
        },
        packageVersions: {},
        toolVersions: {},
        inspectorProvenance: validInspectorProvenance,
        gates: {
          adjudicationComplete: false,
          safetyGatePassed: false,
          promotionGatePassed: false,
          explicitPromotionApproved: false,
        },
      }),
    ).toThrow(/denominator/i);

    expect(() =>
      comparison({ elapsedMs: -1 } as any),
    ).toThrow(/elapsed|invalid|greater/i);

    const valid = aggregatePdfInspectorBacktest({
      comparisons: [],
      scopeDenominators: {
        full_corpus: { eligible: 0, attempted: 0 },
        current_runtime_subset: { eligible: 0, attempted: 0 },
      },
      packageVersions: {},
      toolVersions: {},
      inspectorProvenance: validInspectorProvenance,
      gates: {
        adjudicationComplete: false,
        safetyGatePassed: false,
        promotionGatePassed: false,
        explicitPromotionApproved: false,
      },
    });
    expect(() =>
      renderPdfInspectorAggregateReport({
        ...valid,
        unexpected: true,
      } as any),
    ).toThrow(/forbidden|unknown|unrecognized/i);
  });

  it('requires canonical sourceRef across compare input and both parsers', () => {
    expect(() =>
      comparePdfParserOutcomes({
        scopeMembership: {
          full_corpus: true,
          current_runtime_subset: false,
        },
        sourceRef: 'opaque/private/canonical',
        poppler: outcome('poppler', {
          sourceRef: 'opaque/private/poppler-only',
        }),
        inspector: outcome('inspector', {
          sourceRef: 'opaque/private/canonical',
        }),
      }),
    ).toThrow(/source.?ref/i);
  });

  it('requires adjudication sourceRef to match private comparison', () => {
    const current = comparison();
    expect(() =>
      withPdfAdjudication(current, {
        sourceRef: 'opaque/private/other',
        label: 'equivalent',
        rationaleCodes: ['normalized_match'],
      }),
    ).toThrow(/source.?ref/i);
  });

  it('allows equivalent adjudication for punctuation-only status mismatch', () => {
    const current = comparison(
      { text: 'Booking reference: ABC-123' },
      { text: 'Booking reference ABC-123' },
    );

    expect(current.aggregate.discrepancyClass).toBe('status_mismatch');
    expect(
      withPdfAdjudication(current, {
        sourceRef: current.private.sourceRef,
        label: 'equivalent',
        rationaleCodes: ['normalized_match'],
      }).private.adjudication?.label,
    ).toBe('equivalent');
  });

  it('allows manual Poppler winner when candidate classification overstates Inspector', () => {
    const current = comparison(
      { text: 'A' },
      { text: 'Inspector extraction has extra formatting noise' },
    );

    expect(current.aggregate.discrepancyClass).toBe('inspector_better_candidate');
    expect(
      withPdfAdjudication(current, {
        sourceRef: current.private.sourceRef,
        label: 'poppler_better',
        rationaleCodes: ['poppler_has_more_text'],
      }).private.adjudication?.label,
    ).toBe('poppler_better');
  });

  it('rejects duplicate private refs and missing per-scope records', () => {
    const one = adjudicated('equivalent');
    expect(() =>
      aggregatePdfInspectorBacktest({
        ...reportInput([one, one]),
        scopeDenominators: {
          full_corpus: { eligible: 2, attempted: 2 },
          current_runtime_subset: { eligible: 0, attempted: 0 },
        },
      }),
    ).toThrow(/duplicate|sourceRef/i);

    expect(() =>
      aggregatePdfInspectorBacktest({
        ...reportInput([]),
        scopeDenominators: {
          full_corpus: { eligible: 1, attempted: 1 },
          current_runtime_subset: { eligible: 0, attempted: 0 },
        },
      }),
    ).toThrow(/denominator|cardinality|attempted/i);
  });

  it('rejects unsafe adjudication relabels for OCR and unreadable classes', () => {
    const ocr = comparison(
      {
        status: 'manual_required',
        reason: 'no_embedded_text',
        pageCount: 1,
        text: null,
        markdown: null,
      },
      {
        status: 'manual_required',
        reason: 'no_embedded_text',
        pageCount: 1,
        text: null,
        markdown: null,
        diagnostics: {
          ...inspectorDiagnostics,
          pdfType: 'Scanned',
          ocrPages: [1],
        },
      },
    );
    expect(() =>
      withPdfAdjudication(ocr, {
        sourceRef: ocr.private.sourceRef,
        label: 'inspector_better',
        rationaleCodes: ['inspector_has_more_text'],
      }),
    ).toThrow(/compatible|unsafe|adjudication/i);

    const unreadable = comparison(
      {
        status: 'manual_required',
        reason: 'malformed',
        pageCount: null,
        text: null,
        markdown: null,
      },
      {
        status: 'manual_required',
        reason: 'malformed',
        pageCount: null,
        text: null,
        markdown: null,
      },
    );
    expect(() =>
      withPdfAdjudication(unreadable, {
        sourceRef: unreadable.private.sourceRef,
        label: 'inspector_better',
        rationaleCodes: ['inspector_has_more_text'],
      }),
    ).toThrow(/compatible|unsafe|adjudication/i);
  });

  it('rechecks private aggregate class before any Inspector recommendation', () => {
    const current = comparison(
      {
        status: 'manual_required',
        reason: 'no_embedded_text',
        pageCount: 1,
        text: null,
        markdown: null,
      },
      {
        status: 'manual_required',
        reason: 'no_embedded_text',
        pageCount: 1,
        text: null,
        markdown: null,
        diagnostics: {
          ...inspectorDiagnostics,
          pdfType: 'Scanned',
          ocrPages: [1],
        },
      },
    );
    const relabeled = {
      ...current,
      private: {
        ...current.private,
        adjudication: {
          sourceRef: current.private.sourceRef,
          label: 'inspector_better',
          rationaleCodes: ['inspector_has_more_text'],
        },
      },
    };
    expect(() =>
      aggregatePdfInspectorBacktest(reportInput([relabeled as any])),
    ).toThrow(/compatible|unsafe|adjudication/i);
  });

  it('derives timing percentiles from private parser outcomes', () => {
    const current = adjudicated(
      'equivalent',
      comparison(
        { elapsedMs: 7 },
        { elapsedMs: 13 },
      ),
    );
    const report = aggregatePdfInspectorBacktest(reportInput([current]));
    expect(report.timingsMs).toEqual({
      poppler: { p50: 7, p95: 7 },
      inspector: { p50: 13, p95: 13 },
    });
  });

  it('fails closed on current backtest-only Firecrawl provenance', () => {
    const currentManifest = JSON.parse(
      readFileSync(
        new URL('../deploy/pdf-inspector-provenance.json', import.meta.url),
        'utf8',
      ),
    );
    expect(() => parsePdfInspectorProvenance(currentManifest)).toThrow(
      /provenance|fingerprint|runtime/i,
    );

    const unsafeProvenance = {
      ...validInspectorProvenance,
      backtestOnly: true,
      lopdfVersion: '0.41.0',
    };
    const approvedCandidate = adjudicated(
      'inspector_better',
      comparison({ text: 'A' }, { text: 'A much longer extraction' }),
      ['inspector_has_more_text'],
    );
    const report = aggregatePdfInspectorBacktest(
      reportInput([approvedCandidate], unsafeProvenance),
    );
    expect(report.recommendation).toEqual({
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'INSPECTOR_PROVENANCE_UNSAFE',
    });
  });

  it('rejects nested stderr and raw version values', () => {
    const report = aggregatePdfInspectorBacktest(
      reportInput([adjudicated('equivalent')]),
    );
    expect(() =>
      renderPdfInspectorAggregateReport({
        ...report,
        counts: {
          ...report.counts,
          byReason: {
            ...report.counts.byReason,
            poppler: { ...report.counts.byReason.poppler, stderr: 1 },
          },
        },
      } as any),
    ).toThrow(/forbidden|reason|unrecognized/i);
    expect(() =>
      aggregatePdfInspectorBacktest({
        ...reportInput([adjudicated('equivalent')]),
        packageVersions: { pdfInspector: 'PRIVATE BODY / s3/key' },
      } as any),
    ).toThrow(/version|invalid/i);
  });

  it('counts one private comparison in both overlapping scope memberships', () => {
    const overlap = adjudicated(
      'equivalent',
      comparison(
        {},
        {},
        { full_corpus: true, current_runtime_subset: true },
        'opaque/private/overlap-1',
      ),
    );
    const report = aggregatePdfInspectorBacktest({
      ...reportInput([overlap]),
      scopeDenominators: {
        full_corpus: { eligible: 10, attempted: 1 },
        current_runtime_subset: { eligible: 3, attempted: 1 },
      },
    });

    expect(report.scopeDenominators).toEqual({
      full_corpus: { eligible: 10, attempted: 1, unprocessed: 9 },
      current_runtime_subset: {
        eligible: 3,
        attempted: 1,
        unprocessed: 2,
      },
    });
    expect(renderPrivatePdfSideBySideReview([overlap])).toContain(
      '"scopeMembership"',
    );
  });

  it('allows manual Inspector winner when Inspector alone is usable', () => {
    const failedPoppler = comparison(
      {
        status: 'manual_required',
        reason: 'parser_failure',
        pageCount: null,
        text: null,
        markdown: null,
      },
      { text: 'Inspector usable extraction' },
      'full_corpus',
      'opaque/private/inspector-winner-1',
    );
    const report = aggregatePdfInspectorBacktest(
      reportInput([
        adjudicated(
          'inspector_better',
          failedPoppler,
          ['extraction_failure'],
        ),
      ]),
    );

    expect(report.counts.byDiscrepancy.extraction_failure_mismatch).toBe(1);
    expect(report.recommendation).toMatchObject({
      parser: 'inspector',
      state: 'approved',
    });
  });

  it('allows manual Poppler winner when Poppler alone is usable', () => {
    const failedInspector = comparison(
      { text: 'Poppler usable extraction' },
      {
        status: 'manual_required',
        reason: 'parser_failure',
        pageCount: null,
        text: null,
        markdown: null,
      },
      'full_corpus',
      'opaque/private/poppler-winner-1',
    );
    const report = aggregatePdfInspectorBacktest(
      reportInput([
        adjudicated(
          'poppler_better',
          failedInspector,
          ['extraction_failure'],
        ),
      ]),
    );

    expect(report.counts.byDiscrepancy.extraction_failure_mismatch).toBe(1);
    expect(report.recommendation).toMatchObject({
      parser: 'poppler',
      state: 'approved',
    });
  });

  it('rejects malformed cast-as-any runtime inputs with validation errors', () => {
    expect(() =>
      comparePdfParserOutcomes({} as any),
    ).toThrow(/required|invalid|expected/i);
    expect(() =>
      aggregatePdfInspectorBacktest({
        comparisons: [null],
      } as any),
    ).toThrow(/required|invalid|expected|comparison/i);
  });
});

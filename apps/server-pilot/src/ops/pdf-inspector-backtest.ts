import { z } from 'zod';

export const PDF_BACKTEST_SCHEMA_VERSION = 1 as const;
export const PDF_BACKTEST_SCHEMA = 'pdf_inspector_backtest_v1' as const;
export const PDF_BACKTEST_PRIVATE_REVIEW_SCHEMA =
  'pdf_inspector_private_side_by_side_v1' as const;

export const PDF_BACKTEST_SCOPE_BUCKETS = [
  'full_corpus',
  'current_runtime_subset',
] as const;

export const PDF_BACKTEST_DISCREPANCY_CLASSES = [
  'equivalent',
  'inspector_better_candidate',
  'poppler_better_candidate',
  'status_mismatch',
  'extraction_failure_mismatch',
  'needs_ocr',
  'manual_unreadable',
] as const;

export const PDF_BACKTEST_ADJUDICATION_LABELS = [
  'equivalent',
  'inspector_better',
  'poppler_better',
  'both_insufficient',
  'needs_ocr',
  'unreadable',
] as const;

export const PDF_BACKTEST_LENGTH_BANDS = [
  'empty',
  'short',
  'medium',
  'long',
] as const;

export const PDF_BACKTEST_AGREEMENT_BANDS = [
  'unavailable',
  'exact',
  'high',
  'medium',
  'low',
  'none',
] as const;

export const PDF_BACKTEST_RATIONALE_CODES = [
  'normalized_match',
  'inspector_has_more_text',
  'poppler_has_more_text',
  'both_insufficient',
  'ocr_signal',
  'unreadable_both',
  'status_disagreement',
  'extraction_failure',
] as const;

export const PDF_BACKTEST_REASON_CODES = [
  'text',
  'no_embedded_text',
  'encrypted',
  'malformed',
  'too_large',
  'too_many_pages',
  'timeout',
  'parser_failure',
  'unsupported',
] as const;

type PdfBacktestScopeBucket = (typeof PDF_BACKTEST_SCOPE_BUCKETS)[number];
export type PdfBacktestDiscrepancyClass =
  (typeof PDF_BACKTEST_DISCREPANCY_CLASSES)[number];
export type PdfBacktestAdjudicationLabel =
  (typeof PDF_BACKTEST_ADJUDICATION_LABELS)[number];
export type PdfBacktestLengthBand = (typeof PDF_BACKTEST_LENGTH_BANDS)[number];
export type PdfBacktestAgreementBand =
  (typeof PDF_BACKTEST_AGREEMENT_BANDS)[number];
export type PdfBacktestRationaleCode =
  (typeof PDF_BACKTEST_RATIONALE_CODES)[number];

export type PdfParserStatus = 'ok' | 'manual_required';
export type PdfParserReason = (typeof PDF_BACKTEST_REASON_CODES)[number];
export type PdfInspectorPdfType =
  | 'TextBased'
  | 'Scanned'
  | 'ImageBased'
  | 'Mixed';

export type PdfInspectorDiagnostics = {
  pdfType: PdfInspectorPdfType | null;
  confidence: number | null;
  ocrPages: number[];
  tablePages: number[];
  columnPages: number[];
  hasEncodingIssues: boolean | null;
  isComplexLayout: boolean | null;
};

export type PdfPopplerParserOutcome = {
  parser: 'poppler';
  status: PdfParserStatus;
  reason: PdfParserReason;
  pageCount: number | null;
  text: string | null;
  markdown: string | null;
  elapsedMs: number;
  sourceRef: string;
};

export type PdfInspectorParserOutcome = {
  parser: 'inspector';
  status: PdfParserStatus;
  reason: PdfParserReason;
  pageCount: number | null;
  text: string | null;
  markdown: string | null;
  elapsedMs: number;
  diagnostics: PdfInspectorDiagnosticsInput;
  sourceRef: string;
};

export type PdfScopeMembership = {
  full_corpus: boolean;
  current_runtime_subset: boolean;
};

export type PdfInspectorDiagnosticsInput = {
  pdfType: PdfInspectorPdfType | null;
  confidence: number | null;
  ocrPages?: number[];
  tablePages?: number[];
  columnPages?: number[];
  pagesNeedingOcr?: number[];
  pagesWithTables?: number[];
  pagesWithColumns?: number[];
  hasEncodingIssues: boolean | null;
  isComplexLayout: boolean | null;
};

export type PdfParserOutcome =
  | PdfPopplerParserOutcome
  | PdfInspectorParserOutcome;

export type PdfPrivateAdjudication = {
  sourceRef: string;
  label: PdfBacktestAdjudicationLabel;
  rationaleCodes: PdfBacktestRationaleCode[];
};

export type PdfMarkdownStructureCounts = {
  headingCount: number;
  tableCount: number;
  linkCount: number;
  codeBlockCount: number;
  listItemCount: number;
  blockquoteCount: number;
  nonEmptyLineCount: number;
};

export type PdfPublicParserSummary = {
  status: PdfParserStatus;
  reason: PdfParserReason;
  pageCount: number | null;
  elapsedMs: number;
};

export type PdfComparisonRecord = {
  schemaVersion: typeof PDF_BACKTEST_SCHEMA_VERSION;
  scopeMembership: PdfScopeMembership;
  parsers: {
    poppler: PdfPublicParserSummary & { elapsedMs: number };
    inspector: PdfPublicParserSummary & { elapsedMs: number };
  };
  lengthBands: {
    poppler: PdfBacktestLengthBand;
    inspector: PdfBacktestLengthBand;
  };
  textAgreement: {
    band: PdfBacktestAgreementBand;
    routingSimilarity: number;
  };
  markdownStructure: {
    poppler: PdfMarkdownStructureCounts;
    inspector: PdfMarkdownStructureCounts;
  };
  inspectorDiagnostics: PdfInspectorDiagnostics;
  discrepancyClass: PdfBacktestDiscrepancyClass;
};

export type PdfPrivateComparison = {
  private: {
    sourceRef: string;
    poppler: PdfPopplerParserOutcome;
    inspector: PdfInspectorParserOutcome;
    adjudication?: PdfPrivateAdjudication;
  };
  aggregate: PdfComparisonRecord;
};

export type PdfInspectorPromotionProvenance = {
  backtestOnly: boolean;
  packageVersion: string;
  lopdfVersion: string;
  runtimeVerified: boolean;
  implementationFingerprint: {
    algorithm: 'sha256';
    value: string;
  };
};

const scopeMembershipSchema = z
  .object({
    full_corpus: z.boolean(),
    current_runtime_subset: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.full_corpus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['full_corpus'],
        message: 'eligible comparison must belong to full_corpus',
      });
    }
  });
const statusSchema = z.enum(['ok', 'manual_required']);
const reasonSchema = z.enum(PDF_BACKTEST_REASON_CODES);
const pageCountSchema = z.number().int().positive().nullable();
const elapsedMsSchema = z.number().int().nonnegative();
const sourceRefSchema = z.string().min(1).max(4096);
const nullableTextSchema = z.string().nullable();
const pdfTypeSchema = z
  .enum(['TextBased', 'Scanned', 'ImageBased', 'Mixed'])
  .nullable();
const confidenceSchema = z.number().finite().min(0).max(1).nullable();
const pageListSchema = z
  .array(z.number().int().positive())
  .max(10_000);

const inspectorDiagnosticsInputSchema = z
  .object({
    pdfType: pdfTypeSchema,
    confidence: confidenceSchema,
    ocrPages: pageListSchema.optional(),
    tablePages: pageListSchema.optional(),
    columnPages: pageListSchema.optional(),
    pagesNeedingOcr: pageListSchema.optional(),
    pagesWithTables: pageListSchema.optional(),
    pagesWithColumns: pageListSchema.optional(),
    hasEncodingIssues: z.boolean().nullable(),
    isComplexLayout: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [canonical, legacy] of [
      ['ocrPages', 'pagesNeedingOcr'],
      ['tablePages', 'pagesWithTables'],
      ['columnPages', 'pagesWithColumns'],
    ] as const) {
      if (value[canonical] && value[legacy]) {
        const left = JSON.stringify(value[canonical]);
        const right = JSON.stringify(value[legacy]);
        if (left !== right) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [canonical],
            message: `${canonical} and ${legacy} disagree`,
          });
        }
      }
    }
  });

const popplerPrivateOutcomeSchema = z
  .object({
    parser: z.literal('poppler'),
    status: statusSchema,
    reason: reasonSchema,
    pageCount: pageCountSchema,
    text: nullableTextSchema,
    markdown: nullableTextSchema,
    elapsedMs: elapsedMsSchema,
    sourceRef: sourceRefSchema,
  })
  .strict();

const inspectorPrivateOutcomeSchema = z
  .object({
    parser: z.literal('inspector'),
    status: statusSchema,
    reason: reasonSchema,
    pageCount: pageCountSchema,
    text: nullableTextSchema,
    markdown: nullableTextSchema,
    elapsedMs: elapsedMsSchema,
    diagnostics: inspectorDiagnosticsInputSchema,
    sourceRef: sourceRefSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pageCount === null) return;
    for (const field of [
      'ocrPages',
      'tablePages',
      'columnPages',
      'pagesNeedingOcr',
      'pagesWithTables',
      'pagesWithColumns',
    ] as const) {
      const pages = value.diagnostics[field];
      if (pages?.some((page) => page > value.pageCount!)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diagnostics', field],
          message: 'diagnostic page exceeds pageCount',
        });
      }
    }
  });

const compareInputSchema = z
  .object({
    scopeMembership: scopeMembershipSchema,
    sourceRef: sourceRefSchema,
    poppler: popplerPrivateOutcomeSchema,
    inspector: inspectorPrivateOutcomeSchema,
  })
  .strict();

const publicInspectorDiagnosticsSchema = z
  .object({
    pdfType: pdfTypeSchema,
    confidence: confidenceSchema,
    ocrPages: pageListSchema,
    tablePages: pageListSchema,
    columnPages: pageListSchema,
    hasEncodingIssues: z.boolean().nullable(),
    isComplexLayout: z.boolean().nullable(),
  })
  .strict();

const markdownStructureSchema = z
  .object({
    headingCount: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    linkCount: z.number().int().nonnegative(),
    codeBlockCount: z.number().int().nonnegative(),
    listItemCount: z.number().int().nonnegative(),
    blockquoteCount: z.number().int().nonnegative(),
    nonEmptyLineCount: z.number().int().nonnegative(),
  })
  .strict();

const publicParserSummarySchema = z
  .object({
    status: statusSchema,
    reason: reasonSchema,
    pageCount: pageCountSchema,
    elapsedMs: elapsedMsSchema,
  })
  .strict();

export const pdfComparisonRecordSchema = z
  .object({
    schemaVersion: z.literal(PDF_BACKTEST_SCHEMA_VERSION),
    scopeMembership: scopeMembershipSchema,
    parsers: z
      .object({
        poppler: publicParserSummarySchema,
        inspector: publicParserSummarySchema,
      })
      .strict(),
    lengthBands: z
      .object({
        poppler: z.enum(PDF_BACKTEST_LENGTH_BANDS),
        inspector: z.enum(PDF_BACKTEST_LENGTH_BANDS),
      })
      .strict(),
    textAgreement: z
      .object({
        band: z.enum(PDF_BACKTEST_AGREEMENT_BANDS),
        routingSimilarity: z.number().finite().min(0).max(1),
      })
      .strict(),
    markdownStructure: z
      .object({
        poppler: markdownStructureSchema,
        inspector: markdownStructureSchema,
      })
      .strict(),
    inspectorDiagnostics: publicInspectorDiagnosticsSchema,
    discrepancyClass: z.enum(PDF_BACKTEST_DISCREPANCY_CLASSES),
  })
  .strict();

const adjudicationSchema = z
  .object({
    sourceRef: sourceRefSchema,
    label: z.enum(PDF_BACKTEST_ADJUDICATION_LABELS),
    rationaleCodes: z
      .array(z.enum(PDF_BACKTEST_RATIONALE_CODES))
      .min(1)
      .max(PDF_BACKTEST_RATIONALE_CODES.length),
  })
  .strict();

const privateComparisonSchema = z
  .object({
    private: z
      .object({
        sourceRef: sourceRefSchema,
        poppler: popplerPrivateOutcomeSchema,
        inspector: inspectorPrivateOutcomeSchema,
        adjudication: adjudicationSchema.optional(),
      })
      .strict(),
    aggregate: pdfComparisonRecordSchema,
  })
  .strict();

const publicCountSchema = z.record(
  reasonSchema,
  z.number().int().nonnegative(),
);

const scopeDenominatorSchema = z
  .object({
    eligible: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
    unprocessed: z.number().int().nonnegative(),
  })
  .strict();

const percentileSchema = z
  .object({
    p50: z.number().int().nonnegative().nullable(),
    p95: z.number().int().nonnegative().nullable(),
  })
  .strict();

const safeVersionKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
const safeVersionValueSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const safeVersionMapSchema = z.record(
  safeVersionKeySchema,
  safeVersionValueSchema,
);
const packageVersionKeys = new Set(['pdfInspector', 'zod']);
const toolVersionKeys = new Set(['poppler', 'bwrap', 'prlimit', 'node']);
const implementationFingerprintSchema = z
  .object({
    algorithm: z.literal('sha256'),
    value: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const pdfInspectorProvenanceSchema = z
  .object({
    backtestOnly: z.boolean(),
    packageVersion: safeVersionValueSchema,
    lopdfVersion: safeVersionValueSchema,
    runtimeVerified: z.boolean(),
    implementationFingerprint: implementationFingerprintSchema,
  })
  .strict();

function knownVersionMapSchema(
  value: Record<string, string>,
  knownKeys: ReadonlySet<string>,
): Record<string, string> {
  const parsed = safeVersionMapSchema.parse(value);
  for (const key of Object.keys(parsed)) {
    if (!knownKeys.has(key)) {
      throw new Error(`PDF_BACKTEST_UNKNOWN_VERSION_KEY:${key}`);
    }
  }
  return parsed;
}

const gateInputSchema = z
  .object({
    adjudicationComplete: z.boolean(),
    safetyGatePassed: z.boolean(),
    promotionGatePassed: z.boolean(),
    explicitPromotionApproved: z.boolean(),
  })
  .strict();

const recommendationSchema = z
  .object({
    parser: z.enum(['poppler', 'inspector']),
    state: z.enum(['approved', 'blocked']),
    reasonCode: z.enum([
      'ADJUDICATION_INCOMPLETE',
      'SAFETY_GATE_INCOMPLETE',
      'PROMOTION_GATE_INCOMPLETE',
      'EXPLICIT_PROMOTION_REQUIRED',
      'EXPLICIT_PROMOTION_APPROVED',
      'INSPECTOR_PROVENANCE_UNSAFE',
      'POPLER_RETAINED',
    ]),
  })
  .strict();

export const pdfInspectorBacktestReportSchema = z
  .object({
    schema: z.literal(PDF_BACKTEST_SCHEMA),
    schemaVersion: z.literal(PDF_BACKTEST_SCHEMA_VERSION),
    scopeDenominators: z
      .object({
        full_corpus: scopeDenominatorSchema,
        current_runtime_subset: scopeDenominatorSchema,
      })
      .strict(),
    counts: z
      .object({
        byDiscrepancy: z
          .object({
            equivalent: z.number().int().nonnegative(),
            inspector_better_candidate: z.number().int().nonnegative(),
            poppler_better_candidate: z.number().int().nonnegative(),
            status_mismatch: z.number().int().nonnegative(),
            extraction_failure_mismatch: z.number().int().nonnegative(),
            needs_ocr: z.number().int().nonnegative(),
            manual_unreadable: z.number().int().nonnegative(),
          })
          .strict(),
        byAdjudication: z
          .object({
            equivalent: z.number().int().nonnegative(),
            inspector_better: z.number().int().nonnegative(),
            poppler_better: z.number().int().nonnegative(),
            both_insufficient: z.number().int().nonnegative(),
            needs_ocr: z.number().int().nonnegative(),
            unreadable: z.number().int().nonnegative(),
          })
          .strict(),
        byReason: z
          .object({
            poppler: publicCountSchema,
            inspector: publicCountSchema,
          })
          .strict(),
      })
      .strict(),
    timingsMs: z
      .object({
        poppler: percentileSchema,
        inspector: percentileSchema,
      })
      .strict(),
    packageVersions: safeVersionMapSchema,
    toolVersions: safeVersionMapSchema,
    gateInputs: gateInputSchema,
    recommendation: recommendationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    rejectForbiddenPublicKeys(value);
    for (const [field, knownKeys] of [
      ['packageVersions', packageVersionKeys],
      ['toolVersions', toolVersionKeys],
    ] as const) {
      for (const key of Object.keys(value[field])) {
        if (!knownKeys.has(key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, key],
            message: 'unknown version key',
          });
        }
      }
    }
    for (const scopeBucket of PDF_BACKTEST_SCOPE_BUCKETS) {
      const denominator = value.scopeDenominators[scopeBucket];
      if (
        denominator.unprocessed !==
        denominator.eligible - denominator.attempted
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopeDenominators', scopeBucket, 'unprocessed'],
          message: 'unprocessed denominator mismatch',
        });
      }
    }
  });

export type PdfInspectorBacktestReport = z.infer<
  typeof pdfInspectorBacktestReportSchema
>;

export function parsePdfInspectorProvenance(
  value: unknown,
): PdfInspectorPromotionProvenance {
  return pdfInspectorProvenanceSchema.parse(value);
}

const forbiddenPublicKeys = new Set([
  'sourceRef',
  'source_ref',
  's3Key',
  's3_key',
  'objectKey',
  'object_key',
  'hash',
  'sha256',
  'filename',
  'fileName',
  'messageId',
  'message_id',
  'rawText',
  'raw_text',
  'text',
  'markdown',
  'address',
  'parserStderr',
  'parser_stderr',
  'stderr',
  'identifier',
  'identifiers',
]);

function rejectForbiddenPublicKeys(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      rejectForbiddenPublicKeys(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    const isReasonCount =
      /^counts\.byReason\.(?:poppler|inspector)$/u.test(path) &&
      (PDF_BACKTEST_REASON_CODES as readonly string[]).includes(key);
    if (forbiddenPublicKeys.has(key) && !isReasonCount) {
      throw new Error(`FORBIDDEN_PUBLIC_FIELD:${nextPath}`);
    }
    rejectForbiddenPublicKeys(child, nextPath);
  }
}

function normalizeInspectorDiagnostics(
  input: PdfInspectorDiagnosticsInput,
): PdfInspectorDiagnostics {
  const normalizePages = (pages: number[]): number[] =>
    [...new Set(pages)].sort((left, right) => left - right);
  return {
    pdfType: input.pdfType,
    confidence: input.confidence,
    ocrPages: normalizePages(input.ocrPages ?? input.pagesNeedingOcr ?? []),
    tablePages: normalizePages(input.tablePages ?? input.pagesWithTables ?? []),
    columnPages: normalizePages(input.columnPages ?? input.pagesWithColumns ?? []),
    hasEncodingIssues: input.hasEncodingIssues,
    isComplexLayout: input.isComplexLayout,
  };
}

function normalizeComparableText(outcome: {
  text: string | null;
  markdown: string | null;
}): string {
  const raw =
    outcome.text && outcome.text.trim().length > 0
      ? outcome.text
      : outcome.markdown ?? outcome.text ?? '';
  return raw
    .normalize('NFKC')
    .replace(/^\uFEFF/u, '')
    .replaceAll('\u0000', '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function semanticTokenSet(value: string): Set<string> {
  return new Set(
    value
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(/\s+/u)
      .filter(Boolean),
  );
}

function semanticallyEquivalentForAdjudication(
  comparison: Pick<PdfPrivateComparison, 'private'>,
): boolean {
  const poppler = comparison.private.poppler;
  const inspector = comparison.private.inspector;
  if (
    poppler.status !== 'ok' ||
    inspector.status !== 'ok' ||
    poppler.reason !== 'text' ||
    inspector.reason !== 'text' ||
    poppler.pageCount !== inspector.pageCount
  ) {
    return false;
  }
  const left = semanticTokenSet(normalizeComparableText(poppler));
  const right = semanticTokenSet(normalizeComparableText(inspector));
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = new Set([...left, ...right]).size;
  return (
    shared / left.size >= 0.9 &&
    shared / right.size >= 0.9 &&
    shared / union >= 0.9
  );
}

export function normalizePdfComparisonText(raw: string | null): string {
  return normalizeComparableText({ text: raw, markdown: null });
}

function lengthBand(text: string): PdfBacktestLengthBand {
  if (text.length === 0) return 'empty';
  if (text.length <= 256) return 'short';
  if (text.length <= 2_048) return 'medium';
  return 'long';
}

function setJaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 && rightSet.size === 0) return 1;
  const union = new Set([...leftSet, ...rightSet]);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return union.size === 0 ? 1 : intersection / union.size;
}

function shingles(tokens: string[]): string[] {
  if (tokens.length < 2) return tokens;
  const result: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    result.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return result;
}

function textAgreement(
  left: string,
  right: string,
): PdfComparisonRecord['textAgreement'] {
  if (left.length === 0 && right.length === 0) {
    return { band: 'unavailable', routingSimilarity: 0 };
  }
  if (left === right) return { band: 'exact', routingSimilarity: 1 };

  const leftTokens = left.match(/[^\s]+/gu) ?? [];
  const rightTokens = right.match(/[^\s]+/gu) ?? [];
  const tokenSimilarity = setJaccard(leftTokens, rightTokens);
  const shingleSimilarity = setJaccard(
    shingles(leftTokens),
    shingles(rightTokens),
  );
  const routingSimilarity = Math.round(
    ((tokenSimilarity + shingleSimilarity) / 2) * 1_000,
  ) / 1_000;

  if (routingSimilarity >= 0.9) {
    return { band: 'high', routingSimilarity };
  }
  if (routingSimilarity >= 0.6) {
    return { band: 'medium', routingSimilarity };
  }
  if (routingSimilarity > 0) {
    return { band: 'low', routingSimilarity };
  }
  return { band: 'none', routingSimilarity };
}

function markdownStructure(
  outcome: { text: string | null; markdown: string | null },
): PdfMarkdownStructureCounts {
  const markdown =
    outcome.markdown && outcome.markdown.trim().length > 0
      ? outcome.markdown
      : outcome.text ?? outcome.markdown ?? '';
  const lines = markdown.split(/\r?\n/u);
  const nonEmptyLineCount = lines.filter((line) => line.trim().length > 0).length;
  const headingCount = lines.filter((line) => /^ {0,3}#{1,6}\s+/u.test(line)).length;
  const linkCount = markdown.match(/\[[^\]]+\]\([^)]+\)/gu)?.length ?? 0;
  const codeFenceCount = lines.filter((line) => /^\s*```/u.test(line)).length;
  const codeBlockCount = Math.floor(codeFenceCount / 2);
  const listItemCount = lines.filter((line) =>
    /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line),
  ).length;
  const blockquoteCount = lines.filter((line) => /^\s*>\s?/u.test(line)).length;
  let tableCount = 0;
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (
      /^\s*\|.*\|\s*$/u.test(lines[index]!) &&
      /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/u.test(lines[index + 1]!)
    ) {
      tableCount += 1;
    }
  }

  return {
    headingCount,
    tableCount,
    linkCount,
    codeBlockCount,
    listItemCount,
    blockquoteCount,
    nonEmptyLineCount,
  };
}

function extractionFailureReason(reason: string): boolean {
  return new Set([
    'parser_failure',
    'timeout',
    'malformed',
    'encrypted',
    'too_large',
    'too_many_pages',
    'unsupported',
  ]).has(reason);
}

function needsOcr(outcome: PdfInspectorParserOutcome): boolean {
  const diagnostics = normalizeInspectorDiagnostics(outcome.diagnostics);
  return (
    outcome.reason === 'no_embedded_text' ||
    diagnostics.ocrPages.length > 0 ||
    diagnostics.pdfType === 'Scanned' ||
    diagnostics.pdfType === 'ImageBased'
  );
}

function classifyComparison(
  poppler: PdfPopplerParserOutcome,
  inspector: PdfInspectorParserOutcome,
  popplerText: string,
  inspectorText: string,
  similarity: PdfComparisonRecord['textAgreement'],
): PdfBacktestDiscrepancyClass {
  if (needsOcr(inspector)) {
    return 'needs_ocr';
  }

  const popplerReadable = poppler.status === 'ok' && popplerText.length > 0;
  const inspectorReadable = inspector.status === 'ok' && inspectorText.length > 0;

  if (!popplerReadable && !inspectorReadable) {
    if (poppler.status !== inspector.status) {
      if (
        extractionFailureReason(poppler.reason) ||
        extractionFailureReason(inspector.reason)
      ) {
        return 'extraction_failure_mismatch';
      }
      return 'status_mismatch';
    }
    if (
      poppler.status === inspector.status &&
      poppler.reason !== inspector.reason
    ) {
      return 'status_mismatch';
    }
    return 'manual_unreadable';
  }

  if (poppler.status !== inspector.status) {
    if (
      extractionFailureReason(poppler.reason) ||
      extractionFailureReason(inspector.reason)
    ) {
      return 'extraction_failure_mismatch';
    }
    return 'status_mismatch';
  }

  if (!popplerReadable && inspectorReadable) {
    return 'inspector_better_candidate';
  }
  if (popplerReadable && !inspectorReadable) {
    return 'poppler_better_candidate';
  }
  if (
    similarity.band === 'exact' &&
    poppler.status === inspector.status &&
    poppler.reason === inspector.reason &&
    poppler.pageCount === inspector.pageCount
  ) {
    return 'equivalent';
  }

  // Similarity is routing evidence only. It is never semantic truth.
  if (inspectorText.length >= popplerText.length * 1.25) {
    return 'inspector_better_candidate';
  }
  if (popplerText.length >= inspectorText.length * 1.25) {
    return 'poppler_better_candidate';
  }
  return 'status_mismatch';
}

function assertAdjudicationCompatible(
  aggregate: PdfComparisonRecord,
  label: PdfBacktestAdjudicationLabel,
  comparison?: Pick<PdfPrivateComparison, 'private'>,
): void {
  const allowed: Record<PdfBacktestDiscrepancyClass, readonly PdfBacktestAdjudicationLabel[]> = {
    equivalent: ['equivalent'],
    inspector_better_candidate: ['inspector_better', 'poppler_better'],
    poppler_better_candidate: ['poppler_better', 'inspector_better'],
    status_mismatch: [
      'equivalent',
      'both_insufficient',
      'unreadable',
      'inspector_better',
      'poppler_better',
    ],
    extraction_failure_mismatch: [
      'both_insufficient',
      'unreadable',
      'inspector_better',
      'poppler_better',
    ],
    needs_ocr: ['needs_ocr', 'both_insufficient', 'unreadable'],
    manual_unreadable: ['both_insufficient', 'unreadable'],
  };
  if (!allowed[aggregate.discrepancyClass].includes(label)) {
    throw new Error('PDF_BACKTEST_INCOMPATIBLE_ADJUDICATION');
  }
  if (
    label === 'equivalent' &&
    aggregate.discrepancyClass !== 'equivalent' &&
    (!comparison || !semanticallyEquivalentForAdjudication(comparison))
  ) {
    throw new Error('PDF_BACKTEST_INCOMPATIBLE_ADJUDICATION');
  }
  if (
    [
      'status_mismatch',
      'extraction_failure_mismatch',
      'inspector_better_candidate',
      'poppler_better_candidate',
    ].includes(
      aggregate.discrepancyClass,
    ) &&
    ['inspector_better', 'poppler_better'].includes(label)
  ) {
    const winner =
      label === 'inspector_better'
        ? comparison?.private.inspector
        : comparison?.private.poppler;
    if (
      !winner ||
      winner.status !== 'ok' ||
      normalizeComparableText(winner).length === 0
    ) {
      throw new Error('PDF_BACKTEST_INCOMPATIBLE_ADJUDICATION');
    }
  }
}

export function comparePdfParserOutcomes(input: {
  scopeMembership: PdfScopeMembership;
  sourceRef: string;
  poppler: PdfPopplerParserOutcome;
  inspector: PdfInspectorParserOutcome;
}): PdfPrivateComparison {
  const parsedInput = compareInputSchema.parse(input);
  const parsedPoppler = parsedInput.poppler;
  const parsedInspector = parsedInput.inspector;
  if (
    parsedPoppler.sourceRef !== parsedInput.sourceRef ||
    parsedInspector.sourceRef !== parsedInput.sourceRef
  ) {
    throw new Error('PDF_BACKTEST_SOURCE_REF_MISMATCH');
  }
  const popplerText = normalizeComparableText(parsedPoppler);
  const inspectorText = normalizeComparableText(parsedInspector);
  const agreement = textAgreement(popplerText, inspectorText);
  const inspectorDiagnostics = normalizeInspectorDiagnostics(
    parsedInspector.diagnostics,
  );
  const aggregate = pdfComparisonRecordSchema.parse({
    schemaVersion: PDF_BACKTEST_SCHEMA_VERSION,
    scopeMembership: parsedInput.scopeMembership,
    parsers: {
      poppler: {
        status: parsedPoppler.status,
        reason: parsedPoppler.reason,
        pageCount: parsedPoppler.pageCount,
        elapsedMs: parsedPoppler.elapsedMs,
      },
      inspector: {
        status: parsedInspector.status,
        reason: parsedInspector.reason,
        pageCount: parsedInspector.pageCount,
        elapsedMs: parsedInspector.elapsedMs,
      },
    },
    lengthBands: {
      poppler: lengthBand(popplerText),
      inspector: lengthBand(inspectorText),
    },
    textAgreement: agreement,
    markdownStructure: {
      poppler: markdownStructure(parsedPoppler),
      inspector: markdownStructure(parsedInspector),
    },
    inspectorDiagnostics,
    discrepancyClass: classifyComparison(
      parsedPoppler,
      parsedInspector,
      popplerText,
      inspectorText,
      agreement,
    ),
  });

  return {
    private: {
      sourceRef: parsedInput.sourceRef,
      poppler: parsedPoppler,
      inspector: parsedInspector,
    },
    aggregate,
  };
}

export function withPdfAdjudication(
  comparison: PdfPrivateComparison,
  adjudication: {
    sourceRef: string;
    label: PdfBacktestAdjudicationLabel;
    rationaleCodes: readonly PdfBacktestRationaleCode[];
  },
): PdfPrivateComparison {
  const parsedComparison = privateComparisonSchemaParse(comparison);
  const parsedAdjudication = adjudicationSchema.parse(adjudication);
  if (parsedAdjudication.sourceRef !== parsedComparison.private.sourceRef) {
    throw new Error('PDF_BACKTEST_SOURCE_REF_MISMATCH');
  }
  assertAdjudicationCompatible(
    parsedComparison.aggregate,
    parsedAdjudication.label,
    parsedComparison,
  );
  return {
    private: {
      sourceRef: parsedComparison.private.sourceRef,
      poppler: parsedComparison.private.poppler,
      inspector: parsedComparison.private.inspector,
      adjudication: parsedAdjudication,
    },
    aggregate: parsedComparison.aggregate,
  };
}

function privateComparisonSchemaParse(
  comparison: unknown,
): PdfPrivateComparison {
  const parsed = privateComparisonSchema.parse(comparison);
  if (
    parsed.private.sourceRef !== parsed.private.poppler.sourceRef ||
    parsed.private.sourceRef !== parsed.private.inspector.sourceRef
  ) {
    throw new Error('PDF_BACKTEST_SOURCE_REF_MISMATCH');
  }
  const recomputed = comparePdfParserOutcomes({
    scopeMembership: parsed.aggregate.scopeMembership,
    sourceRef: parsed.private.sourceRef,
    poppler: parsed.private.poppler,
    inspector: parsed.private.inspector,
  });
  if (JSON.stringify(recomputed.aggregate) !== JSON.stringify(parsed.aggregate)) {
    throw new Error('PDF_BACKTEST_AGGREGATE_MISMATCH');
  }
  if (parsed.private.adjudication) {
    if (parsed.private.adjudication.sourceRef !== parsed.private.sourceRef) {
      throw new Error('PDF_BACKTEST_SOURCE_REF_MISMATCH');
    }
    assertAdjudicationCompatible(
      parsed.aggregate,
      parsed.private.adjudication.label,
      parsed,
    );
  }
  return {
    private: {
      sourceRef: parsed.private.sourceRef,
      poppler: parsed.private.poppler,
      inspector: parsed.private.inspector,
      ...(parsed.private.adjudication
        ? { adjudication: parsed.private.adjudication }
        : {}),
    },
    aggregate: parsed.aggregate,
  };
}

export function validatePdfPrivateComparison(
  comparison: unknown,
): PdfPrivateComparison {
  return privateComparisonSchemaParse(comparison);
}

export function renderPrivatePdfSideBySideReview(
  comparisons: readonly PdfPrivateComparison[],
): string {
  const parsed = z
    .array(privateComparisonSchema)
    .parse(comparisons)
    .map(privateComparisonSchemaParse);
  return JSON.stringify(
    {
      schema: PDF_BACKTEST_PRIVATE_REVIEW_SCHEMA,
      schemaVersion: PDF_BACKTEST_SCHEMA_VERSION,
      comparisons: parsed.map((comparison) => ({
        sourceRef: comparison.private.sourceRef,
        scopeMembership: comparison.aggregate.scopeMembership,
        poppler: comparison.private.poppler,
        inspector: comparison.private.inspector,
        ...(comparison.private.adjudication
          ? { adjudication: comparison.private.adjudication }
          : {}),
      })),
    },
    null,
    2,
  );
}

type PdfScopeDenominatorInput = {
  eligible: number;
  attempted: number;
};

type PdfBacktestGates = {
  adjudicationComplete: boolean;
  safetyGatePassed: boolean;
  promotionGatePassed: boolean;
  explicitPromotionApproved: boolean;
};

export type PdfInspectorBacktestReportInput = {
  comparisons: readonly PdfPrivateComparison[];
  scopeDenominators: {
    full_corpus: PdfScopeDenominatorInput;
    current_runtime_subset: PdfScopeDenominatorInput;
  };
  packageVersions: Record<string, string>;
  toolVersions: Record<string, string>;
  inspectorProvenance: PdfInspectorPromotionProvenance;
  gates: PdfBacktestGates;
};

const scopeDenominatorInputSchema = z
  .object({
    eligible: z.number().int().nonnegative(),
    attempted: z.number().int().nonnegative(),
  })
  .strict();

const reportInputSchema = z
  .object({
    comparisons: z.array(privateComparisonSchema),
    scopeDenominators: z
      .object({
        full_corpus: scopeDenominatorInputSchema,
        current_runtime_subset: scopeDenominatorInputSchema,
      })
      .strict(),
    packageVersions: safeVersionMapSchema,
    toolVersions: safeVersionMapSchema,
    inspectorProvenance: pdfInspectorProvenanceSchema,
    gates: gateInputSchema,
  })
  .strict();

function percentile(
  values: readonly number[],
  percentileValue: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

function emptyDiscrepancyCounts(): Record<PdfBacktestDiscrepancyClass, number> {
  return Object.fromEntries(
    PDF_BACKTEST_DISCREPANCY_CLASSES.map((value) => [value, 0]),
  ) as Record<PdfBacktestDiscrepancyClass, number>;
}

function emptyAdjudicationCounts(): Record<PdfBacktestAdjudicationLabel, number> {
  return Object.fromEntries(
    PDF_BACKTEST_ADJUDICATION_LABELS.map((value) => [value, 0]),
  ) as Record<PdfBacktestAdjudicationLabel, number>;
}

function emptyReasonCounts(): Record<string, number> {
  return Object.fromEntries(PDF_BACKTEST_REASON_CODES.map((value) => [value, 0]));
}

function validateScopeDenominators(
  input: PdfInspectorBacktestReportInput['scopeDenominators'],
  comparisons: readonly PdfPrivateComparison[],
): PdfInspectorBacktestReport['scopeDenominators'] {
  const counts = {
    full_corpus: 0,
    current_runtime_subset: 0,
  } satisfies Record<PdfBacktestScopeBucket, number>;
  for (const comparison of comparisons) {
    for (const scopeBucket of PDF_BACKTEST_SCOPE_BUCKETS) {
      if (comparison.aggregate.scopeMembership[scopeBucket]) {
        counts[scopeBucket] += 1;
      }
    }
  }

  const result = {} as PdfInspectorBacktestReport['scopeDenominators'];
  for (const scopeBucket of PDF_BACKTEST_SCOPE_BUCKETS) {
    const denominator = input[scopeBucket];
    if (
      !Number.isInteger(denominator.eligible) ||
      !Number.isInteger(denominator.attempted) ||
      denominator.eligible < 0 ||
      denominator.attempted < 0 ||
      denominator.attempted > denominator.eligible ||
      counts[scopeBucket] !== denominator.attempted
    ) {
      throw new Error('PDF_BACKTEST_INVALID_DENOMINATOR');
    }
    result[scopeBucket] = {
      eligible: denominator.eligible,
      attempted: denominator.attempted,
      unprocessed: denominator.eligible - denominator.attempted,
    };
  }
  return result;
}

function recommendationFor(
  comparisons: readonly PdfPrivateComparison[],
  gates: PdfBacktestGates,
  provenance: PdfInspectorPromotionProvenance,
): PdfInspectorBacktestReport['recommendation'] {
  const adjudications: PdfPrivateAdjudication[] = [];
  for (const comparison of comparisons) {
    const parsed = privateComparisonSchemaParse(comparison);
    if (parsed.private.adjudication) {
      adjudications.push(parsed.private.adjudication);
    }
  }

  if (
    !gates.adjudicationComplete ||
    adjudications.length !== comparisons.length
  ) {
    return {
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'ADJUDICATION_INCOMPLETE',
    };
  }
  if (!gates.safetyGatePassed) {
    return {
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'SAFETY_GATE_INCOMPLETE',
    };
  }
  if (!gates.promotionGatePassed) {
    return {
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'PROMOTION_GATE_INCOMPLETE',
    };
  }
  if (!gates.explicitPromotionApproved) {
    return {
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'EXPLICIT_PROMOTION_REQUIRED',
    };
  }
  if (
    provenance.backtestOnly ||
    !provenance.runtimeVerified ||
    !isAtLeastVersion(provenance.lopdfVersion, '0.42.0')
  ) {
    return {
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'INSPECTOR_PROVENANCE_UNSAFE',
    };
  }

  const inspectorCandidates = adjudications.filter(
    (adjudication) => adjudication.label === 'inspector_better',
  ).length;
  const popplerCandidates = adjudications.filter(
    (adjudication) => adjudication.label === 'poppler_better',
  ).length;
  const unsafeForInspector = adjudications.some((adjudication) =>
    ['both_insufficient', 'needs_ocr', 'unreadable'].includes(
      adjudication.label,
    ),
  );

  if (inspectorCandidates > popplerCandidates && !unsafeForInspector) {
    return {
      parser: 'inspector',
      state: 'approved',
      reasonCode: 'EXPLICIT_PROMOTION_APPROVED',
    };
  }
  return {
    parser: 'poppler',
    state: 'approved',
    reasonCode: 'POPLER_RETAINED',
  };
}

function isAtLeastVersion(actual: string, minimum: string): boolean {
  const parse = (value: string): { numbers: number[]; prerelease: boolean } => {
    const [base, prerelease] = value.split('-', 2);
    return {
      numbers: base!.split('.').map((part) => Number(part)),
      prerelease: prerelease !== undefined,
    };
  };
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index]! !== right.numbers[index]!) {
      return left.numbers[index]! > right.numbers[index]!;
    }
  }
  return !(left.prerelease && !right.prerelease);
}

export function aggregatePdfInspectorBacktest(
  input: PdfInspectorBacktestReportInput,
): PdfInspectorBacktestReport {
  const parsedInput = reportInputSchema.parse(input);
  const comparisons = parsedInput.comparisons.map(privateComparisonSchemaParse);
  const seenRefs = new Set<string>();
  for (const comparison of comparisons) {
    if (seenRefs.has(comparison.private.sourceRef)) {
      throw new Error('PDF_BACKTEST_DUPLICATE_SOURCE_REF');
    }
    seenRefs.add(comparison.private.sourceRef);
  }
  const scopeDenominators = validateScopeDenominators(
    parsedInput.scopeDenominators,
    comparisons,
  );
  const packageVersions = knownVersionMapSchema(
    parsedInput.packageVersions,
    packageVersionKeys,
  );
  const toolVersions = knownVersionMapSchema(
    parsedInput.toolVersions,
    toolVersionKeys,
  );
  const gates = parsedInput.gates;
  const popplerTimings = comparisons.map(
    (comparison) => comparison.private.poppler.elapsedMs,
  );
  const inspectorTimings = comparisons.map(
    (comparison) => comparison.private.inspector.elapsedMs,
  );

  const byDiscrepancy = emptyDiscrepancyCounts();
  const byAdjudication = emptyAdjudicationCounts();
  const byReason = {
    poppler: emptyReasonCounts(),
    inspector: emptyReasonCounts(),
  };

  for (const comparison of comparisons) {
    const aggregate = comparison.aggregate;
    byDiscrepancy[aggregate.discrepancyClass] += 1;
    byReason.poppler[aggregate.parsers.poppler.reason] =
      (byReason.poppler[aggregate.parsers.poppler.reason] ?? 0) + 1;
    byReason.inspector[aggregate.parsers.inspector.reason] =
      (byReason.inspector[aggregate.parsers.inspector.reason] ?? 0) + 1;

    if (comparison.private.adjudication) {
      byAdjudication[comparison.private.adjudication.label] += 1;
    }
  }

  return pdfInspectorBacktestReportSchema.parse({
    schema: PDF_BACKTEST_SCHEMA,
    schemaVersion: PDF_BACKTEST_SCHEMA_VERSION,
    scopeDenominators,
    counts: {
      byDiscrepancy,
      byAdjudication,
      byReason,
    },
    timingsMs: {
      poppler: {
        p50: percentile(popplerTimings, 50),
        p95: percentile(popplerTimings, 95),
      },
      inspector: {
        p50: percentile(inspectorTimings, 50),
        p95: percentile(inspectorTimings, 95),
      },
    },
    packageVersions,
    toolVersions,
    gateInputs: gates,
    recommendation: recommendationFor(
      comparisons,
      gates,
      parsedInput.inspectorProvenance,
    ),
  });
}

export function parsePdfInspectorBacktestReport(
  value: unknown,
): PdfInspectorBacktestReport {
  rejectForbiddenPublicKeys(value);
  return pdfInspectorBacktestReportSchema.parse(value);
}

export function validatePdfInspectorBacktestReport(
  value: unknown,
): PdfInspectorBacktestReport {
  return parsePdfInspectorBacktestReport(value);
}

export function renderPdfInspectorAggregateReport(
  value: unknown,
): string {
  return JSON.stringify(parsePdfInspectorBacktestReport(value));
}

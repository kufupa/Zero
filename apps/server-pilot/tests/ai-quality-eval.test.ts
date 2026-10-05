import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ModelAdapter, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import {
  buildAllInboundExportCases,
  buildLabelScopedExportCases,
  buildTargetsExportCases,
  compareQualityReports,
  hashQualitySource,
  parseQualityExportArgs,
  parseQualityLabelsJsonl,
  qualityLabelSchema,
  runQualityEval,
  type QualityEvalReport,
  type QualityInputCase,
  type QualityLabel,
} from '../src/ai/quality-eval.js';
import type { TriageMessageRow } from '../src/ai/triage-input.js';
import { DEFAULT_TRIAGE_PROMPT_VERSION } from '../src/ai/run-ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL_ID = 'amazon.nova-lite-v1:0';
const AS_OF = '2026-07-01T12:00:00.000Z';

function usage(partial?: Partial<ModelInvokeResult['usage']>): ModelInvokeResult['usage'] {
  return {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    latencyMs: 25,
    estimatedCostUsd: 0.0001,
    rateTableVersion: 'nova-lite-v1-2026-07',
    ...partial,
  };
}

function row(
  partial: Partial<TriageMessageRow> & Pick<TriageMessageRow, 'id' | 'createdAt'>,
): TriageMessageRow {
  return {
    from: partial.from ?? `${partial.id}@example.com`,
    subject: partial.subject ?? `subject-${partial.id}`,
    body: partial.body ?? `body-${partial.id}`,
    direction: partial.direction ?? 'inbound',
    receivedAt: partial.receivedAt ?? null,
    sentAt: partial.sentAt ?? null,
    ...partial,
  };
}

function label(partial: Partial<QualityLabel> & Pick<QualityLabel, 'triggerMessageId' | 'expectedCategory'>): QualityLabel {
  return qualityLabelSchema.parse({
    triggerMessageId: partial.triggerMessageId,
    asOf: partial.asOf ?? AS_OF,
    asOfSource: partial.asOfSource ?? 'message-created-at',
    expectedCategory: partial.expectedCategory,
    expectedUrgent: partial.expectedUrgent ?? false,
    evidenceScope: partial.evidenceScope ?? 'text-visible',
    adjudication: partial.adjudication ?? 'locked',
    policyReason: partial.policyReason ?? 'test-label',
    tags: partial.tags ?? [],
  });
}

function inputCase(
  partial: Partial<QualityInputCase> & Pick<QualityInputCase, 'triggerMessageId' | 'messages'>,
): QualityInputCase {
  return {
    transportId: partial.transportId ?? 'transport-centurion',
    threadId: partial.threadId ?? 'thread-1',
    triggerMessageId: partial.triggerMessageId,
    asOf: partial.asOf ?? AS_OF,
    asOfSource: partial.asOfSource ?? 'message-created-at',
    modelId: partial.modelId ?? MODEL_ID,
    promptVersion: partial.promptVersion ?? DEFAULT_TRIAGE_PROMPT_VERSION,
    messages: partial.messages,
  };
}

function fixedAdapter(output: Record<string, unknown>, opts?: { throw?: Error }): ModelAdapter {
  return {
    async invoke() {
      if (opts?.throw) throw opts.throw;
      return {
        modelId: MODEL_ID,
        output,
        usage: usage(),
      };
    },
  };
}

function triageOut(partial: {
  category: string;
  urgent?: boolean;
  confidence?: number;
  rationale?: string;
}): Record<string, unknown> {
  return {
    category: partial.category,
    urgent: partial.urgent ?? false,
    confidence: partial.confidence ?? 0.99,
    rationale: partial.rationale ?? 'fixed',
    policyFlags: [],
  };
}

describe('quality label contract', () => {
  it('accepts locked text-visible label with required fields', () => {
    const parsed = qualityLabelSchema.parse({
      triggerMessageId: 'm1',
      asOf: AS_OF,
      asOfSource: 'normal-run-created-at',
      expectedCategory: 'ops',
      expectedUrgent: true,
      evidenceScope: 'text-visible',
      adjudication: 'locked',
      policyReason: 'hard SLA today',
      tags: ['urgency', 'integration'],
    });
    expect(parsed.expectedCategory).toBe('ops');
  });
});

describe('synthetic quality gold JSONL', () => {
  const fixturePath = join(here, 'fixtures', 'triage-gold-synthetic.jsonl');
  const validLabelLine = JSON.stringify({
    triggerMessageId: 'synthetic-parser-valid-001',
    asOf: AS_OF,
    asOfSource: 'message-created-at',
    expectedCategory: 'ops',
    expectedUrgent: false,
    evidenceScope: 'text-visible',
    adjudication: 'locked',
    policyReason: 'Synthetic parser test label',
    tags: [],
  });

  function parserError(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected parser to throw');
  }

  it('parses every fixture record and permits no or one final newline', () => {
    const jsonl = readFileSync(fixturePath, 'utf8');
    const lines = jsonl.split(/\r?\n/);
    const expected = lines.slice(0, -1).map((line) => qualityLabelSchema.parse(JSON.parse(line)));

    expect(jsonl.endsWith('\n')).toBe(true);
    expect(lines.at(-1)).toBe('');
    expect(parseQualityLabelsJsonl(jsonl)).toEqual(expected);
    expect(parseQualityLabelsJsonl(validLabelLine)).toHaveLength(1);
    expect(parseQualityLabelsJsonl(`${validLabelLine}\n`)).toHaveLength(1);
    expect(parseQualityLabelsJsonl(`${validLabelLine}\r\n`)).toHaveLength(1);
  });

  it('rejects a bare carriage-return terminator', () => {
    const error = parserError(() => parseQualityLabelsJsonl(`${validLabelLine}\r`));

    expect(error).toMatch(/invalid.*terminator/i);
  });

  it('rejects malformed JSON and schema lines without echoing source text', () => {
    const malformed = '{"triggerMessageId":"do-not-echo-json-content"';
    const invalidSchema = JSON.stringify({
      triggerMessageId: 'synthetic-parser-invalid-002',
      asOf: AS_OF,
      asOfSource: 'message-created-at',
      expectedCategory: 'not-a-category',
      expectedUrgent: false,
      evidenceScope: 'text-visible',
      adjudication: 'locked',
      policyReason: 'do-not-echo-schema-content',
      tags: [],
    });
    const extraField = JSON.stringify({
      triggerMessageId: 'synthetic-parser-extra-003',
      asOf: AS_OF,
      asOfSource: 'message-created-at',
      expectedCategory: 'ops',
      expectedUrgent: false,
      evidenceScope: 'text-visible',
      adjudication: 'locked',
      policyReason: 'valid fields plus an unexpected key',
      tags: [],
      unexpected: 'do-not-echo-extra-field',
    });

    const malformedError = parserError(() => parseQualityLabelsJsonl(malformed));
    expect(malformedError).toMatch(/invalid JSON.*line 1/i);
    expect(malformedError).not.toContain('do-not-echo-json-content');

    const schemaError = parserError(() => parseQualityLabelsJsonl(invalidSchema));
    expect(schemaError).toMatch(/invalid quality label.*line 1/i);
    expect(schemaError).not.toContain('do-not-echo-schema-content');

    const extraFieldError = parserError(() => parseQualityLabelsJsonl(extraField));
    expect(extraFieldError).toMatch(/invalid quality label.*line 1/i);
    expect(extraFieldError).not.toContain('do-not-echo-extra-field');
  });

  it('rejects interior blank lines', () => {
    const error = parserError(() =>
      parseQualityLabelsJsonl(`${validLabelLine}\n\n${validLabelLine}`),
    );

    expect(error).toMatch(/blank.*line 2/i);
  });

  it('rejects extra terminal blank lines', () => {
    const error = parserError(() => parseQualityLabelsJsonl(`${validLabelLine}\n\n`));

    expect(error).toMatch(/blank.*line 2/i);
  });
});

describe('runQualityEval', () => {
  it('high-confidence wrong prediction stays wrong in exact counts', async () => {
    const messages = [row({ id: 'm1', createdAt: new Date('2026-07-01T10:00:00.000Z'), body: 'group RFQ 20 rooms' })];
    const report = await runQualityEval(
      {
        repeatId: 'baseline-1',
        inputs: [inputCase({ triggerMessageId: 'm1', messages })],
        labels: [label({ triggerMessageId: 'm1', expectedCategory: 'groups-events' })],
      },
      fixedAdapter(triageOut({ category: 'spam', confidence: 0.999 })),
    );

    expect(report.metrics.categoryErrors).toBe(1);
    expect(report.metrics.jointErrors).toBe(1);
    expect(report.cases[0]?.categoryMatch).toBe(false);
    expect(report.cases[0]?.confidence).toBe(0.999);
    expect(report.complete).toBe(true);
  });

  it('marks invalid JSON, schema, adapter, and missing trigger as incomplete', async () => {
    const baseMsg = row({ id: 'm-ok', createdAt: new Date('2026-07-01T10:00:00.000Z') });
    const cases: Array<{
      id: string;
      adapter: ModelAdapter;
      messages: TriageMessageRow[];
      triggerMessageId: string;
    }> = [
      {
        id: 'bad-json',
        triggerMessageId: 'm-json',
        messages: [row({ id: 'm-json', createdAt: new Date('2026-07-01T10:00:00.000Z') })],
        adapter: {
          async invoke() {
            return { modelId: MODEL_ID, output: { not: 'triage' }, usage: usage() };
          },
        },
      },
      {
        id: 'bad-schema',
        triggerMessageId: 'm-schema',
        messages: [row({ id: 'm-schema', createdAt: new Date('2026-07-01T10:00:00.000Z') })],
        adapter: fixedAdapter({
          category: 'not-a-real-category',
          urgent: false,
          confidence: 0.9,
          rationale: 'x',
          policyFlags: [],
        }),
      },
      {
        id: 'adapter-fail',
        triggerMessageId: 'm-adapter',
        messages: [row({ id: 'm-adapter', createdAt: new Date('2026-07-01T10:00:00.000Z') })],
        adapter: fixedAdapter(triageOut({ category: 'ops' }), {
          throw: new Error('bedrock down'),
        }),
      },
      {
        id: 'missing-trigger',
        triggerMessageId: 'm-missing',
        messages: [baseMsg],
        adapter: fixedAdapter(triageOut({ category: 'ops' })),
      },
    ];

    for (const c of cases) {
      const report = await runQualityEval(
        {
          repeatId: 'inj',
          inputs: [inputCase({ triggerMessageId: c.triggerMessageId, messages: c.messages })],
          labels: [label({ triggerMessageId: c.triggerMessageId, expectedCategory: 'ops' })],
        },
        c.adapter,
      );
      expect(report.complete, c.id).toBe(false);
      expect(report.metrics.incompleteCases, c.id).toBe(1);
      expect(report.cases[0]?.status, c.id).toBe('incomplete');
      expect(report.cases[0]?.incompleteReason, c.id).toMatch(/json|schema|adapter|trigger/i);
    }
  });

  it('fails on duplicate or unmatched trigger IDs', async () => {
    const messages = [row({ id: 'm1', createdAt: new Date('2026-07-01T10:00:00.000Z') })];
    const adapter = fixedAdapter(triageOut({ category: 'ops' }));

    await expect(
      runQualityEval(
        {
          repeatId: 'dup',
          inputs: [
            inputCase({ triggerMessageId: 'm1', messages }),
            inputCase({ triggerMessageId: 'm1', messages, threadId: 'thread-2' }),
          ],
          labels: [label({ triggerMessageId: 'm1', expectedCategory: 'ops' })],
        },
        adapter,
      ),
    ).rejects.toThrow(/duplicate/i);

    await expect(
      runQualityEval(
        {
          repeatId: 'unmatched-input',
          inputs: [inputCase({ triggerMessageId: 'm1', messages })],
          labels: [label({ triggerMessageId: 'm2', expectedCategory: 'ops' })],
        },
        adapter,
      ),
    ).rejects.toThrow(/unmatched|missing label|missing input/i);

    await expect(
      runQualityEval(
        {
          repeatId: 'unmatched-label',
          inputs: [inputCase({ triggerMessageId: 'm1', messages })],
          labels: [
            label({ triggerMessageId: 'm1', expectedCategory: 'ops' }),
            label({ triggerMessageId: 'm2', expectedCategory: 'ops' }),
          ],
        },
        adapter,
      ),
    ).rejects.toThrow(/unmatched|missing input/i);
  });

  it('excludes attachment-informed from primary text-visible counts only', async () => {
    const t0 = new Date('2026-07-01T10:00:00.000Z');
    const report = await runQualityEval(
      {
        repeatId: 'attach',
        inputs: [
          inputCase({
            triggerMessageId: 'm-text',
            messages: [row({ id: 'm-text', createdAt: t0, body: 'ops handover' })],
          }),
          inputCase({
            triggerMessageId: 'm-attach',
            messages: [row({ id: 'm-attach', createdAt: t0, body: 'see pdf' })],
          }),
        ],
        labels: [
          label({ triggerMessageId: 'm-text', expectedCategory: 'ops' }),
          label({
            triggerMessageId: 'm-attach',
            expectedCategory: 'groups-events',
            evidenceScope: 'attachment-informed',
          }),
        ],
      },
      {
        async invoke(req) {
          const isAttach = req.userPrompt.includes('m-attach');
          return {
            modelId: MODEL_ID,
            output: triageOut({
              category: isAttach ? 'spam' : 'ops',
              confidence: 0.95,
            }),
            usage: usage(),
          };
        },
      },
    );

    expect(report.metrics.primaryTextVisibleCases).toBe(1);
    expect(report.metrics.attachmentInformedCases).toBe(1);
    expect(report.metrics.categoryErrors).toBe(0);
    expect(report.cases.find((c) => c.triggerMessageId === 'm-attach')?.categoryMatch).toBe(false);
  });

  it('handles zero-support classes without NaN F1', async () => {
    const report = await runQualityEval(
      {
        repeatId: 'zero-support',
        inputs: [
          inputCase({
            triggerMessageId: 'm1',
            messages: [row({ id: 'm1', createdAt: new Date('2026-07-01T10:00:00.000Z'), body: 'ops' })],
          }),
        ],
        labels: [label({ triggerMessageId: 'm1', expectedCategory: 'ops' })],
      },
      fixedAdapter(triageOut({ category: 'ops' })),
    );

    for (const cat of ['new-bookings', 'groups-events', 'at-risk', 'ops', 'spam'] as const) {
      const m = report.metrics.perCategory[cat];
      expect(m, cat).toBeDefined();
      expect(Number.isFinite(m!.precision), cat).toBe(true);
      expect(Number.isFinite(m!.recall), cat).toBe(true);
      expect(Number.isFinite(m!.f1), cat).toBe(true);
      if (cat !== 'ops') {
        expect(m!.support).toBe(0);
        expect(m!.f1).toBe(0);
      }
    }
  });

  it('records hashes, tokens, latency, cost, and protected regressions', async () => {
    const messages = [
      row({
        id: 'm1',
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        body: 'cancel booking today SLA',
        subject: 'URGENT cancel',
      }),
    ];
    const report = await runQualityEval(
      {
        repeatId: 'meta',
        inputs: [inputCase({ triggerMessageId: 'm1', messages })],
        labels: [
          label({
            triggerMessageId: 'm1',
            expectedCategory: 'at-risk',
            expectedUrgent: true,
            tags: ['urgency'],
          }),
        ],
      },
      fixedAdapter(triageOut({ category: 'spam', urgent: false, confidence: 0.99 })),
    );

    expect(report.cases[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.cases[0]?.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.cases[0]?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.metrics.totalInputTokens).toBeGreaterThan(0);
    expect(report.metrics.totalEstimatedCostUsd).toBeGreaterThan(0);
    expect(report.metrics.avgLatencyMs).toBeGreaterThan(0);
    expect(report.protectedRegressions.length).toBeGreaterThan(0);
    expect(report.protectedRegressions.some((r) => /spam|at-risk|urgent|urgency/i.test(r.reason))).toBe(true);
  });

  it('passes input prompt version through to workflow hashes', async () => {
    const messages = [row({ id: 'm-version', createdAt: new Date('2026-07-01T10:00:00.000Z') })];
    const adapter = fixedAdapter(triageOut({ category: 'ops' }));

    const v5 = await runQualityEval(
      {
        repeatId: 'prompt-v5',
        inputs: [inputCase({ triggerMessageId: 'm-version', promptVersion: 'triage-v5', messages })],
        labels: [label({ triggerMessageId: 'm-version', expectedCategory: 'ops' })],
      },
      adapter,
    );
    const v6 = await runQualityEval(
      {
        repeatId: 'prompt-v6',
        inputs: [inputCase({ triggerMessageId: 'm-version', promptVersion: 'triage-v6', messages })],
        labels: [label({ triggerMessageId: 'm-version', expectedCategory: 'ops' })],
      },
      adapter,
    );

    expect(v5.cases[0]?.promptHash).not.toBe(v6.cases[0]?.promptHash);
    expect(v5.cases[0]?.inputHash).not.toBe(v6.cases[0]?.inputHash);
    expect(v5.cases[0]?.actualCategory).toBe(v6.cases[0]?.actualCategory);
    expect(v5.metrics.categoryErrors).toBe(v6.metrics.categoryErrors);
    expect(v5.metrics.urgentErrors).toBe(v6.metrics.urgentErrors);
    expect(v5.metrics.jointErrors).toBe(v6.metrics.jointErrors);
  });

  it('does not branch scoring on confidence', async () => {
    const messages = [row({ id: 'm1', createdAt: new Date('2026-07-01T10:00:00.000Z'), body: 'ops' })];
    const low = await runQualityEval(
      {
        repeatId: 'conf-low',
        inputs: [inputCase({ triggerMessageId: 'm1', messages })],
        labels: [label({ triggerMessageId: 'm1', expectedCategory: 'ops' })],
      },
      fixedAdapter(triageOut({ category: 'ops', confidence: 0.01 })),
    );
    const high = await runQualityEval(
      {
        repeatId: 'conf-high',
        inputs: [inputCase({ triggerMessageId: 'm1', messages })],
        labels: [label({ triggerMessageId: 'm1', expectedCategory: 'ops' })],
      },
      fixedAdapter(triageOut({ category: 'ops', confidence: 0.99 })),
    );
    expect(low.metrics.categoryErrors).toBe(high.metrics.categoryErrors);
    expect(low.metrics.jointErrors).toBe(high.metrics.jointErrors);

    const src = readFileSync(join(here, '../src/ai/quality-eval.ts'), 'utf8');
    expect(src).not.toMatch(/if\s*\(.*confidence/);
    expect(src).not.toMatch(/confidence\s*[><=]/);
  });

  it('evaluator source never imports durable apply or DB writes', () => {
    const src = readFileSync(join(here, '../src/ai/quality-eval.ts'), 'utf8');
    expect(src).not.toMatch(/applyDurableTriageResult|applyDurableTriageFromWorker/);
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(src).not.toMatch(/from ['"].*db\/client/);
  });
});

describe('compareQualityReports', () => {
  function miniReport(
    repeatId: string,
    counts: { categoryErrors: number; urgentErrors: number; jointErrors: number },
    cases: QualityEvalReport['cases'],
    protectedRegressions: QualityEvalReport['protectedRegressions'] = [],
  ): QualityEvalReport {
    return {
      mode: 'quality',
      repeatId,
      modelId: MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
      promptHash: 'p'.repeat(64),
      complete: true,
      metrics: {
        totalCases: cases.length,
        completeCases: cases.length,
        incompleteCases: 0,
        primaryTextVisibleCases: cases.length,
        attachmentInformedCases: 0,
        categoryErrors: counts.categoryErrors,
        urgentErrors: counts.urgentErrors,
        jointErrors: counts.jointErrors,
        categoryAccuracy: 1,
        perCategory: {},
        confusion: {},
        totalInputTokens: 1,
        totalOutputTokens: 1,
        totalEstimatedCostUsd: 0.001,
        avgLatencyMs: 10,
      },
      cases,
      protectedRegressions,
      failures: [],
    };
  }

  it('pairs baseline best versus candidate worst with stable case IDs/source hashes', () => {
    const sourceHash = createHash('sha256').update('case-m1').digest('hex');
    const caseOk = {
      caseId: 'm1',
      triggerMessageId: 'm1',
      sourceHash,
      status: 'complete' as const,
      evidenceScope: 'text-visible' as const,
      adjudication: 'locked' as const,
      expectedCategory: 'ops' as const,
      expectedUrgent: false,
      actualCategory: 'ops' as const,
      actualUrgent: false,
      categoryMatch: true,
      urgentMatch: true,
      jointMatch: true,
    };
    const caseWrong = { ...caseOk, actualCategory: 'spam' as const, categoryMatch: false, jointMatch: false };

    const baselineA = miniReport('b1', { categoryErrors: 2, urgentErrors: 1, jointErrors: 2 }, [caseWrong]);
    const baselineB = miniReport('b2', { categoryErrors: 1, urgentErrors: 0, jointErrors: 1 }, [caseOk]);
    const candidateA = miniReport('c1', { categoryErrors: 1, urgentErrors: 0, jointErrors: 0 }, [caseOk]);
    const candidateB = miniReport('c2', { categoryErrors: 1, urgentErrors: 1, jointErrors: 1 }, [caseOk]);

    const paired = compareQualityReports({
      baseline: [baselineA, baselineB],
      candidate: [candidateA, candidateB],
    });

    expect(paired.baselineBest.categoryErrors).toBe(1);
    expect(paired.baselineBest.urgentErrors).toBe(0);
    expect(paired.baselineBest.jointErrors).toBe(1);
    expect(paired.candidateWorst.categoryErrors).toBe(1);
    expect(paired.candidateWorst.urgentErrors).toBe(1);
    expect(paired.candidateWorst.jointErrors).toBe(1);
    expect(paired.eligible).toBe(false);
    expect(paired.caseIds).toContain('m1');
    expect(paired.sourceHashes).toContain(sourceHash);
  });
});

describe('export-centurion-triage-quality', () => {
  const t0 = new Date('2026-07-01T10:00:00.000Z');
  const t1 = new Date('2026-07-01T11:00:00.000Z');
  const t2 = new Date('2026-07-01T12:00:00.000Z');
  const threadMessages = [
    row({ id: 'in-1', createdAt: t0, direction: 'inbound', body: 'first inbound' }),
    row({ id: 'out-1', createdAt: t1, direction: 'outbound', body: 'hotel reply' }),
    row({ id: 'in-2', createdAt: t2, direction: 'inbound', body: 'second inbound' }),
  ];

  it('emits every inbound once as trigger, keeps earlier outbound context, never outbound triggers or later leak', () => {
    const exported = buildAllInboundExportCases({
      transportId: 'transport-centurion',
      threadId: 'th-1',
      messages: threadMessages,
      asOfByTriggerId: {
        'in-1': { asOf: '2026-07-01T10:00:00.000Z', asOfSource: 'message-created-at' },
        'in-2': { asOf: '2026-07-01T12:00:00.000Z', asOfSource: 'normal-run-created-at' },
      },
      modelId: MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
    });

    expect(exported.map((c) => c.triggerMessageId)).toEqual(['in-1', 'in-2']);
    expect(exported.some((c) => c.triggerMessageId === 'out-1')).toBe(false);

    const first = exported[0]!;
    expect(first.messages.map((m) => m.id)).toEqual(['in-1']);
    expect(first.messages.some((m) => m.id === 'out-1' || m.id === 'in-2')).toBe(false);

    const second = exported[1]!;
    expect(second.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2']);
    expect(second.messages.some((m) => m.id === 'in-2' && m.direction === 'inbound')).toBe(true);

    const h1 = hashQualitySource(first);
    const h2 = hashQualitySource(second);
    expect(h1).not.toBe(h2);
  });

  it('label scope exports only labeled triggers with causal cutoff', () => {
    const exported = buildLabelScopedExportCases({
      transportId: 'transport-centurion',
      threadId: 'th-1',
      messages: threadMessages,
      labels: [label({ triggerMessageId: 'in-2', expectedCategory: 'new-bookings', asOf: '2026-07-01T12:00:00.000Z' })],
      modelId: MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]!.triggerMessageId).toBe('in-2');
    expect(exported[0]!.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2']);
    expect(exported[0]!.asOf).toBe('2026-07-01T12:00:00.000Z');
  });

  it('targets scope uses manifest generatedAt as common asOf', () => {
    const exported = buildTargetsExportCases({
      transportId: 'transport-centurion',
      threadId: 'th-1',
      messages: threadMessages,
      triggerMessageId: 'in-2',
      generatedAt: '2026-07-30T00:00:00.000Z',
      modelId: MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]!.asOf).toBe('2026-07-30T00:00:00.000Z');
    expect(exported[0]!.asOfSource).toBe('frozen-manifest');
    expect(exported[0]!.messages.map((m) => m.id)).toEqual(['in-1', 'out-1', 'in-2']);
  });

  it('CLI scopes are mutually exclusive', () => {
    expect(() =>
      parseQualityExportArgs([
        '--labels',
        'a.jsonl',
        '--all-inbound-triggers',
        '--out',
        'o.jsonl',
        '--transport-id',
        'transport-a',
      ]),
    ).toThrow(/mutually exclusive|exclusive/i);
    expect(() =>
      parseQualityExportArgs([
        '--labels',
        'a.jsonl',
        '--targets',
        't.json',
        '--out',
        'o.jsonl',
        '--transport-id',
        'transport-a',
      ]),
    ).toThrow(/mutually exclusive|exclusive/i);
    expect(parseQualityExportArgs([
      '--all-inbound-triggers',
      '--out',
      'o.jsonl',
      '--transport-id',
      'transport-a',
    ]).mode).toBe('all-inbound-triggers');
    expect(() => parseQualityExportArgs(['--all-inbound-triggers', '--out', 'o.jsonl'])).toThrow(
      /transport-id/i,
    );
  });

  it('exporter script is read-only (no insert/update/delete) and ignores dump md authority', () => {
    const src = readFileSync(
      join(here, '../scripts/export-centurion-triage-quality.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(src).not.toMatch(/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i);
    expect(src).not.toMatch(/applyDurableTriageResult/);
    expect(src).not.toMatch(/dump-centurion-emails-md/);
  });
});

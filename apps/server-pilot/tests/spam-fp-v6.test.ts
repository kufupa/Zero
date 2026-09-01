import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ModelAdapter, ModelInvokeResult } from '../src/ai/bedrock/adapter.js';
import {
  AI_MANAGED_CATEGORY_SLUGS,
  AI_WORKFLOW_PRIMARY_SLUGS,
} from '../src/ai/categories.js';
import {
  applyDurableTriageResult,
  type WorkflowTriageOutput,
} from '../src/ai/triage.js';
import { mailCategory, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import {
  qualityInputCaseSchema,
  qualityLabelSchema,
  runQualityEval,
} from '../src/ai/quality-eval.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'spam-fp-v6.jsonl');
const WORKFLOW_CATEGORIES = [...new Set([...AI_MANAGED_CATEGORY_SLUGS, ...AI_WORKFLOW_PRIMARY_SLUGS, 'urgent'])];

const spamFixtureSchema = z.object({
  caseId: z.string().min(1),
  input: qualityInputCaseSchema,
  label: qualityLabelSchema,
  expected: z.object({
    primaryFolder: z.string().min(1),
    isSpam: z.boolean(),
    applySpamAt: z.enum(['clear', 'set']),
    policyFlag: z.string().optional(),
    forbidPolicyFlag: z.string().optional(),
  }),
});

type SpamFixture = z.infer<typeof spamFixtureSchema>;

function readFixtures(): SpamFixture[] {
  return readFileSync(fixturePath, 'utf8')
    .trimEnd()
    .split(/\r?\n/)
    .map((line, index) => {
      try {
        return spamFixtureSchema.parse(JSON.parse(line));
      } catch {
        throw new Error('invalid spam FP fixture line ' + (index + 1));
      }
    });
}

function usage(): ModelInvokeResult['usage'] {
  return {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    latencyMs: 5,
    estimatedCostUsd: 0.0001,
    rateTableVersion: 'test',
  };
}

/** Model deliberately calls every case spam; refinement must protect known mail. */
function forceSpamAdapter(): ModelAdapter {
  return {
    async invoke() {
      return {
        modelId: 'amazon.nova-lite-v1:0',
        output: {
          primaryFolder: 'unknown-review',
          priority: 'P3',
          urgent: false,
          overlays: {},
          isSpam: true,
          suggestedTools: [],
          sourceScope: 'external',
          automationState: 'unknown',
          humanAction: 'review_required',
          confidence: 0.99,
          rationale: 'forced spam fixture output',
          policyFlags: [],
          abstainReason: null,
        },
        usage: usage(),
      };
    },
  };
}

type ApplyState = {
  spamAt: Date | null;
  insertedPrimary: string[];
  updates: Array<Record<string, unknown>>;
};

function fakeApplyDb(state: ApplyState) {
  const categoryRows = WORKFLOW_CATEGORIES.map((slug) => ({
    id: 'category-' + slug,
    slug,
  }));
  const thenableRows = (rows: unknown[]) => {
    const promise = Promise.resolve(rows) as Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
    };
    promise.limit = async () => rows;
    return promise;
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === mailThread
            ? [{ spamAt: state.spamAt, spamUserLockedAt: null }]
            : table === mailThreadCategory
              ? []
              : table === mailCategory
                ? categoryRows
                : [];
        return {
          innerJoin: () => ({
            where: () => thenableRows(rows),
          }),
          where: () => thenableRows(rows),
        };
      },
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
          if ('spamAt' in values) state.spamAt = (values.spamAt as Date | null) ?? null;
        },
      }),
    }),
    insert: () => ({
      values: async (rows: Array<{ categoryId: string }>) => {
        for (const row of rows) {
          const category = categoryRows.find((candidate) => candidate.id === row.categoryId);
          if (category) state.insertedPrimary.push(category.slug);
        }
      },
    }),
  };
}

describe('v6 spam false-positive regression harness', () => {
  it('runs AE12-AE19 plus newsletter through classify/refine/eval/apply', async () => {
    const fixtures = readFixtures();
    expect(fixtures.map((fixture) => fixture.caseId)).toEqual([
      'AE12',
      'AE13',
      'AE14',
      'AE15',
      'AE16',
      'AE17',
      'AE18',
      'AE19',
      'newsletter-negative',
    ]);
    const ae13 = fixtures.find((fixture) => fixture.caseId === 'AE13')!;
    expect(ae13.input.messages[0]!.body.indexOf('> From: Bongi')).toBeGreaterThan(2000);

    const report = await runQualityEval(
      {
        repeatId: 'spam-fp-v6',
        inputs: fixtures.map((fixture) => fixture.input),
        labels: fixtures.map((fixture) => fixture.label),
      },
      forceSpamAdapter(),
    );

    expect(report.complete).toBe(true);
    expect(
      report.protectedRegressions.filter(
        (regression) => regression.reason === 'legitimate-mail-marked-spam',
      ),
    ).toHaveLength(0);

    for (const fixture of fixtures) {
      const outcome = report.cases.find(
        (candidate) => candidate.caseId === fixture.label.triggerMessageId,
      );
      expect(outcome?.actualWorkflow, fixture.caseId).toBeDefined();
      expect(outcome?.actualWorkflow?.primaryFolder, fixture.caseId).toBe(
        fixture.expected.primaryFolder,
      );
      expect(outcome?.actualWorkflow?.isSpam, fixture.caseId).toBe(fixture.expected.isSpam);
      if (fixture.expected.policyFlag) {
        expect(outcome?.actualWorkflow?.policyFlags, fixture.caseId).toContain(
          fixture.expected.policyFlag,
        );
      }
      if (fixture.expected.forbidPolicyFlag) {
        expect(outcome?.actualWorkflow?.policyFlags, fixture.caseId).not.toContain(
          fixture.expected.forbidPolicyFlag,
        );
      }

      const trigger = fixture.input.messages.find(
        (message) => message.id === fixture.input.triggerMessageId,
      )!;
      const state: ApplyState = {
        spamAt: fixture.expected.isSpam ? null : new Date('2026-07-31T00:00:00.000Z'),
        insertedPrimary: [],
        updates: [],
      };
      await applyDurableTriageResult({
        db: fakeApplyDb(state) as never,
        transportId: fixture.input.transportId,
        threadId: fixture.input.threadId,
        writeGateEnabled: true,
        workflowTriageEnabled: true,
        threadSignals: fixture.input.messages.some(
          (message) =>
            message.direction === 'outbound' && /(?:legacyhotels\.co\.za|mail\.legacyhotels\.com)$/i.test(message.from),
        )
          ? { legacyHotelsOutboundResponse: true }
          : undefined,
        from: trigger.from,
        to: trigger.to,
        cc: trigger.cc,
        bcc: trigger.bcc,
        output: outcome!.actualWorkflow as WorkflowTriageOutput,
      });

      if (fixture.expected.applySpamAt === 'clear') {
        expect(state.spamAt, fixture.caseId).toBeNull();
        expect(state.insertedPrimary, fixture.caseId).toContain(
          fixture.expected.primaryFolder,
        );
      } else {
        expect(state.spamAt, fixture.caseId).toBeInstanceOf(Date);
        expect(state.insertedPrimary, fixture.caseId).toEqual([]);
      }
    }
  });
});

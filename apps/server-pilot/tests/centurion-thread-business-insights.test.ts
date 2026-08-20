import { describe, expect, it } from 'vitest';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function caseRef(token: string): string {
  return `case_${token.repeat(64).slice(0, 64)}`;
}

function createSafeBusinessInput() {
  return {
    runRef: `run_${HASH_A}`,
    generatedAt: '2026-08-10T12:00:00.000Z',
    sourceDigests: [HASH_A, HASH_B],
    snapshot: {
      eventCutoffs: ['2026-08-10T10:00:00.000Z'],
      ingestCutoffs: ['2026-08-10T11:00:00.000Z'],
      messageCount: 9,
      componentCount: 3,
      persistedThreadCount: 3,
      parserExceptionCount: 0,
      coverageExceptionCount: 0,
    },
    versions: {
      classifierVersion: 'deterministic-classifier-v1',
      metricDefinitionVersion: 'metric-definition-v2',
    },
    readiness: {
      status: 'valid',
      sourceCoverage: 'complete',
      cutoffsKnown: true,
      membershipReconciled: true,
      parserExceptionsAccounted: true,
      allComponentsClosed: true,
      pendingReview: false,
    },
    components: [
      {
        caseRef: caseRef('a'),
        finalState: 'action_required',
        classificationFinal: true,
        reasonCodes: ['strict_new_reservation_pattern'],
        evidenceTier: 'persisted_reply',
        limitations: [],
        coverageStatus: 'complete',
        responseGaps: [
          {
            status: 'observed',
            durationMs: 3_600_000,
            reason: null,
          },
        ],
        classificationCounts: [
          { classification: 'new_reservation_request', count: 1 },
          { classification: 'staff_response', count: 1 },
        ],
        participantCounts: { internal: 1, external: 1 },
        persistedThreadCount: 1,
        turnCount: 2,
        latestAction: {
          eventTime: '2026-08-10T02:00:00.000Z',
          quality: 'trustworthy',
        },
      },
      {
        caseRef: caseRef('b'),
        finalState: 'needs_manual_adjudication',
        classificationFinal: true,
        reasonCodes: ['continuation_without_safe_outcome'],
        evidenceTier: 'quoted_reply',
        limitations: ['quoted_only_evidence'],
        coverageStatus: 'complete',
        responseGaps: [
          {
            status: 'excluded',
            durationMs: null,
            reason: 'no_persisted_roster_response',
          },
        ],
        classificationCounts: [{ classification: 'ambiguous', count: 3 }],
        participantCounts: { internal: 1, external: 1 },
        persistedThreadCount: 1,
        turnCount: 3,
        latestAction: {
          eventTime: '2026-08-09T00:00:00.000Z',
          quality: 'trustworthy',
        },
      },
      {
        caseRef: caseRef('c'),
        finalState: 'resolved',
        classificationFinal: true,
        reasonCodes: ['recognized_booking_instruction'],
        evidenceTier: 'persisted_reply',
        limitations: [],
        coverageStatus: 'complete',
        responseGaps: [
          {
            status: 'unknown',
            durationMs: null,
            reason: 'missing_event_time',
          },
        ],
        classificationCounts: [
          { classification: 'booking_instruction', count: 1 },
          { classification: 'internal_handoff', count: 1 },
          { classification: 'staff_response', count: 2 },
        ],
        participantCounts: { internal: 2, external: 1 },
        persistedThreadCount: 1,
        turnCount: 4,
        latestAction: { eventTime: null, quality: 'missing' },
      },
    ],
  };
}

async function loadBusinessInsights() {
  return import('../src/ops/centurion-thread-business-insights.js');
}

describe('Centurion thread business insights', () => {
  it('renders closed safe facts in deterministic seven-section order', async () => {
    const api = await loadBusinessInsights();
    const input = createSafeBusinessInput();
    const reordered = {
      ...input,
      components: [...input.components].reverse(),
    };
    const first = api.renderCenturionThreadBusinessInsights(
      api.buildCenturionThreadBusinessFacts(input),
    );
    const second = api.renderCenturionThreadBusinessInsights(
      api.buildCenturionThreadBusinessFacts(reordered),
    );
    const headings = [
      '## 1. Decision-readiness trust bar',
      '## 2. Current work queue',
      '## 3. Observed service timing, not SLA performance',
      '## 4. Conversation outcomes',
      '## 5. Operational complexity',
      '## 6. Automation prerequisites, not agent performance',
      '## 7. Revenue metrics only when grounded',
    ];

    expect(first.markdown).toBe(second.markdown);
    expect(headings.map((heading) => first.markdown.indexOf(heading))).toEqual(
      headings.map((heading) => first.markdown.indexOf(heading)).sort(
        (left, right) => left - right,
      ),
    );
    expect(first.markdown).toContain('## CEO');
    expect(first.markdown).toContain('## CTO');
    expect(first.markdown).toContain('## Client');
    for (const selected of first.selectedExamples) {
      expect(selected.examples.length).toBeLessThanOrEqual(3);
      expect(new Set(selected.examples.map((example) => example.caseRef)).size).toBe(
        selected.examples.length,
      );
      for (const example of selected.examples) {
        expect(example.caseRef).toMatch(/^case_[a-f0-9]{64}$/u);
        expect(input.components.map((component) => component.caseRef)).toContain(
          example.caseRef,
        );
      }
    }
  });

  it('rejects unsafe input and selected references outside current report membership', async () => {
    const api = await loadBusinessInsights();
    const input = createSafeBusinessInput();

    expect(() =>
      api.buildCenturionThreadBusinessFacts({
        ...input,
        components: [
          {
            ...input.components[0],
            finalState: 'invented_state',
          },
        ],
      }),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    expect(() =>
      api.buildCenturionThreadBusinessFacts({
        ...input,
        rawMailBody: 'SYNTHETIC_RAW_BODY_SENTINEL',
      }),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    expect(() =>
      api.buildCenturionThreadBusinessFacts({
        ...input,
        versions: {
          ...input.versions,
          metricDefinitionVersion: 'metric-definition-v1',
        },
      }),
    ).toThrow(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
    expect(() =>
      api.buildCenturionThreadBusinessFacts({
        ...input,
        components: input.components.map((component, index) =>
          index === 0
            ? {
                ...component,
                limitations: ['coverage_limited'],
              }
            : component,
        ),
      }),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');

    const facts = api.buildCenturionThreadBusinessFacts(input);
    const insight = facts.insights.find(
      (candidate: { examples: readonly unknown[] }) =>
        candidate.examples.length > 0,
    );
    expect(insight).toBeDefined();
    for (const caseReference of [
      `case_${'d'.repeat(64)}`,
      `message_${HASH_C}`,
      input.components[0]!.caseRef,
    ]) {
      const invalidFacts = JSON.parse(JSON.stringify(facts));
      const invalidInsight = invalidFacts.insights.find(
        (candidate: { examples: unknown[] }) => candidate.examples.length > 0,
      );
      invalidInsight.examples = [
        {
          caseRef: caseReference,
          selectionReason: 'outlier',
        },
        {
          caseRef:
            caseReference === input.components[0]!.caseRef
              ? caseReference
              : input.components[0]!.caseRef,
          selectionReason: 'outlier',
        },
      ];

      expect(() =>
        api.renderCenturionThreadBusinessInsights(invalidFacts),
      ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_REFERENCE_INVALID');
    }
  });

  it('fails closed on Task 6 metric and fact-binding regressions', async () => {
    const api = await loadBusinessInsights();
    const input = createSafeBusinessInput();
    const invalidGaps = [
      {
        status: 'excluded',
        durationMs: null,
        reason: 'missing_event_time',
      },
      {
        status: 'unknown',
        durationMs: null,
        reason: 'no_persisted_roster_response',
      },
    ];

    for (const responseGap of invalidGaps) {
      expect(() =>
        api.buildCenturionThreadBusinessFacts({
          ...input,
          components: [
            { ...input.components[0], responseGaps: [responseGap] },
            ...input.components.slice(1),
          ],
        }),
      ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    expect(() =>
      api.buildCenturionThreadBusinessFacts({
        ...input,
        snapshot: { ...input.snapshot, messageCount: 8 },
      }),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');

    const validFacts = api.buildCenturionThreadBusinessFacts(input);
    const mutatedRenderedFacts = JSON.parse(JSON.stringify(validFacts));
    mutatedRenderedFacts.input.snapshot.parserExceptionCount = 1;
    expect(() =>
      api.renderCenturionThreadBusinessInsights(mutatedRenderedFacts),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
    const unavailableInput = {
      ...input,
      readiness: {
        ...input.readiness,
        status: 'not_available',
        sourceCoverage: 'limited',
      },
      components: input.components.map((component, index) =>
        index === 0
          ? { ...component, coverageStatus: 'limited' }
          : component,
      ),
    };
    const forgedFacts = JSON.parse(
      JSON.stringify(api.buildCenturionThreadBusinessFacts(unavailableInput)),
    );
    forgedFacts.insights = validFacts.insights;
    expect(() =>
      api.renderCenturionThreadBusinessInsights(forgedFacts),
    ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');

    const incompleteClassification = {
      ...input,
      components: input.components.map((component, index) => ({
        ...component,
        classificationFinal: index !== 0,
      })),
    };
    expect(
      api.renderCenturionThreadBusinessInsights(
        api.buildCenturionThreadBusinessFacts(incompleteClassification),
      ).markdown,
    ).toContain(
      '- classified_outcomes: `not_available`; next_proof=`verify_identity_or_linkage`',
    );
    expect(
      api.renderCenturionThreadBusinessInsights(
        api.buildCenturionThreadBusinessFacts({
          ...input,
          components: input.components.map((component, index) =>
            index === 0
              ? {
                  ...component,
                  classificationFinal: false,
                  classificationCounts: [{ classification: 'staff_response', count: 1 }],
                }
              : component,
          ),
        }),
      ).markdown,
    ).toContain('- unclassified_component_count: 1');
    expect(
      api.renderCenturionThreadBusinessInsights(validFacts).markdown,
    ).toContain('- unresolved_ambiguous_manual: `available`; count=1');

    for (const classificationCounts of [
      [],
      [{ classification: 'new_reservation_request', count: 3 }],
    ]) {
      expect(() =>
        api.buildCenturionThreadBusinessFacts({
          ...input,
          components: input.components.map((component, index) =>
            index === 0 ? { ...component, classificationCounts } : component,
          ),
        }),
      ).toThrow('CENTURION_THREAD_BUSINESS_INSIGHTS_INPUT_INVALID');
    }
    expect(
      api.renderCenturionThreadBusinessInsights(validFacts).markdown,
    ).toContain(
      '- messages_per_component: `available`; value=3.000000; unit=messages_per_component; numerator=9;',
    );
    expect(
      api.renderCenturionThreadBusinessInsights(validFacts).markdown,
    ).toContain(
      '- safe_excluded_unknown_case_buckets: quote_only=1; automated=0; ambiguous=1; duplicate=0; missing_event_time=1; incomplete=0; pending_review=0',
    );

    const limitationRankingFacts = api.buildCenturionThreadBusinessFacts({
      ...input,
      components: input.components.map((component, index) => ({
        ...component,
        limitations:
          index === 0
            ? ['duplicate_persisted_message']
            : index === 1
              ? ['duplicate_persisted_message', 'quoted_only_evidence']
              : ['missing_event_time'],
      })),
    });
    expect(
      limitationRankingFacts.insights.find(
        (insight: { metricId: string }) =>
          insight.metricId === 'automation_prerequisites',
      )?.examples.map((example: { caseRef: string }) => example.caseRef),
    ).toEqual([caseRef('c'), caseRef('b'), caseRef('a')]);

    const emptyInput = {
      ...input,
      snapshot: {
        ...input.snapshot,
        messageCount: 0,
        componentCount: 0,
        persistedThreadCount: 0,
      },
      components: [],
    };
    expect(
      api.renderCenturionThreadBusinessInsights(
        api.buildCenturionThreadBusinessFacts(emptyInput),
      ).markdown,
    ).toContain('- messages_per_component: `not_available`');
  });
});

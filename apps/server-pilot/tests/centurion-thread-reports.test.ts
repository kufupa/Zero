import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSealedCenturionThreadAuditSnapshotBytes } from '../src/ops/centurion-thread-audit-snapshot.js';
import {
  centurionThreadAuditCandidateOperatorRoot,
  readVerifiedCenturionThreadAuditSnapshotCandidateForTest,
} from '../src/ops/centurion-thread-audit-candidate.js';
import {
  createThreadReportsFixture,
  deterministicReportReferenceFactory,
  RAW_REPORT_SENTINELS,
} from './fixtures/centurion-thread-reports.js';
import {
  canonicalCorpora,
  fixtureMessage,
  THREAD_ADJUDICATION_ROSTER,
} from './fixtures/centurion-thread-adjudication.js';

async function loadReports() {
  return import('../src/ops/centurion-thread-reports.js');
}

async function loadCli() {
  return import('../scripts/centurion-thread-adjudication.ts');
}

function render(
  api: Awaited<ReturnType<typeof loadReports>>,
  input: ReturnType<typeof createThreadReportsFixture>,
  seed = 'a',
) {
  return api.renderCenturionThreadReports({
    corpora: input.corpora,
    adjudication: input.adjudication,
    generatedAt: input.generatedAt,
    ...input.versions,
    referenceFactory: deterministicReportReferenceFactory(seed),
  });
}

describe('Centurion private thread reports', () => {
  it('renders reconciled private cases, action queue, index, metrics, and definitions', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const reports = render(api, input);
    const index = JSON.parse(reports.files['thread-index.json']);
    const metrics = reports.files['thread-metrics.csv'];
    const reservationCases = reports.files['reservation-thread-cases.md'];
    const actionRequired = reports.files['action-required-threads.md'];
    const definitions = reports.files['process-and-definitions.md'];
    const businessInsights = reports.files['business-insights.md'];
    const componentRows = metrics
      .trim()
      .split('\n')
      .slice(1)
      .filter((line) => line.startsWith('component,'));
    const aggregateRows = metrics
      .trim()
      .split('\n')
      .slice(1)
      .filter((line) => line.startsWith('aggregate,'));

    expect(reports).toMatchObject({
      schema: 'centurion_thread_reports_v1',
      receipt: {
        componentCount: input.adjudication.threadIntelligence.components.length,
      },
    });
    expect(reports.auditSnapshotEnvelopeBytes).toMatch(
      /^\{"attemptedAt":/,
    );
    expect(reports.auditSnapshotEnvelopeBytes).not.toContain('case_');
    expect(reports.auditSnapshotEnvelopeBytes).not.toContain('run_');
    expect(
      parseSealedCenturionThreadAuditSnapshotBytes(
        reports.auditSnapshotEnvelopeBytes,
      ).sourceManifestDigest,
    ).toBe(input.corpora[0]!.manifest.corpusSha256);
    expect(Object.keys(reports.files).sort()).toEqual([
      'action-required-threads.md',
      'business-insights.md',
      'process-and-definitions.md',
      'reservation-thread-cases.md',
      'thread-index.json',
      'thread-metrics.csv',
    ]);
    expect(index.components).toHaveLength(
      input.adjudication.threadIntelligence.components.length,
    );
    expect(index.reconciliation).toMatchObject({
      indexComponentCount: input.adjudication.threadIntelligence.components.length,
      metricComponentRowCount: input.adjudication.threadIntelligence.components.length,
      actionRequiredMarkdownCaseCount: index.reconciliation.actionRequiredComponentCount,
    });
    expect(componentRows).toHaveLength(
      input.adjudication.threadIntelligence.components.length,
    );
    expect(aggregateRows.length).toBeGreaterThanOrEqual(3);
    expect(
      index.components.find((component: { reservationScope: string }) =>
        component.reservationScope === 'confirmed',
      ),
    ).toBeTruthy();
    expect(
      index.components.find((component: { reservationScope: string }) =>
        component.reservationScope === 'potential',
      ),
    ).toBeTruthy();
    expect(index.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reservationScope: 'confirmed',
          classificationSummary: expect.objectContaining({
            booking_instruction: 1,
          }),
        }),
        expect.objectContaining({
          state: 'action_required',
          reservationScope: 'confirmed',
          classificationSummary: expect.objectContaining({
            new_reservation_request: 1,
          }),
        }),
        expect.objectContaining({
          reservationScope: 'not_reservation_related',
          classificationSummary: expect.objectContaining({
            automated_or_non_actionable: 1,
          }),
        }),
        expect.objectContaining({
          classificationSummary: expect.objectContaining({
            internal_handoff: 1,
          }),
        }),
        expect.objectContaining({
          turnCount: 2,
          multiMessage: true,
          classificationSummary: expect.objectContaining({
            new_reservation_request: 1,
            ambiguous: 1,
          }),
        }),
        expect.objectContaining({
          reservationScope: 'potential',
          classificationSummary: expect.objectContaining({
            ambiguous: 1,
          }),
        }),
      ]),
    );
    expect(reservationCases).toContain(RAW_REPORT_SENTINELS.body);
    expect(reservationCases).toContain('Quoted-history boundary');
    expect(reservationCases).toContain('Task 3 quote provenance');
    expect(actionRequired).toContain(RAW_REPORT_SENTINELS.body);
    expect(actionRequired).toContain('Latest actionable request');
    expect(definitions).toContain('Future-question lookup map');
    expect(definitions).toContain('False-positive examples');
    expect(definitions).toContain('Task 6 business-insight metric contract');
    expect(definitions).toContain('## Task 6 metric definitions');
    expect(definitions).toContain(
      'quote-only, automated, ambiguous, duplicate, missing-event-time, incomplete, and pending-review',
    );
    expect(definitions).toContain(
      'manual Task 3 review, bounded decision, evidence verification, and rerun',
    );
    for (const metricId of [
      'decision_readiness',
      'current_work_queue',
      'observed_service_timing',
      'conversation_outcomes',
      'operational_complexity',
      'automation_prerequisites',
      'revenue_metrics',
    ]) {
      expect(definitions).toContain(`- \`${metricId}\`: formula=`);
    }
    expect(definitions).toContain(
      '`available` means an eligible grounded value; `not_available` is not zero; `not_evaluated` has no approved evaluation contract.',
    );
    expect(businessInsights).toContain('## CEO');
    expect(businessInsights).toContain('## CTO');
    expect(businessInsights).toContain('## Client');
    expect(businessInsights).toContain('## 1. Decision-readiness trust bar');
    expect(businessInsights).toContain(
      '## 7. Revenue metrics only when grounded',
    );
    expect(businessInsights).not.toContain('## Field dictionary');
    expect(businessInsights).not.toContain('## Task 6 metric definitions');
    expect(businessInsights).not.toContain(input.adjudication.turns[0]!.componentRef);
    expect(businessInsights).not.toContain(input.adjudication.turns[0]!.messageRef);

    const publicArtifacts = [
      JSON.stringify(reports.receipt),
      reports.files['thread-index.json'],
      reports.files['thread-metrics.csv'],
      reports.files['process-and-definitions.md'],
      businessInsights,
    ].join('\n');
    for (const value of Object.values(RAW_REPORT_SENTINELS)) {
      expect(publicArtifacts).not.toContain(value);
    }
  });

  it('binds deterministic safe business insights to report receipts and suppresses invalid snapshots', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const first = render(api, input, 'a');
    const second = render(api, input, 'b');
    const altered = JSON.parse(JSON.stringify(input.adjudication)) as typeof input.adjudication;
    const changedReason = altered.turns.find(
      (turn) => turn.messageId === 'unresponded-request',
    ) as unknown as { reasonCodes: string[] };
    changedReason.reasonCodes = ['cache_source_changed'];
    const changed = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: altered,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('a'),
    });
    const limited = JSON.parse(JSON.stringify(input.adjudication)) as typeof input.adjudication;
    limited.threadIntelligence.components[0]!.coverage = {
      ...limited.threadIntelligence.components[0]!.coverage,
      complete: false,
      attestation: 'incomplete',
    };
    const unavailable = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: limited,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('c'),
    });
    const stripFreshReferences = (value: string) =>
      value.replace(/(?:run|case)_[a-f0-9]{64}/gu, 'fresh_ref');

    expect(stripFreshReferences(first.files['business-insights.md'])).toBe(
      stripFreshReferences(second.files['business-insights.md']),
    );
    expect(first.files['business-insights.md']).not.toBe(
      second.files['business-insights.md'],
    );
    for (const name of [
      'thread-index.json',
      'reservation-thread-cases.md',
      'action-required-threads.md',
      'thread-metrics.csv',
      'process-and-definitions.md',
    ] as const) {
      expect(changed.files[name]).toBe(first.files[name]);
    }
    expect(changed.files['business-insights.md']).toBe(
      first.files['business-insights.md'],
    );
    expect(changed.receipt.outputDigest).toBe(first.receipt.outputDigest);
    expect(unavailable.files['business-insights.md']).toContain(
      '- status: `not_available`',
    );
    expect(unavailable.files['business-insights.md']).not.toContain(
      'act_now_component_count',
    );
    expect(unavailable.files['business-insights.md']).not.toContain(
      'booking_instruction_or_quote_acceptance',
    );
    expect(() =>
      api.renderCenturionThreadReports({
        corpora: input.corpora,
        adjudication: input.adjudication,
        generatedAt: input.generatedAt,
        identityRulesVersion: input.versions.identityRulesVersion,
        classifierVersion: input.versions.classifierVersion,
        metricDefinitionVersion: 'metric-definition-v1',
        referenceFactory: deterministicReportReferenceFactory('d'),
      }),
    ).toThrow(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
  });

  it('uses final classifications and component timing exclusions for Task 6 facts', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const altered = JSON.parse(JSON.stringify(input.adjudication)) as typeof input.adjudication;
    const bookingInstruction = altered.turns.find(
      (turn) => turn.messageId === 'booking-instruction',
    )!;
    bookingInstruction.annotationFinal = false;
    const reports = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: altered,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('e'),
    });
    const insights = reports.files['business-insights.md'];

    expect(insights).toContain('- status: `not_available`');
    expect(insights).not.toContain('classified_outcomes');
    expect(insights).not.toMatch(/no_actionable_external_turn=[1-9]\d*/u);
  });

  it('suppresses Task 6 factual claims while review remains pending', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const resolved = JSON.parse(JSON.stringify(input.adjudication)) as typeof input.adjudication;
    for (const turn of resolved.turns) {
      turn.reviewRequired = false;
    }
    resolved.reviewQueue = [];
    const baseline = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: resolved,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('f'),
    });
    const pending = JSON.parse(JSON.stringify(resolved)) as typeof input.adjudication;
    pending.turns.find(
      (turn) => turn.messageId === 'booking-instruction',
    )!.reviewRequired = true;
    const reports = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: pending,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('f'),
    });
    const baselineInsights = baseline.files['business-insights.md'];
    const insights = reports.files['business-insights.md'];

    expect(baselineInsights).toContain('- decision_readiness: `valid`');
    expect(baselineInsights).toContain('act_now_component_count');
    expect(baselineInsights).toContain('### Insight `current_work_queue`\n- claim_status: `fact`');
    expect(insights).toContain('- decision_readiness: `not_available`');
    expect(insights).toContain('- status: `not_available`');
    expect(insights).not.toContain('act_now_component_count');
    expect(insights).not.toContain('booking_instruction_or_quote_acceptance');
    expect(insights).toContain('- next_action: `review_manual_queue`');
    expect(insights).toContain('- next_human_check: `review_pending_task3`');
    expect(insights).toContain('- cheapest_next_proof: `rerun_task3_after_review`');
    expect(insights).not.toContain('verify_source_coverage');
    expect(insights).not.toContain('collect_authoritative_pms_data');
  });

  it('uses persisted response gaps only for observed timing and reconciles p50/p95', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const altered = JSON.parse(JSON.stringify(input.adjudication)) as {
      threadIntelligence: {
        components: Array<{
          chronology: Array<{ messageId: string }>;
          responseGaps: Array<{
            kind: 'first_response' | 'follow_up';
            actionableMessageId: string;
            responseMessageId: string | null;
            durationMs: number | null;
            reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
          }>;
          firstResponseLatencyMs: number | null;
        }>;
      };
    };
    const unknownTiming = altered.threadIntelligence.components.find((component) =>
      component.chronology.some(
        (turn) => turn.messageId === 'unresponded-request',
      ),
    )!;
    unknownTiming.responseGaps[0] = {
      ...unknownTiming.responseGaps[0]!,
      durationMs: null,
      responseMessageId: null,
      reason: 'missing_event_time',
    };
    unknownTiming.firstResponseLatencyMs = null;
    const reports = api.renderCenturionThreadReports({
      corpora: input.corpora,
      adjudication: altered as typeof input.adjudication,
      generatedAt: input.generatedAt,
      ...input.versions,
      referenceFactory: deterministicReportReferenceFactory('b'),
    });
    const index = JSON.parse(reports.files['thread-index.json']);
    const bookingCase = index.components.find((component: {
      classificationSummary: Record<string, number>;
    }) => component.classificationSummary.booking_instruction === 1);

    expect(index.summary.timing).toMatchObject({
      observedResponseGapCount: 2,
      unknownResponseGapCount: 1,
      p50ResponseLatencyMs: 3_600_000,
      p95ResponseLatencyMs: 10_800_000,
    });
    expect(bookingCase.timing).toMatchObject({
      status: 'excluded',
      reason: 'no_actionable_external_turn',
    });
  });

  it('rejects contradictory response-gap timing fields', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const corruptions = [
      (gap: {
        durationMs: number | null;
        responseMessageId: string | null;
        reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
      }) => {
        gap.reason = 'missing_event_time';
      },
      (gap: {
        durationMs: number | null;
        responseMessageId: string | null;
        reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
      }) => {
        gap.durationMs = null;
        gap.responseMessageId = 'responded-slow-reply';
        gap.reason = 'no_persisted_roster_response';
      },
      (gap: {
        durationMs: number | null;
        responseMessageId: string | null;
        reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
      }) => {
        gap.durationMs = null;
        gap.responseMessageId = null;
        gap.reason = null;
      },
    ];

    for (const corrupt of corruptions) {
      const altered = JSON.parse(JSON.stringify(input.adjudication)) as {
        threadIntelligence: {
          components: Array<{
            chronology: Array<{ messageId: string }>;
            responseGaps: Array<{
              durationMs: number | null;
              responseMessageId: string | null;
              reason: 'missing_event_time' | 'no_persisted_roster_response' | null;
            }>;
          }>;
        };
      };
      const component = altered.threadIntelligence.components.find((candidate) =>
        candidate.chronology.some(
          (turn) => turn.messageId === 'responded-slow-request',
        ),
      )!;
      corrupt(component.responseGaps[0]!);

      expect(() =>
        api.renderCenturionThreadReports({
          corpora: input.corpora,
          adjudication: altered as typeof input.adjudication,
          generatedAt: input.generatedAt,
          ...input.versions,
          referenceFactory: deterministicReportReferenceFactory('3'),
        }),
      ).toThrow('CENTURION_THREAD_REPORTS_TIMING_INVALID');
    }
  });

  it('escapes Markdown and CSV content and bounds UTF-8 excerpts', async () => {
    const api = await loadReports();
    const csv = api.escapeCenturionThreadReportCsv('left,"middle"\nright');
    const markdown = api.escapeCenturionThreadReportMarkdown(
      '# heading | [link] `code`',
    );
    const excerpt = api.truncateCenturionThreadReportUtf8({
      value: 'é'.repeat(200),
      maxBytes: 96,
    });

    expect(csv).toBe('"left,""middle""\nright"');
    expect(markdown).toContain('\\#');
    expect(markdown).toContain('\\|');
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.value).toContain('[truncated');
    expect(Buffer.byteLength(excerpt.value, 'utf8')).toBeLessThanOrEqual(96);
  });

  it('generates fresh report references and never republishes Task 3 join references', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const first = render(api, input, 'c');
    const second = render(api, input, 'd');
    const firstIndex = JSON.parse(first.files['thread-index.json']);
    const secondIndex = JSON.parse(second.files['thread-index.json']);

    expect(firstIndex.runRef).not.toBe(secondIndex.runRef);
    expect(firstIndex.components[0].caseRef).not.toBe(
      secondIndex.components[0].caseRef,
    );
    expect(firstIndex.components[0].messages[0].messageRef).not.toBe(
      secondIndex.components[0].messages[0].messageRef,
    );
    expect(JSON.stringify(firstIndex)).not.toContain(
      input.adjudication.turns[0]!.componentRef,
    );
    expect(JSON.stringify(firstIndex)).not.toContain(
      input.adjudication.turns[0]!.messageRef,
    );
  });

  it('fails closed when Task 3 component reconciliation is inconsistent', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const altered = JSON.parse(JSON.stringify(input.adjudication)) as {
      threadIntelligence: { components: unknown[] };
    };
    altered.threadIntelligence.components.pop();

    expect(() =>
      api.renderCenturionThreadReports({
        corpora: input.corpora,
        adjudication: altered as typeof input.adjudication,
        generatedAt: input.generatedAt,
        ...input.versions,
        referenceFactory: deterministicReportReferenceFactory('e'),
      }),
    ).toThrow('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  });

  it('requires every canonical message exactly once in Task 2 component chronology', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const duplicate = JSON.parse(JSON.stringify(input.adjudication)) as {
      threadIntelligence: {
        components: Array<{ chronology: Array<{ messageId: string }> }>;
      };
    };
    duplicate.threadIntelligence.components[0]!.chronology.push(
      duplicate.threadIntelligence.components[0]!.chronology[0]!,
    );
    const omitted = JSON.parse(JSON.stringify(input.adjudication)) as {
      threadIntelligence: {
        components: Array<{ chronology: Array<{ messageId: string }> }>;
      };
    };
    omitted.threadIntelligence.components[0]!.chronology.pop();

    for (const adjudication of [duplicate, omitted]) {
      expect(() =>
        api.renderCenturionThreadReports({
          corpora: input.corpora,
          adjudication: adjudication as typeof input.adjudication,
          generatedAt: input.generatedAt,
          ...input.versions,
          referenceFactory: deterministicReportReferenceFactory('f'),
        }),
      ).toThrow('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
  });

  it('fails closed on stale Task 2 chronology bindings to canonical fields', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const corruptions = [
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.transportId = 'stale-transport';
      },
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.persistedThreadId = 'stale-thread';
      },
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.direction = 'outbound';
      },
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.eventTime = {
          value: '2026-01-01T00:00:00.000Z',
          source: 'received_at',
        };
      },
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.eventTime.source = 'created_at';
      },
      (turn: {
        transportId: string;
        persistedThreadId: string;
        direction: 'inbound' | 'outbound';
        senderRole: 'internal' | 'external';
        eventTime: { value: string | null; source: string };
      }) => {
        turn.senderRole = 'internal';
      },
    ];

    for (const corrupt of corruptions) {
      const altered = JSON.parse(JSON.stringify(input.adjudication)) as {
        threadIntelligence: {
          components: Array<{
            chronology: Array<{
              messageId: string;
              transportId: string;
              persistedThreadId: string;
              direction: 'inbound' | 'outbound';
              senderRole: 'internal' | 'external';
              eventTime: { value: string | null; source: string };
            }>;
          }>;
        };
      };
      const turn = altered.threadIntelligence.components
        .flatMap((component) => component.chronology)
        .find((candidate) => candidate.messageId === 'responded-fast-request')!;
      corrupt(turn);

      expect(() =>
        api.renderCenturionThreadReports({
          corpora: input.corpora,
          adjudication: altered as typeof input.adjudication,
          generatedAt: input.generatedAt,
          ...input.versions,
          referenceFactory: deterministicReportReferenceFactory('1'),
        }),
      ).toThrow('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
  });

  it('fails closed when a response-gap endpoint is outside its component chronology', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const corruptions = [
      (gap: { actionableMessageId: string; responseMessageId: string | null }) => {
        gap.actionableMessageId = 'responded-fast-request';
      },
      (gap: { actionableMessageId: string; responseMessageId: string | null }) => {
        gap.responseMessageId = 'responded-fast-reply';
      },
    ];

    for (const corrupt of corruptions) {
      const altered = JSON.parse(JSON.stringify(input.adjudication)) as {
        threadIntelligence: {
          components: Array<{
            chronology: Array<{ messageId: string }>;
            responseGaps: Array<{
              actionableMessageId: string;
              responseMessageId: string | null;
            }>;
          }>;
        };
      };
      const component = altered.threadIntelligence.components.find((candidate) =>
        candidate.chronology.some(
          (turn) => turn.messageId === 'responded-slow-request',
        ),
      )!;
      corrupt(component.responseGaps[0]!);

      expect(() =>
        api.renderCenturionThreadReports({
          corpora: input.corpora,
          adjudication: altered as typeof input.adjudication,
          generatedAt: input.generatedAt,
          ...input.versions,
          referenceFactory: deterministicReportReferenceFactory('2'),
        }),
      ).toThrow('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
  });

  it('renders every staff-response turn as persisted evidence but excludes internal handoffs', async () => {
    const api = await loadReports();
    const adjudicationApi = await import('../src/ops/centurion-thread-adjudication.js');
    const corpora = canonicalCorpora([
      fixtureMessage({
        id: 'staff-evidence-request',
        threadId: 'staff-evidence-thread',
        createdAt: '2026-08-02T08:00:00.000Z',
        receivedAt: '2026-08-02T08:00:00.000Z',
        textBody:
          'Could you please confirm availability for one room from 10 May 2026 to 12 May 2026?',
      }),
      fixtureMessage({
        id: 'staff-evidence-first',
        threadId: 'staff-evidence-thread',
        direction: 'outbound',
        createdAt: '2026-08-02T09:00:00.000Z',
        sentAt: '2026-08-02T09:00:00.000Z',
        from: 'internal@fixture.test',
        to: ['staff-evidence-guest@fixture.invalid'],
        textBody: 'SYNTHETIC_STAFF_RESPONSE_ONE',
      }),
      fixtureMessage({
        id: 'staff-evidence-second',
        threadId: 'staff-evidence-thread',
        direction: 'outbound',
        createdAt: '2026-08-02T09:30:00.000Z',
        sentAt: '2026-08-02T09:30:00.000Z',
        from: 'internal@fixture.test',
        to: ['staff-evidence-guest@fixture.invalid'],
        textBody: 'SYNTHETIC_STAFF_RESPONSE_TWO',
      }),
      fixtureMessage({
        id: 'staff-evidence-handoff',
        threadId: 'staff-evidence-thread',
        direction: 'outbound',
        createdAt: '2026-08-02T10:00:00.000Z',
        sentAt: '2026-08-02T10:00:00.000Z',
        from: 'internal@fixture.test',
        to: ['team@fixture.test'],
        textBody: 'SYNTHETIC_INTERNAL_HANDOFF',
      }),
    ]);
    const base = adjudicationApi.adjudicateCenturionThreadState({
      roster: THREAD_ADJUDICATION_ROSTER,
      corpora,
      identityRulesVersion: 'identity-rules-v1',
      classifierVersion: 'deterministic-classifier-v1',
      metricDefinitionVersion: 'metric-definition-v2',
    });
    const altered = JSON.parse(JSON.stringify(base)) as typeof base;
    const component = altered.threadIntelligence.components[0]!;
    component.state = 'action_required';
    component.actionEvidence = {
      tier: 'persisted_trusted_actionable_external',
      messageId: 'staff-evidence-request',
      actionRequiredEligible: true,
    };

    const reports = api.renderCenturionThreadReports({
      corpora,
      adjudication: altered,
      generatedAt: '2026-08-10T00:00:00.000Z',
      identityRulesVersion: 'identity-rules-v1',
      classifierVersion: 'deterministic-classifier-v1',
      metricDefinitionVersion: 'metric-definition-v2',
      referenceFactory: deterministicReportReferenceFactory('a'),
    });
    const action = reports.files['action-required-threads.md'];

    expect(action).toContain('SYNTHETIC_STAFF_RESPONSE_ONE');
    expect(action).toContain('SYNTHETIC_STAFF_RESPONSE_TWO');
    expect(action).not.toContain('SYNTHETIC_INTERNAL_HANDOFF');
    expect(action).toContain('eligible_observed');
    expect(action).toContain('excluded_not_response_gap');
  });

  it('uses only real rendered case references for Markdown reconciliation', async () => {
    const api = await loadReports();
    const input = createThreadReportsFixture();
    const reports = render(api, input, 'b');

    expect(reports.renderedMarkdown).toMatchObject({
      reservationCaseRefs: expect.any(Array),
      actionCaseRefs: expect.any(Array),
    });
    expect(() =>
      api.assertCenturionThreadReportMarkdownReconciliation({
        expectedReservationCaseRefs: reports.renderedMarkdown.reservationCaseRefs,
        renderedReservationCaseRefs: [
          ...reports.renderedMarkdown.reservationCaseRefs,
          reports.renderedMarkdown.reservationCaseRefs[0]!,
        ],
        expectedActionCaseRefs: reports.renderedMarkdown.actionCaseRefs,
        renderedActionCaseRefs: reports.renderedMarkdown.actionCaseRefs,
      }),
    ).toThrow('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  });

  it('detects robust quote boundaries and preserves Task 3 provenance', async () => {
    const api = await loadReports();

    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'From: ordinary sender text',
        html: null,
        task3QuoteProvenance: [],
      }),
    ).toMatchObject({ kind: 'none' });
    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'Subject: ordinary subject text',
        html: null,
        task3QuoteProvenance: [],
      }),
    ).toMatchObject({ kind: 'none' });
    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'Current reply\nFrom: example\nSent: earlier\nTo: recipient\nSubject: prior',
        html: null,
        task3QuoteProvenance: [],
      }),
    ).toMatchObject({ kind: 'outlook_headers', lineIndex: 1 });
    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'Current reply\nOn Tuesday, Sender wrote:\n> history',
        html: null,
        task3QuoteProvenance: ['on_wrote'],
      }),
    ).toMatchObject({ kind: 'on_wrote', provenance: ['on_wrote'] });
    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'Current reply',
        html: '<blockquote>synthetic HTML history</blockquote>',
        task3QuoteProvenance: [],
      }),
    ).toMatchObject({ kind: 'html_quote', lineIndex: null });
    expect(
      api.detectCenturionThreadReportQuoteBoundary({
        text: 'Current reply',
        html: '<div class="gmail_quote">synthetic HTML history</div>',
        task3QuoteProvenance: ['outlook_headers'],
      }),
    ).toMatchObject({
      kind: 'html_quote',
      provenance: ['outlook_headers'],
    });
  });
});

describe('Centurion private thread report publication', () => {
  it('ignores caller HOME for production candidate root', () => {
    const originalHome = process.env.HOME;
    process.env.HOME = resolve(tmpdir(), 'forged-candidate-home');
    try {
      expect(centurionThreadAuditCandidateOperatorRoot()).not.toBe(
        resolve(process.env.HOME, '.zero-centurion-operator'),
      );
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('derives production candidate root from OS user record', () => {
    const source = readFileSync(
      resolve(
        import.meta.dirname,
        '../src/ops/centurion-thread-audit-candidate.ts',
      ),
      'utf8',
    );

    expect(source).toContain('userInfo().homedir');
    expect(source).not.toContain('homedir()');
  });

  it('pins audit candidate verification to canonical operator root', async () => {
    const cli = await loadCli();

    expect(
      cli.centurionThreadAuditOperatorRoot({
        homeDirectory: '/operator-home',
        candidatePath: '/attacker-root/audit-snapshot-candidate.json',
      }),
    ).toBe(resolve('/operator-home', '.zero-centurion-operator'));
    expect(
      cli.centurionThreadAuditCandidateRoot({
        homeDirectory: '/operator-home',
        outputRoot: '/repo/.tmp-centurion-thread-adjudication',
      }),
    ).toBe(resolve('/operator-home', '.zero-centurion-operator'));
  });

  it('derives candidate path from sealed envelope digest', async () => {
    const cli = await loadCli();
    const digest = 'a'.repeat(64);

    expect(
      cli.centurionThreadAuditSnapshotCandidatePath({
        root: '/operator-home/.zero-centurion-operator',
        sealedEnvelopeDigest: digest,
      }),
    ).toBe(
      resolve(
        '/operator-home/.zero-centurion-operator',
        'candidates',
        `${digest}.json`,
      ),
    );
  });

  it.skipIf(process.platform !== 'linux')(
    'stages signed candidates only under isolated test operator root',
    async () => {
      const cli = await loadCli();
      const reports = render(
        await loadReports(),
        createThreadReportsFixture(),
      );
      const sandbox = mkdtempSync(join(tmpdir(), 'zero-task7a-candidate-'));
      const operatorRoot = join(sandbox, 'operator');

      try {
        const first = cli.writeCenturionThreadAuditSnapshotCandidateForTest({
          root: operatorRoot,
          operatorRoot,
          sealedEnvelopeBytes: reports.auditSnapshotEnvelopeBytes,
        });
        const second = cli.writeCenturionThreadAuditSnapshotCandidateForTest({
          root: operatorRoot,
          operatorRoot,
          sealedEnvelopeBytes: reports.auditSnapshotEnvelopeBytes,
        });

        expect(second).toBe(first);
        expect(first).toStartWith(join(operatorRoot, 'candidates'));
        expect(
          readVerifiedCenturionThreadAuditSnapshotCandidateForTest({
            path: first,
            operatorRoot,
          }),
        ).toBe(reports.auditSnapshotEnvelopeBytes);
        expect(statSync(first).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(sandbox, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'passes isolated candidate root through report writer handoff',
    async () => {
      const cli = await loadCli();
      const reports = render(
        await loadReports(),
        createThreadReportsFixture(),
      );
      const sandbox = mkdtempSync(join(tmpdir(), 'zero-task7a-report-'));
      const reportRoot = join(sandbox, 'reports-output');
      const candidateRoot = join(sandbox, 'operator');
      const canonicalRoot = cli.centurionThreadAuditOperatorRoot();
      const canonicalExisted = existsSync(canonicalRoot);
      const canonicalStat = canonicalExisted ? statSync(canonicalRoot) : null;

      try {
        cli.writeCenturionThreadAdjudicationReportRun(reportRoot, reports, {
          testOnlyCandidateOperatorRoot: candidateRoot,
        });

        expect(
          existsSync(join(candidateRoot, 'candidates')),
        ).toBe(true);
        expect(existsSync(canonicalRoot)).toBe(canonicalExisted);
        if (canonicalStat) {
          const after = statSync(canonicalRoot);
          expect(after.mtimeMs).toBe(canonicalStat.mtimeMs);
          expect(after.size).toBe(canonicalStat.size);
        }
      } finally {
        rmSync(sandbox, { force: true, recursive: true });
      }
    },
  );

  it('requires canonical root equality for candidate write and read', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../scripts/centurion-thread-adjudication.ts'),
      'utf8',
    );

    expect(source).toContain('resolve(input.root) !== canonicalRoot');
    expect(source).toContain('root !== canonicalRoot');
  });

  it('requires explicit apply/reports opt-in, preserves dry-run no-write, and publishes only a complete private run', async () => {
    const cli = await loadCli();
    const input = createThreadReportsFixture();
    const inputPath = '/private/.tmp-centurion-thread-adjudication/input.json';
    const rosterPath = '/private/.tmp-centurion-thread-adjudication/roster.json';
    const outputRoot = '/private/.tmp-centurion-thread-adjudication/output';
    const readFixture = (path: string) => {
      if (path.endsWith('input.json')) return JSON.stringify(input.corpora);
      if (path.endsWith('roster.json')) return JSON.stringify(input.roster);
      throw new Error('missing synthetic fixture');
    };
    const task3Writes: string[] = [];
    const reportRuns: Array<{ root: string; files: string[] }> = [];

    expect(() =>
      cli.parseCenturionThreadAdjudicationArgs([
        '--reports',
        '--input',
        inputPath,
        '--roster',
        rosterPath,
      ]),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORTS_REQUIRE_APPLY');

    const dryRun = cli.parseCenturionThreadAdjudicationArgs([
      '--input',
      inputPath,
      '--roster',
      rosterPath,
    ]);
    await cli.runCenturionThreadAdjudication(dryRun, {
      readText: readFixture,
      writeArtifacts: () => {
        throw new Error('dry run must not write Task 3 artifacts');
      },
      writeReportRun: () => {
        throw new Error('dry run must not write reports');
      },
    });

    const applyReports = cli.parseCenturionThreadAdjudicationArgs([
      '--apply',
      '--reports',
      '--input',
      inputPath,
      '--roster',
      rosterPath,
      '--output-root',
      outputRoot,
    ]);
    expect(applyReports).toMatchObject({ kind: 'apply', reports: true });
    expect(applyReports.metricDefinitionVersion).toBe('metric-definition-v2');
    await cli.runCenturionThreadAdjudication(applyReports, {
      readText: readFixture,
      createCacheEnvelope: (_root: string, records: unknown) => ({
        schema: 'centurion_thread_adjudication_cache_envelope_v1',
        records,
        signature: '0'.repeat(64),
      }),
      writeArtifacts: (_root: string, artifacts: Record<string, string>) => {
        task3Writes.push(...Object.keys(artifacts).sort());
      },
      writeReportRun: (root, reports) => {
        reportRuns.push({ root, files: Object.keys(reports.files).sort() });
      },
    });
    expect(task3Writes).toEqual([
      'adjudication.json',
      'cache.json',
    ]);
    expect(task3Writes.join('\n')).not.toContain(RAW_REPORT_SENTINELS.body);
    expect(reportRuns).toEqual([
      {
        root: applyReports.outputRoot,
        files: [
          'action-required-threads.md',
          'business-insights.md',
          'process-and-definitions.md',
          'reservation-thread-cases.md',
          'thread-index.json',
          'thread-metrics.csv',
        ],
      },
    ]);
  });

  it('rejects legacy report metric versions before apply writes', async () => {
    const cli = await loadCli();
    const input = createThreadReportsFixture();
    const inputPath = '/private/.tmp-centurion-thread-adjudication/input.json';
    const rosterPath = '/private/.tmp-centurion-thread-adjudication/roster.json';
    const command = cli.parseCenturionThreadAdjudicationArgs([
      '--apply',
      '--reports',
      '--input',
      inputPath,
      '--roster',
      rosterPath,
      '--output-root',
      '/private/.tmp-centurion-thread-adjudication/output',
      '--metric-definition-version',
      'metric-definition-v1',
    ]);
    const writes: string[] = [];
    const readFixture = (path: string) => {
      if (path.endsWith('input.json')) return JSON.stringify(input.corpora);
      if (path.endsWith('roster.json')) return JSON.stringify(input.roster);
      throw new Error('missing synthetic fixture');
    };

    await expect(
      cli.runCenturionThreadAdjudication(command, {
        readText: readFixture,
        createCacheEnvelope: () => {
          writes.push('cache');
          throw new Error('cache envelope must not be created');
        },
        writeArtifacts: () => writes.push('artifacts'),
        writeReportRun: () => writes.push('reports'),
      }),
    ).rejects.toThrow(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
    expect(writes).toEqual([]);
  });

  it('preserves structured business-insights CLI failures', async () => {
    const cli = await loadCli();

    expect(
      cli.safeCenturionThreadAdjudicationErrorCode(
        new Error('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID'),
      ),
    ).toBe('CENTURION_THREAD_BUSINESS_INSIGHTS_FACTS_INVALID');
  });

  it('fails closed for unsafe publication roots/files and leaves failed staging unpublished', async () => {
    const cli = await loadCli();
    const input = createThreadReportsFixture();
    const inputPath = '/private/.tmp-centurion-thread-adjudication/input.json';
    const rosterPath = '/private/.tmp-centurion-thread-adjudication/roster.json';
    const outputRoot = '/private/.tmp-centurion-thread-adjudication/output';
    const readFixture = (path: string) => {
      if (path.endsWith('input.json')) return JSON.stringify(input.corpora);
      if (path.endsWith('roster.json')) return JSON.stringify(input.roster);
      throw new Error('missing synthetic fixture');
    };
    const root = {
      path: outputRoot,
      realPath: outputRoot,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o40700,
      uid: 123,
    };

    expect(() =>
      cli.validateCenturionThreadAdjudicationApplyRoot({
        platform: 'linux',
        currentUid: 123,
        root: { ...root, isSymbolicLink: true },
      }),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_SYMLINK');
    expect(() =>
      cli.validateCenturionThreadAdjudicationApplyRoot({
        platform: 'linux',
        currentUid: 123,
        root: { ...root, mode: 0o40755 },
      }),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_PRIVATE');
    expect(() =>
      cli.validateCenturionThreadAdjudicationReportParent({
        currentUid: 123,
        parent: {
          isDirectory: true,
          isSymbolicLink: false,
          mode: 0o40700,
          uid: 123,
        },
      }),
    ).not.toThrow();
    expect(() =>
      cli.validateCenturionThreadAdjudicationReportParent({
        currentUid: 123,
        parent: {
          isDirectory: true,
          isSymbolicLink: true,
          mode: 0o40700,
          uid: 123,
        },
      }),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_PARENT_PRIVATE');
    expect(() =>
      cli.validateCenturionThreadAdjudicationReportFile({
        currentUid: 123,
        file: {
          isFile: true,
          isSymbolicLink: false,
          mode: 0o100644,
          uid: 123,
        },
      }),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_FILE_PRIVATE');
    expect(() =>
      cli.validateCenturionThreadAdjudicationReportFile({
        currentUid: 123,
        file: {
          isFile: true,
          isSymbolicLink: true,
          mode: 0o100600,
          uid: 123,
        },
      }),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_FILE_PRIVATE');
    expect(() =>
      cli.assertCenturionThreadAdjudicationReportRunName('../swap'),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_RUN_NAME_INVALID');
    const reportFiles = [
      'action-required-threads.md',
      'business-insights.md',
      'process-and-definitions.md',
      'reservation-thread-cases.md',
      'thread-index.json',
      'thread-metrics.csv',
    ];
    expect(() =>
      cli.assertCenturionThreadAdjudicationReportRunFiles(reportFiles),
    ).not.toThrow();
    expect(() =>
      cli.assertCenturionThreadAdjudicationReportRunFiles([
        ...reportFiles,
        'cache.json',
      ]),
    ).toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_FILES_INVALID');

    const applyReports = cli.parseCenturionThreadAdjudicationArgs([
      '--apply',
      '--reports',
      '--input',
      inputPath,
      '--roster',
      rosterPath,
      '--output-root',
      outputRoot,
    ]);
    const published: string[] = [];
    await expect(
      cli.runCenturionThreadAdjudication(applyReports, {
        readText: readFixture,
        createCacheEnvelope: (_root: string, records: unknown) => ({
          schema: 'centurion_thread_adjudication_cache_envelope_v1',
          records,
          signature: '0'.repeat(64),
        }),
        writeArtifacts: () => undefined,
        writeReportRun: () => {
          throw new Error('CENTURION_THREAD_ADJUDICATION_REPORT_STAGING_FAILED');
        },
      }),
    ).rejects.toThrow('CENTURION_THREAD_ADJUDICATION_REPORT_STAGING_FAILED');
    expect(published).toEqual([]);
  });

  it('keeps plain apply review-packet output unchanged', async () => {
    const cli = await loadCli();
    const input = createThreadReportsFixture();
    const inputPath = '/private/.tmp-centurion-thread-adjudication/input.json';
    const rosterPath = '/private/.tmp-centurion-thread-adjudication/roster.json';
    const command = cli.parseCenturionThreadAdjudicationArgs([
      '--apply',
      '--input',
      inputPath,
      '--roster',
      rosterPath,
      '--output-root',
      '/private/.tmp-centurion-thread-adjudication/output',
    ]);
    const writes: Record<string, string> = {};

    await cli.runCenturionThreadAdjudication(command, {
      readText: (path) => {
        if (path.endsWith('input.json')) return JSON.stringify(input.corpora);
        if (path.endsWith('roster.json')) return JSON.stringify(input.roster);
        throw new Error('missing synthetic fixture');
      },
      createCacheEnvelope: (_root, records) => ({
        schema: 'centurion_thread_adjudication_cache_envelope_v1',
        records,
        signature: '0'.repeat(64),
      }),
      writeArtifacts: (_root, artifacts) => Object.assign(writes, artifacts),
      writeReportRun: () => {
        throw new Error('plain apply must not write reports');
      },
    });

    expect(Object.keys(writes).sort()).toEqual([
      'adjudication.json',
      'cache.json',
      'review-packets.json',
    ]);
  });

  it.skipIf(process.platform !== 'linux')(
    'publishes a private report run through real Linux staging',
    async () => {
      const cli = await loadCli();
      const reportsApi = await loadReports();
      const input = createThreadReportsFixture();
      const root = mkdtempSync(join(tmpdir(), 'centurion-thread-reports-'));
      const unsafeRoot = `${root}-unsafe`;
      const candidateRoot = join(root, 'operator');
      const canonicalRoot = cli.centurionThreadAuditOperatorRoot();
      const canonicalExisted = existsSync(canonicalRoot);
      const canonicalStat = canonicalExisted ? statSync(canonicalRoot) : null;
      try {
        chmodSync(root, 0o700);
        const reports = render(reportsApi, input, 'c');
        cli.writeCenturionThreadAdjudicationReportRun(root, reports, {
          testOnlyCandidateOperatorRoot: candidateRoot,
        });

        const reportParent = join(root, 'reports');
        const runNames = readdirSync(reportParent);
        expect(runNames).toEqual([reports.receipt.runRef]);
        const run = join(reportParent, reports.receipt.runRef);
        expect(statSync(reportParent).mode & 0o777).toBe(0o700);
        expect(statSync(run).mode & 0o777).toBe(0o700);
        expect(readdirSync(run).sort()).toEqual([
          'action-required-threads.md',
          'business-insights.md',
          'process-and-definitions.md',
          'reservation-thread-cases.md',
          'thread-index.json',
          'thread-metrics.csv',
        ]);
        for (const name of readdirSync(run)) {
          expect(statSync(join(run, name)).mode & 0o777).toBe(0o600);
        }
        expect(readdirSync(reportParent).some((name) => name.startsWith('.'))).toBe(
          false,
        );
        expect(existsSync(join(candidateRoot, 'candidates'))).toBe(true);
        expect(existsSync(canonicalRoot)).toBe(canonicalExisted);
        if (canonicalStat) {
          const after = statSync(canonicalRoot);
          expect(after.mtimeMs).toBe(canonicalStat.mtimeMs);
          expect(after.size).toBe(canonicalStat.size);
        }

        symlinkSync(root, unsafeRoot, 'dir');
        expect(() =>
          cli.writeCenturionThreadAdjudicationReportRun(unsafeRoot, reports),
        ).toThrow('CENTURION_THREAD_ADJUDICATION_APPLY_ROOT_SYMLINK');
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(unsafeRoot, { recursive: true, force: true });
      }
    },
  );
});

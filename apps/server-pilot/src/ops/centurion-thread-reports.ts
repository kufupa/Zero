import { createHash } from 'node:crypto';
import type {
  CenturionThreadAdjudicationClassification,
  CenturionThreadAdjudicationResult,
  CenturionThreadAdjudicationTurn,
} from './centurion-thread-adjudication.js';
import type {
  ResponseGap,
  ThreadConversationComponent,
  VerifiedInternalEvidence,
} from './centurion-thread-intelligence.js';
import {
  CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
  buildCenturionThreadBusinessFacts,
  renderCenturionThreadBusinessInsights,
  type CenturionThreadBusinessFacts,
  type CenturionThreadBusinessInsightsInput,
} from './centurion-thread-business-insights.js';
import {
  createCenturionThreadAuditSafeSource,
  sealCenturionThreadAuditSnapshot,
  serializeSealedCenturionThreadAuditSnapshot,
} from './centurion-thread-audit-snapshot.js';
import {
  parsePersistedCenturionThreadStateCorpus,
  type CenturionThreadStateCorpus,
  type CenturionThreadStateCorpusMessage,
} from './centurion-thread-state-corpus.js';

export const CENTURION_THREAD_REPORTS_SCHEMA =
  'centurion_thread_reports_v1' as const;

export const CENTURION_THREAD_REPORT_FILES = [
  'thread-index.json',
  'reservation-thread-cases.md',
  'action-required-threads.md',
  'thread-metrics.csv',
  'process-and-definitions.md',
  'business-insights.md',
] as const;

const CLOSED_RESERVATION_CLASSIFICATIONS = new Set<
  CenturionThreadAdjudicationClassification
>([
  'new_reservation_request',
  'quote_acceptance',
  'booking_instruction',
]);

const REPORT_REFERENCE_KINDS = ['run', 'case', 'message', 'thread'] as const;
const REPORT_REFERENCE = /^(run|case|message|thread)_[a-f0-9]{64}$/u;
const MAX_CURRENT_EXCERPT_BYTES = 2_048;
const MAX_QUOTED_EXCERPT_BYTES = 2_048;
const MAX_PRIVATE_FIELD_BYTES = 512;
const BUSINESS_CLASSIFICATIONS = [
  'new_reservation_request',
  'quote_acceptance',
  'booking_instruction',
  'customer_acknowledgement',
  'internal_handoff',
  'unrelated_follow_up',
  'automated_or_non_actionable',
  'ambiguous',
  'staff_response',
] as const;

type BusinessClassification =
  CenturionThreadBusinessInsightsInput['components'][number]['classificationCounts'][number]['classification'];

export type CenturionThreadReportReferenceKind =
  (typeof REPORT_REFERENCE_KINDS)[number];

export type CenturionThreadReportReferenceFactory = (
  kind: CenturionThreadReportReferenceKind,
) => string;

export type CenturionThreadReportTimingStatus =
  | 'observed'
  | 'excluded'
  | 'unknown';

export type CenturionThreadReportsInput = {
  corpora: readonly unknown[];
  adjudication: CenturionThreadAdjudicationResult;
  generatedAt: string;
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
  referenceFactory: CenturionThreadReportReferenceFactory;
};

export type CenturionThreadReportsReceipt = {
  schema: 'centurion_thread_reports_receipt_v1';
  runRef: string;
  componentCount: number;
  reservationCaseCount: number;
  actionRequiredCaseCount: number;
  outputDigest: string;
};

export type CenturionThreadReportsResult = {
  schema: typeof CENTURION_THREAD_REPORTS_SCHEMA;
  receipt: CenturionThreadReportsReceipt;
  auditSnapshotEnvelopeBytes: string;
  renderedMarkdown: {
    reservationCaseRefs: readonly string[];
    actionCaseRefs: readonly string[];
  };
  files: Record<(typeof CENTURION_THREAD_REPORT_FILES)[number], string>;
};

type ReportTiming = {
  status: CenturionThreadReportTimingStatus;
  reason:
    | 'no_persisted_roster_response'
    | 'no_actionable_external_turn'
    | 'missing_event_time'
    | 'unrecognized_gap'
    | null;
};

type ReportGap = {
  kind: ResponseGap['kind'];
  actionableMessageRef: string;
  responseMessageRef: string | null;
  durationMs: number | null;
  timing: ReportTiming;
};

type PrivateThreadMapping = {
  threadRef: string;
  rawThreadId: string;
};

type PrivateTurn = {
  message: CenturionThreadStateCorpusMessage;
  messageRef: string;
  threadRef: string;
  turn: CenturionThreadAdjudicationTurn;
  chronology: ThreadConversationComponent['chronology'][number];
  task3QuoteProvenance: readonly string[];
};

type RenderedComponent = {
  caseRef: string;
  component: ThreadConversationComponent;
  turns: readonly PrivateTurn[];
  reservationScope: 'confirmed' | 'potential' | 'not_reservation_related';
  timing: ReportTiming & { firstResponseLatencyMs: number | null };
  responseGaps: readonly ReportGap[];
  publicIndex: Record<string, unknown>;
  privateThreadMappings: readonly PrivateThreadMapping[];
};

function fail(code: string): never {
  throw new Error(code);
}

function businessClassification(value: string): BusinessClassification {
  if (!(BUSINESS_CLASSIFICATIONS as readonly string[]).includes(value)) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
  return value as BusinessClassification;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CENTURION_THREAD_REPORTS_INPUT_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  fail('CENTURION_THREAD_REPORTS_INPUT_INVALID');
}

function version(value: string, code: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) fail(code);
  return value;
}

function validateGeneratedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(new Date(value).getTime())) {
    fail('CENTURION_THREAD_REPORTS_GENERATED_AT_INVALID');
  }
  return new Date(value).toISOString();
}

function requireReportReference(
  kind: CenturionThreadReportReferenceKind,
  value: string,
): string {
  const match = REPORT_REFERENCE.exec(value);
  if (!match || match[1] !== kind) {
    fail('CENTURION_THREAD_REPORTS_REFERENCE_INVALID');
  }
  return value;
}

class ReportReferenceAllocator {
  readonly #seen = new Set<string>();

  constructor(
    private readonly factory: CenturionThreadReportReferenceFactory,
  ) {}

  create(kind: CenturionThreadReportReferenceKind): string {
    const reference = requireReportReference(kind, this.factory(kind));
    if (this.#seen.has(reference)) {
      fail('CENTURION_THREAD_REPORTS_REFERENCE_DUPLICATE');
    }
    this.#seen.add(reference);
    return reference;
  }
}

export function createCenturionThreadReportReferenceFactory(
  randomBytes: (size: number) => Uint8Array,
): CenturionThreadReportReferenceFactory {
  const issued = new Set<string>();
  return (kind) => {
    const bytes = randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
      fail('CENTURION_THREAD_REPORTS_RANDOM_SOURCE_INVALID');
    }
    const reference = `${kind}_${Buffer.from(bytes).toString('hex')}`;
    if (issued.has(reference)) {
      fail('CENTURION_THREAD_REPORTS_RANDOM_REFERENCE_COLLISION');
    }
    issued.add(reference);
    return reference;
  };
}

export function escapeCenturionThreadReportCsv(value: string): string {
  return /[",\n\r]/u.test(value)
    ? `"${value.replace(/"/gu, '""')}"`
    : value;
}

export function escapeCenturionThreadReportMarkdown(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_{}[\]<>()[\]#+\-.!|])/gu, '\\$1');
}

export function truncateCenturionThreadReportUtf8(input: {
  value: string;
  maxBytes: number;
}): { value: string; truncated: boolean } {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 64) {
    fail('CENTURION_THREAD_REPORTS_EXCERPT_LIMIT_INVALID');
  }
  const normalized = input.value
    .replaceAll('\u0000', '\uFFFD')
    .replace(/\r\n?/gu, '\n')
    .trim();
  if (Buffer.byteLength(normalized, 'utf8') <= input.maxBytes) {
    return { value: normalized, truncated: false };
  }
  const suffix = '\n[truncated at UTF-8 byte limit]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const budget = input.maxBytes - suffixBytes;
  let used = 0;
  let prefix = '';
  for (const character of normalized) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > budget) break;
    prefix += character;
    used += bytes;
  }
  return { value: `${prefix}${suffix}`, truncated: true };
}

function plaintextFromHtml(value: string): string {
  return value
    .replace(/<\s*br\s*\/?\s*>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"');
}

function rawMessageText(message: CenturionThreadStateCorpusMessage): string {
  return message.textBody ?? (message.htmlBody ? plaintextFromHtml(message.htmlBody) : '');
}

export type CenturionThreadReportQuoteBoundary = {
  kind:
    | 'none'
    | 'quoted_line'
    | 'on_wrote'
    | 'divider'
    | 'outlook_headers'
    | 'html_quote'
    | 'task3_evidence';
  lineIndex: number | null;
  provenance: readonly string[];
};

export function detectCenturionThreadReportQuoteBoundary(input: {
  text: string;
  html: string | null;
  task3QuoteProvenance: readonly string[];
}): CenturionThreadReportQuoteBoundary {
  const lines = input.text.replace(/\r\n?/gu, '\n').split('\n');
  const provenance = [...new Set(input.task3QuoteProvenance)].sort();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^\s*>/u.test(line)) {
      return { kind: 'quoted_line', lineIndex: index, provenance };
    }
    if (/^\s*on .+ wrote:\s*$/iu.test(line)) {
      return { kind: 'on_wrote', lineIndex: index, provenance };
    }
    if (/^\s*(?:-{3,}\s*original message\s*-{3,}|_{3,})\s*$/iu.test(line)) {
      return { kind: 'divider', lineIndex: index, provenance };
    }
    if (!/^\s*(?:from|sent|to|subject):/iu.test(line)) continue;
    let headerCount = 0;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      if (!/^\s*(?:from|sent|to|subject):/iu.test(lines[cursor] ?? '')) break;
      headerCount += 1;
    }
    if (headerCount >= 2) {
      return { kind: 'outlook_headers', lineIndex: index, provenance };
    }
  }
  if (
    input.html !== null &&
    /<\s*blockquote\b|(?:class|id)\s*=\s*["'][^"']*\bgmail_quote\b/iu.test(
      input.html,
    )
  ) {
    return { kind: 'html_quote', lineIndex: null, provenance };
  }
  if (provenance.length > 0) {
    return { kind: 'task3_evidence', lineIndex: null, provenance };
  }
  return { kind: 'none', lineIndex: null, provenance };
}

function splitCurrentAndQuotedText(turn: PrivateTurn): {
  current: { value: string; truncated: boolean };
  quoted: { value: string; truncated: boolean } | null;
  boundary: CenturionThreadReportQuoteBoundary;
} {
  const raw = rawMessageText(turn.message);
  const lines = raw
    .replace(/\r\n?/gu, '\n')
    .split('\n');
  const boundary = detectCenturionThreadReportQuoteBoundary({
    text: raw,
    html: turn.message.htmlBody,
    task3QuoteProvenance: turn.task3QuoteProvenance,
  });
  const current = truncateCenturionThreadReportUtf8({
    value: (
      boundary.lineIndex === null ? lines : lines.slice(0, boundary.lineIndex)
    ).join('\n'),
    maxBytes: MAX_CURRENT_EXCERPT_BYTES,
  });
  if (boundary.kind === 'none') return { current, quoted: null, boundary };
  return {
    current,
    quoted: truncateCenturionThreadReportUtf8({
      value:
        boundary.lineIndex === null
          ? `[Quoted history indicated by ${boundary.kind}]`
          : lines.slice(boundary.lineIndex).join('\n'),
      maxBytes: MAX_QUOTED_EXCERPT_BYTES,
    }),
    boundary,
  };
}

function privateField(value: string): string {
  return escapeCenturionThreadReportMarkdown(
    truncateCenturionThreadReportUtf8({
      value,
      maxBytes: MAX_PRIVATE_FIELD_BYTES,
    }).value,
  );
}

function renderPrivateCodeBlock(value: string): string {
  const text = value || '(empty)';
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function threadKey(transportId: string, persistedThreadId: string): string {
  return `${transportId}\u0000${persistedThreadId}`;
}

function normalizedIdentity(value: string): string {
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
  const bracketed = normalized.match(/<([^<>\s]+)>/u)?.[1];
  const candidate = bracketed ?? normalized;
  const email = candidate.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  )?.[0];
  return (email ?? candidate).toLocaleLowerCase('en-US');
}

function canonicalEventTime(message: CenturionThreadStateCorpusMessage): {
  value: string | null;
  source: 'received_at' | 'sent_at' | 'created_at' | 'missing';
} {
  const candidates =
    message.direction === 'inbound'
      ? [
          [message.timestamps.receivedAt, 'received_at'],
          [message.timestamps.createdAt, 'created_at'],
        ]
      : [
          [message.timestamps.sentAt, 'sent_at'],
          [message.timestamps.createdAt, 'created_at'],
        ];
  for (const [timestamp, source] of candidates) {
    if (timestamp === null || timestamp.endsWith('-00:00')) continue;
    const epoch = new Date(timestamp).getTime();
    if (!Number.isNaN(epoch)) {
      return {
        value: new Date(epoch).toISOString(),
        source: source as 'received_at' | 'sent_at' | 'created_at',
      };
    }
  }
  return { value: null, source: 'missing' };
}

function assertChronologyBinding(input: {
  message: CenturionThreadStateCorpusMessage;
  chronology: ThreadConversationComponent['chronology'][number];
  component: ThreadConversationComponent;
}): void {
  const expectedEventTime = canonicalEventTime(input.message);
  const senderIdentity = normalizedIdentity(input.message.participants.from);
  const senderRoles = input.component.participantRoles.filter(
    (participant) => normalizedIdentity(participant.identity) === senderIdentity,
  );
  if (
    input.chronology.transportId !== input.message.transportId ||
    input.chronology.persistedThreadId !== input.message.threadId ||
    input.chronology.direction !== input.message.direction ||
    input.chronology.eventTime.value !== expectedEventTime.value ||
    input.chronology.eventTime.source !== expectedEventTime.source ||
    senderRoles.length !== 1 ||
    senderRoles[0]!.role !== input.chronology.senderRole
  ) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
}

function timingForGap(gap: ResponseGap): ReportTiming {
  if (gap.durationMs !== null) {
    if (
      !Number.isFinite(gap.durationMs) ||
      gap.durationMs < 0 ||
      !gap.responseMessageId ||
      gap.reason !== null
    ) {
      fail('CENTURION_THREAD_REPORTS_TIMING_INVALID');
    }
    return { status: 'observed', reason: null };
  }
  if (gap.responseMessageId !== null) {
    fail('CENTURION_THREAD_REPORTS_TIMING_INVALID');
  }
  if (gap.reason === 'no_persisted_roster_response') {
    return { status: 'excluded', reason: 'no_persisted_roster_response' };
  }
  if (gap.reason === 'missing_event_time') {
    return { status: 'unknown', reason: 'missing_event_time' };
  }
  fail('CENTURION_THREAD_REPORTS_TIMING_INVALID');
}

function componentTiming(input: {
  component: ThreadConversationComponent;
  responseGaps: readonly ReportGap[];
}): ReportTiming & { firstResponseLatencyMs: number | null } {
  const firstGap = input.responseGaps[0];
  if (!firstGap) {
    if (input.component.firstResponseLatencyMs !== null) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    return {
      status: 'excluded',
      reason: 'no_actionable_external_turn',
      firstResponseLatencyMs: null,
    };
  }
  if (input.component.firstResponseLatencyMs !== firstGap.durationMs) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
  return {
    ...firstGap.timing,
    firstResponseLatencyMs: firstGap.durationMs,
  };
}

function reservationScopeFor(input: {
  component: ThreadConversationComponent;
  turns: readonly CenturionThreadAdjudicationTurn[];
}): 'confirmed' | 'potential' | 'not_reservation_related' {
  if (
    input.turns.some(
      (turn) =>
        turn.annotationFinal &&
        turn.classification !== null &&
        CLOSED_RESERVATION_CLASSIFICATIONS.has(turn.classification),
    )
  ) {
    return 'confirmed';
  }
  const hasUnresolvedExternalTurn = input.component.chronology.some(
    (chronologyTurn) => {
      const turn = input.turns.find(
        (candidate) => candidate.messageId === chronologyTurn.messageId,
      );
      return (
        chronologyTurn.senderRole === 'external' &&
        turn?.classification === 'ambiguous'
      );
    },
  );
  return input.component.state === 'action_required' || hasUnresolvedExternalTurn
    ? 'potential'
    : 'not_reservation_related';
}

function classificationSummary(
  turns: readonly CenturionThreadAdjudicationTurn[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const turn of turns) {
    const key = turn.classification ?? turn.operationalKind;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(summary).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

function roleCounts(component: ThreadConversationComponent): {
  internalCount: number;
  externalCount: number;
  roles: readonly ('internal' | 'external')[];
} {
  const internalCount = component.participantRoles.filter(
    (participant) => participant.role === 'internal',
  ).length;
  const externalCount = component.participantRoles.filter(
    (participant) => participant.role === 'external',
  ).length;
  const roles: ('internal' | 'external')[] = [];
  if (internalCount > 0) roles.push('internal');
  if (externalCount > 0) roles.push('external');
  return { internalCount, externalCount, roles };
}

function verifiedEvidenceForIndex(
  evidence: VerifiedInternalEvidence | null,
  messageRefs: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!evidence) return null;
  const sourceMessageRef = messageRefs.get(evidence.sourceMessageId);
  if (!sourceMessageRef) fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  return {
    tier: evidence.tier,
    sourceMessageRef,
    observedAt: evidence.observedAt,
    quoteProvenance: evidence.quoteProvenance,
  };
}

function percentileNearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil((percentile / 100) * ordered.length) - 1)] ?? null;
}

function distribution<T extends string>(
  values: readonly T[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

function validateReportInput(
  input: CenturionThreadReportsInput,
): {
  corpora: readonly CenturionThreadStateCorpus[];
  adjudication: CenturionThreadAdjudicationResult;
  generatedAt: string;
} {
  if (!Array.isArray(input.corpora) || input.corpora.length === 0) {
    fail('CENTURION_THREAD_REPORTS_CANONICAL_CORPORA_REQUIRED');
  }
  version(
    input.identityRulesVersion,
    'CENTURION_THREAD_REPORTS_IDENTITY_RULES_VERSION_INVALID',
  );
  version(
    input.classifierVersion,
    'CENTURION_THREAD_REPORTS_CLASSIFIER_VERSION_INVALID',
  );
  version(
    input.metricDefinitionVersion,
    'CENTURION_THREAD_REPORTS_METRIC_DEFINITION_VERSION_INVALID',
  );
  if (
    input.metricDefinitionVersion !==
    CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION
  ) {
    fail(
      'CENTURION_THREAD_BUSINESS_INSIGHTS_UNSUPPORTED_METRIC_DEFINITION_VERSION',
    );
  }
  if (typeof input.referenceFactory !== 'function') {
    fail('CENTURION_THREAD_REPORTS_REFERENCE_FACTORY_REQUIRED');
  }
  if (
    input.adjudication?.schema !== 'centurion_thread_adjudication_v1' ||
    !Array.isArray(input.adjudication.turns) ||
    !input.adjudication.threadIntelligence ||
    input.adjudication.threadIntelligence.schema !==
      'centurion_thread_intelligence_v1' ||
    !Array.isArray(input.adjudication.threadIntelligence.components)
  ) {
    fail('CENTURION_THREAD_REPORTS_ADJUDICATION_INVALID');
  }
  return {
    corpora: input.corpora.map(parsePersistedCenturionThreadStateCorpus),
    adjudication: input.adjudication,
    generatedAt: validateGeneratedAt(input.generatedAt),
  };
}

function renderMetricsCsv(
  components: readonly RenderedComponent[],
): string {
  const header = [
    'row_type',
    'case_ref',
    'reservation_scope',
    'final_state',
    'timing_status',
    'timing_reason',
    'first_response_latency_ms',
    'response_gap_count',
    'observed_response_gap_count',
    'turn_count',
    'internal_participant_count',
    'external_participant_count',
    'persisted_thread_count',
    'elapsed_duration_ms',
    'multi_message',
    'three_plus_messages',
    'aggregate_dimension',
    'aggregate_value',
    'component_count',
  ];
  const rows: string[][] = [];
  for (const rendered of components) {
    const roles = roleCounts(rendered.component);
    rows.push([
      'component',
      rendered.caseRef,
      rendered.reservationScope,
      rendered.component.state,
      rendered.timing.status,
      rendered.timing.reason ?? '',
      rendered.timing.firstResponseLatencyMs?.toString() ?? '',
      rendered.responseGaps.length.toString(),
      rendered.responseGaps
        .filter((gap) => gap.timing.status === 'observed')
        .length.toString(),
      rendered.turns.length.toString(),
      roles.internalCount.toString(),
      roles.externalCount.toString(),
      rendered.privateThreadMappings.length.toString(),
      rendered.component.elapsedDuration.milliseconds?.toString() ?? '',
      String(rendered.turns.length >= 2),
      String(rendered.turns.length >= 3),
      '',
      '',
      '',
    ]);
  }
  const aggregateDimensions = [
    ['state', distribution(components.map((component) => component.component.state))],
    [
      'reservation_scope',
      distribution(components.map((component) => component.reservationScope)),
    ],
    ['timing_status', distribution(components.map((component) => component.timing.status))],
  ] as const;
  for (const [dimension, counts] of aggregateDimensions) {
    for (const [value, count] of Object.entries(counts)) {
      rows.push([
        'aggregate',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        dimension,
        value,
        count.toString(),
      ]);
    }
  }
  return `${[header, ...rows]
    .map((row) => row.map(escapeCenturionThreadReportCsv).join(','))
    .join('\n')}\n`;
}

function renderPrivateThreadMap(
  mappings: readonly PrivateThreadMapping[],
): string[] {
  return mappings.flatMap((mapping) => [
    `- \`${mapping.threadRef}\` → ${privateField(mapping.rawThreadId)}`,
  ]);
}

function renderPrivateTurn(turn: PrivateTurn): string[] {
  const excerpts = splitCurrentAndQuotedText(turn);
  const recipients = [
    ...turn.message.participants.to,
    ...turn.message.participants.cc,
    ...turn.message.participants.bcc,
  ];
  return [
    `### Turn \`${turn.messageRef}\``,
    `- Persisted thread: \`${turn.threadRef}\``,
    `- Event: ${turn.chronology.eventTime.value ?? 'unknown'} (${turn.chronology.eventTime.source})`,
    `- Direction / sender role: \`${turn.chronology.direction}\` / \`${turn.chronology.senderRole}\``,
    `- Classification: \`${turn.turn.classification ?? turn.turn.operationalKind}\``,
    `- Subject: ${privateField(turn.message.subject)}`,
    `- From: ${privateField(turn.message.participants.from)}`,
    `- Recipients: ${privateField(recipients.join(', ') || '(none)')}`,
    `- Current text (UTF-8 bounded${excerpts.current.truncated ? '; truncated' : ''}):`,
    renderPrivateCodeBlock(excerpts.current.value),
    `- Quoted-history boundary: \`${excerpts.quoted ? 'quoted_history_present' : 'quoted_history_absent'}\` (${excerpts.boundary.kind})`,
    ...(excerpts.boundary.provenance.length > 0
      ? [
          `- Task 3 quote provenance: ${excerpts.boundary.provenance
            .map((marker) => `\`${marker}\``)
            .join(', ')}`,
        ]
      : []),
    ...(excerpts.quoted
      ? [
          `- Quoted history (UTF-8 bounded${excerpts.quoted.truncated ? '; truncated' : ''}):`,
          renderPrivateCodeBlock(excerpts.quoted.value),
        ]
      : []),
  ];
}

function renderReservationCasesMarkdown(
  components: readonly RenderedComponent[],
): { markdown: string; caseRefs: readonly string[] } {
  const cases = components.filter(
    (component) => component.reservationScope !== 'not_reservation_related',
  );
  const lines = [
    '# Reservation thread cases',
    '',
    'Private local-only artifact. Raw fields below must not leave private run directory.',
  ];
  if (cases.length === 0) lines.push('', 'No confirmed or potential reservation cases.');
  for (const rendered of cases) {
    lines.push(
      '',
      `## Case \`${rendered.caseRef}\``,
      `- Reservation scope: \`${rendered.reservationScope}\``,
      `- Final state: \`${rendered.component.state}\``,
      `- Turn count: ${rendered.turns.length}`,
      '- Persisted-thread map:',
      ...renderPrivateThreadMap(rendered.privateThreadMappings),
      '',
      '### Ordered key turns',
    );
    for (const turn of rendered.turns) {
      lines.push('', ...renderPrivateTurn(turn));
    }
  }
  return {
    markdown: `${lines.join('\n')}\n`,
    caseRefs: cases.map((rendered) => rendered.caseRef),
  };
}

function evidenceTurnIds(rendered: RenderedComponent): {
  persisted: readonly string[];
  quoted: readonly string[];
} {
  const persisted = new Set(
    rendered.turns
      .filter((turn) => turn.turn.operationalKind === 'staff_response')
      .map((turn) => turn.message.id),
  );
  const quoted = new Set<string>();
  for (const evidence of rendered.component.quotedEvidence) {
    quoted.add(evidence.sourceMessageId);
  }
  return { persisted: [...persisted].sort(), quoted: [...quoted].sort() };
}

function renderActionRequiredMarkdown(
  components: readonly RenderedComponent[],
): { markdown: string; caseRefs: readonly string[] } {
  const cases = components.filter(
    (component) => component.component.state === 'action_required',
  );
  const lines = [
    '# Action-required threads',
    '',
    'Private local-only artifact. Timing is observed only from persisted roster response gaps.',
  ];
  if (cases.length === 0) lines.push('', 'No action-required components.');
  for (const rendered of cases) {
    const rawTurnsById = new Map(
      rendered.turns.map((turn) => [turn.message.id, turn]),
    );
    const latestActionId = rendered.component.actionEvidence.messageId;
    const latestAction = latestActionId
      ? rawTurnsById.get(latestActionId)
      : undefined;
    if (!latestAction) fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    const evidence = evidenceTurnIds(rendered);
    lines.push(
      '',
      `## Case \`${rendered.caseRef}\``,
      `- Reservation scope: \`${rendered.reservationScope}\``,
      '- Persisted-thread map:',
      ...renderPrivateThreadMap(rendered.privateThreadMappings),
      '',
      '### Latest actionable request',
      ...renderPrivateTurn(latestAction),
      '',
      '### Observed persisted response evidence',
    );
    if (evidence.persisted.length === 0) {
      lines.push('- None observed.');
    }
    for (const messageId of evidence.persisted) {
      const turn = rawTurnsById.get(messageId);
      if (!turn) fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      const timing = rendered.responseGaps.find(
        (gap) => gap.responseMessageRef === turn.messageRef,
      )?.timing;
      lines.push(
        `- \`${turn.messageRef}\`: evidence tier \`persisted_reply\`; timing eligibility \`${timing?.status === 'observed' ? 'eligible_observed' : 'excluded_not_response_gap'}\``,
        ...renderPrivateTurn(turn),
      );
    }
    lines.push('', '### Observed quoted response evidence');
    if (evidence.quoted.length === 0) {
      lines.push('- None observed.');
    }
    for (const messageId of evidence.quoted) {
      const turn = rawTurnsById.get(messageId);
      if (!turn) fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      const excerpts = splitCurrentAndQuotedText(turn);
      lines.push(
        `- \`${turn.messageRef}\`: evidence tier \`quoted_reply\`; timing eligibility \`excluded_quoted_evidence_not_latency\``,
        '- Quoted evidence excerpt:',
        renderPrivateCodeBlock(excerpts.quoted?.value ?? '(quoted boundary not extractable)'),
      );
    }
  }
  return {
    markdown: `${lines.join('\n')}\n`,
    caseRefs: cases.map((rendered) => rendered.caseRef),
  };
}

function renderDefinitionsMarkdown(input: {
  runRef: string;
  generatedAt: string;
  corpora: readonly CenturionThreadStateCorpus[];
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
}): string {
  const lines = [
    '# Process and definitions',
    '',
    'Private local-only report run. This file contains no raw message fields.',
    '',
    '## Field dictionary',
    '- `caseRef`, `messageRef`, and `threadRef`: fresh per-run opaque references. They are not Task 3 component/message references or stable hashes.',
    '- Component: one Task 2/3 conversation component; metric denominators are components, never persisted-thread mappings.',
    '- `persistedThreadRefs`: opaque map labels. Raw persisted thread values exist only in private Markdown case artifacts.',
    '- `classificationSummary`: Task 3 closed semantic classifications plus the separate `staff_response` operational kind.',
    '',
    '## State, evidence, and latency rules',
    '- Final state is Task 2/3 component state without reinterpretation.',
    '- Persisted response evidence is Task 2 roster-confirmed response evidence. Quoted evidence remains evidence only.',
    '- Timing `observed` requires a non-null Task 2 persisted-roster response gap duration.',
    '- Timing `excluded` has no eligible persisted response gap (including no actionable external turn or no persisted roster response).',
    '- Timing `unknown` has missing/invalid time evidence. Quoted evidence never supplies latency.',
    '- p50 and p95 use nearest-rank percentile over observed response-gap durations only.',
    '',
    '## Reservation scope rule',
    '- `confirmed`: at least one final Task 3 classification is `new_reservation_request`, `quote_acceptance`, or `booking_instruction`.',
    '- `potential`: no confirmed label, but component is action-required or has an unresolved external ambiguous turn.',
    '- `not_reservation_related`: neither confirmed nor potential. Potential cases never inflate confirmed rates.',
    '',
    '## False-positive examples',
    '- Automated acknowledgement is not a reservation request.',
    '- Internal handoff is not a guest reservation request.',
    '- Quoted wording can support context but cannot create response latency.',
    '',
    '## Task 6 business-insight metric contract',
    '- `business-insights.md` is a sixth private report-run member. It receives only safe aggregate/component projections and current-run `runRef` / `caseRef` references.',
    '- Sections render exactly in this order: `decision_readiness`, `current_work_queue`, `observed_service_timing`, `conversation_outcomes`, `operational_complexity`, `automation_prerequisites`, `revenue_metrics`.',
    '- Decision readiness is `valid` only with complete source coverage, known cutoffs, reconciled membership, accounted parser exceptions, and closed terminal/manual component states; otherwise it is `not_available` and operational values are suppressed.',
    '- Any pending Task 3 review flag or nonempty review queue forces report-local decision readiness to `not_available`; this safe boolean carries no message, component, or cache reference.',
    '- Pending review recovery is fixed to manual Task 3 review, bounded decision, evidence verification, and rerun; it does not direct source-coverage or authoritative-PMS work.',
    '- Metric availability is `available`, `not_available`, or `not_evaluated`. An unavailable value is not zero.',
    '- Claim status is `fact`, `evidence_limited`, or `hypothesis`; a hypothesis names its cheapest next proof. Confidence is `high`, `medium`, `low`, or `not_available`; `high` requires complete persisted evidence.',
    '- Business impact is limited to `commercial_follow_up_hypothesis`, `guest_trust`, `staff_time`, or `data_quality`. No financial result is inferred from mail evidence.',
    '- Queue buckets are `act_now` for `action_required` and `review_today` for `needs_manual_adjudication`. Age buckets use trusted latest-action event time and generated time only; they are not SLA values.',
    '- Handoff status is `no_handoff_observed`, `internal_handoff_observed`, or `handoff_evidence_limited`. Recommendation and next-human-check codes are fixed closed vocabularies.',
    '- Insight examples contain zero to three current-run `caseRef` values plus `outlier`, `aged_action`, `ambiguity`, or `impact`. No example contains a message/thread reference, source path, excerpt, or raw identifier.',
    '- Observed response timing uses persisted roster-attributed response gaps only and remains `observed`, `excluded`, or `unknown`; quote evidence never provides latency. Safe aggregate buckets name quote-only, automated, ambiguous, duplicate, missing-event-time, incomplete, and pending-review cases; invalid snapshots name buckets but suppress their counts.',
    '- Every available rate carries numerator, denominator, excluded/unknown count, eligibility rule, timestamp basis, evidence tier, source digest, classifier version, and metric-definition version in compact value metadata.',
    '- Quote-to-confirmation, booking value, conversion, revenue, attachment/document dependency, late ingest, and agent-evaluation metrics remain status-coded until their authoritative contracts exist.',
    '',
    '## Task 6 metric definitions',
    '- `decision_readiness`: formula=all snapshot trust gates are true; eligibility=all report components; exclusions=any incomplete coverage, cutoff, membership, parser, or closure gate; timestamp_basis=generated-at plus corpus cutoffs.',
    '- `current_work_queue`: formula=component counts by final `action_required` / `needs_manual_adjudication` state; eligibility=valid snapshot components; exclusions=not-available snapshot; timestamp_basis=trusted latest actionable event and generated-at for age buckets.',
    '- `observed_service_timing`: formula=observed persisted-roster response-gap count and nearest-rank p50/p95 duration; eligibility=valid snapshot observed gaps; exclusions=excluded/unknown gaps plus quote-only, automated, ambiguous, duplicate, missing-event-time, incomplete, and pending-review buckets; timestamp_basis=Task 2 event times.',
    '- `conversation_outcomes`: formula=final classification counts, with manual/ambiguous count deduplicated by component; eligibility=valid snapshot with complete final classification coverage; exclusions=incomplete or unclassified components; timestamp_basis=final Task 3 annotations.',
    '- `operational_complexity`: formula=component-normalized message, thread, participant, handoff, duplicate, and quote-history indicators; eligibility=valid snapshot and nonzero denominator for rates; exclusions=zero denominators are not available; timestamp_basis=snapshot cutoff.',
    '- `automation_prerequisites`: formula=grounding coverage and bounded data-blocker counts; eligibility=valid snapshot and nonzero component denominator for coverage rate; exclusions=zero denominator is not available and draft metrics lack an approved cohort; timestamp_basis=snapshot cutoff.',
    '- `revenue_metrics`: formula=not computed from mail evidence; eligibility=authoritative PMS/folio/availability contract only; exclusions=all current mail-only snapshots; timestamp_basis=authoritative source when approved.',
    '- `available` means an eligible grounded value; `not_available` is not zero; `not_evaluated` has no approved evaluation contract.',
    '',
    '## Private run command',
    '`centurion-thread-adjudication.ts --apply --reports --input PATH --roster PATH --output-root PATH`',
    '',
    '## Corpus provenance and digests',
    `- Run reference: \`${input.runRef}\``,
    `- Generated at: \`${input.generatedAt}\``,
    `- Identity rules version: \`${input.identityRulesVersion}\``,
    `- Classifier version: \`${input.classifierVersion}\``,
    `- Metric definition version: \`${input.metricDefinitionVersion}\``,
    ...input.corpora.flatMap((corpus, index) => [
      `- Corpus ${index + 1}: schema \`${corpus.source.schemaVersion}\`, digest \`${corpus.manifest.corpusSha256}\`, event cutoff \`${corpus.source.eventCutoff}\`, ingest cutoff \`${corpus.source.ingestCutoff}\`, messages ${corpus.messages.length}.`,
    ]),
    '',
    '## Future-question lookup map',
    '- Which components remain open? `action-required-threads.md`.',
    '- Which cases are confirmed versus potential? `reservation-thread-cases.md` and `thread-index.json`.',
    '- What response timing is observed, excluded, or unknown? `thread-metrics.csv` and index timing summary.',
    '- Which raw turns/evidence support a case? private Markdown case artifacts by fresh `caseRef` / `messageRef`.',
  ];
  return `${lines.join('\n')}\n`;
}

function businessInsightsInput(input: {
  runRef: string;
  generatedAt: string;
  corpora: readonly CenturionThreadStateCorpus[];
  adjudication: CenturionThreadAdjudicationResult;
  components: readonly RenderedComponent[];
  classifierVersion: string;
  metricDefinitionVersion: typeof CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION;
}): CenturionThreadBusinessInsightsInput {
  const parserLimitations = new Set([
    'quote_text_truncated',
    'unsupported_quote_like',
    'html_only_quote_coverage',
    'quote_parser_coverage_missing',
    'quote_parser_coverage_limited',
  ]);
  const coverageLimitations = new Set([
    'coverage_limited',
    'source_coverage_missing',
    'source_coverage_incomplete',
  ]);
  const components = input.components.map((rendered) => {
    const component = rendered.component;
    const finalTurns = rendered.turns.filter((turn) => turn.turn.annotationFinal);
    const classifications = classificationSummary(
      finalTurns.map((turn) => turn.turn),
    );
    const coverageStatus: 'complete' | 'limited' | 'missing' = component.coverage.complete
      ? 'complete'
      : component.coverage.attestation === 'missing'
        ? 'missing'
        : 'limited';
    const roles = roleCounts(component);
    const responseGaps = rendered.responseGaps.map((gap) => ({
      status: gap.timing.status,
      durationMs: gap.durationMs,
      reason: gap.timing.reason,
    }));
    if (
      rendered.timing.status === 'excluded' &&
      rendered.timing.reason === 'no_actionable_external_turn' &&
      !responseGaps.some(
        (gap) => gap.reason === 'no_actionable_external_turn',
      )
    ) {
      responseGaps.push({
        status: 'excluded',
        durationMs: null,
        reason: 'no_actionable_external_turn',
      });
    }
    return {
      caseRef: rendered.caseRef,
      finalState: component.state,
      classificationFinal: finalTurns.length === rendered.turns.length,
      reasonCodes: [
        ...new Set(
          rendered.turns.flatMap((turn) => turn.turn.reasonCodes),
        ),
      ].sort(),
      evidenceTier: component.evidenceTier,
      limitations: [...component.limitations].sort(),
      coverageStatus,
      responseGaps,
      classificationCounts: Object.entries(classifications)
        .map(([classification, count]) => ({
          classification: businessClassification(classification),
          count,
        }))
        .sort((left, right) => left.classification.localeCompare(right.classification)),
      participantCounts: {
        internal: roles.internalCount,
        external: roles.externalCount,
      },
      persistedThreadCount: rendered.privateThreadMappings.length,
      turnCount: rendered.turns.length,
      latestAction: {
        eventTime: component.latestExternalActionableTurn?.eventTime.value ?? null,
        quality: component.latestExternalActionableTurn?.eventTime.quality ?? 'missing',
      },
    };
  });
  const sourceCoverage = components.every(
    (component) =>
      component.coverageStatus === 'complete' &&
      !component.limitations.some((limitation) =>
        coverageLimitations.has(limitation),
      ),
  )
    ? 'complete'
    : components.some(
          (component) =>
            component.coverageStatus === 'missing' ||
            component.limitations.includes('source_coverage_missing'),
        )
      ? 'missing'
      : 'limited';
  const allComponentsClosed = components.every((component) =>
    [
      'resolved',
      'action_required',
      'customer_acknowledgement_or_confirmation',
      'automated_or_non_actionable',
      'needs_manual_adjudication',
    ].includes(component.finalState),
  );
  const cutoffsKnown = input.corpora.every(
    (corpus) =>
      typeof corpus.source.eventCutoff === 'string' &&
      typeof corpus.source.ingestCutoff === 'string',
  );
  const parserExceptionsAccounted = true;
  const membershipReconciled = true;
  const pendingReview =
    input.adjudication.reviewQueue.length > 0 ||
    input.adjudication.turns.some((turn) => turn.reviewRequired);
  const valid =
    sourceCoverage === 'complete' &&
    cutoffsKnown &&
    membershipReconciled &&
    parserExceptionsAccounted &&
    allComponentsClosed &&
    !pendingReview;
  return {
    runRef: input.runRef,
    generatedAt: input.generatedAt,
    sourceDigests: input.corpora.map((corpus) => corpus.manifest.corpusSha256),
    snapshot: {
      eventCutoffs: input.corpora.map((corpus) => corpus.source.eventCutoff),
      ingestCutoffs: input.corpora.map((corpus) => corpus.source.ingestCutoff),
      messageCount: input.corpora.reduce(
        (total, corpus) => total + corpus.messages.length,
        0,
      ),
      componentCount: components.length,
      persistedThreadCount: components.reduce(
        (total, component) => total + component.persistedThreadCount,
        0,
      ),
      parserExceptionCount: components.filter((component) =>
        component.limitations.some((limitation) =>
          parserLimitations.has(limitation),
        ),
      ).length,
      coverageExceptionCount: components.filter(
        (component) =>
          component.coverageStatus !== 'complete' ||
          component.limitations.some((limitation) =>
            coverageLimitations.has(limitation),
          ),
      ).length,
    },
    versions: {
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
    },
    readiness: {
      status: valid ? 'valid' : 'not_available',
      sourceCoverage,
      cutoffsKnown,
      membershipReconciled,
      parserExceptionsAccounted,
      allComponentsClosed,
      pendingReview,
    },
    components,
  };
}

function auditSnapshotEnvelopeBytes(input: {
  corpora: readonly CenturionThreadStateCorpus[];
  components: readonly RenderedComponent[];
  facts: CenturionThreadBusinessFacts;
  generatedAt: string;
  identityRulesVersion: string;
  classifierVersion: string;
  metricDefinitionVersion: string;
  reconciliation: {
    indexComponentCount: number;
  };
}): string {
  const factsByCaseRef = new Map(
    input.facts.input.components.map((component) => [component.caseRef, component]),
  );
  if (
    input.corpora.length !== 1 ||
    factsByCaseRef.size !== input.components.length
  ) {
    fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
  }
  const corpus = input.corpora[0]!;
  const transportId = corpus.source.transportId;
  const snapshot = input.facts.input.snapshot;
  const verificationAt = new Date(
    Math.max(
      new Date(input.generatedAt).getTime(),
      new Date(corpus.source.eventCutoff).getTime(),
      new Date(corpus.source.ingestCutoff).getTime(),
    ),
  ).toISOString();
  const source = createCenturionThreadAuditSafeSource({
    schema: 'centurion_thread_audit_safe_source_input_v1',
    task4: {
      schema: 'centurion_thread_task4_safe_projection_v1',
      sourceCorpora: [
        {
          transportId,
          sourceManifestDigest: corpus.manifest.corpusSha256,
          sourceSchemaVersion: corpus.source.schemaVersion,
          sourceEventCutoffAt: corpus.source.eventCutoff,
          sourceIngestCutoffAt: corpus.source.ingestCutoff,
        },
      ],
      identityRulesVersion: input.identityRulesVersion,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
      attemptedAt: verificationAt,
      verifiedAt: verificationAt,
      publishedAt: verificationAt,
      reconciliation: {
        messageCount: snapshot.messageCount,
        componentCount: input.reconciliation.indexComponentCount,
        persistedThreadCount: snapshot.persistedThreadCount,
        parserExceptionCount: snapshot.parserExceptionCount,
        coverageExceptionCount: snapshot.coverageExceptionCount,
      },
      components: input.components.map((rendered) => {
        const factsComponent = factsByCaseRef.get(rendered.caseRef);
        if (!factsComponent) fail('CENTURION_THREAD_AUDIT_SNAPSHOT_INVALID');
        return {
          task6CaseRef: rendered.caseRef,
          sourceMembership: rendered.turns.map((turn) => ({
            sourceDigest: turn.message.sourceDigest,
            transportId: turn.message.transportId,
            threadId: turn.chronology.persistedThreadId,
          })),
          finalState: factsComponent.finalState,
          reasonCodes: factsComponent.reasonCodes,
          limitationCodes: factsComponent.limitations,
          evidenceTier: factsComponent.evidenceTier,
          latestActionAt: factsComponent.latestAction.eventTime,
          latestActionTrusted: factsComponent.latestAction.quality === 'trustworthy',
        };
      }),
    },
    task6Facts: input.facts,
  });
  return serializeSealedCenturionThreadAuditSnapshot(
    sealCenturionThreadAuditSnapshot(source),
  );
}

export function assertCenturionThreadReportMarkdownReconciliation(input: {
  expectedReservationCaseRefs: readonly string[];
  renderedReservationCaseRefs: readonly string[];
  expectedActionCaseRefs: readonly string[];
  renderedActionCaseRefs: readonly string[];
}): void {
  const assertExactUniqueMembership = (
    expected: readonly string[],
    rendered: readonly string[],
  ): void => {
    const expectedSorted = [...expected].sort();
    const renderedSorted = [...rendered].sort();
    if (
      new Set(rendered).size !== rendered.length ||
      expectedSorted.length !== renderedSorted.length ||
      expectedSorted.some((reference, index) => reference !== renderedSorted[index])
    ) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
  };
  assertExactUniqueMembership(
    input.expectedReservationCaseRefs,
    input.renderedReservationCaseRefs,
  );
  assertExactUniqueMembership(
    input.expectedActionCaseRefs,
    input.renderedActionCaseRefs,
  );
}

function assertReconciliation(input: {
  components: readonly RenderedComponent[];
  adjudication: CenturionThreadAdjudicationResult;
  metrics: string;
  renderedMarkdown: {
    reservationCaseRefs: readonly string[];
    actionCaseRefs: readonly string[];
  };
}): {
  indexComponentCount: number;
  reservationCaseCount: number;
  confirmedReservationComponentCount: number;
  potentialReservationComponentCount: number;
  actionRequiredComponentCount: number;
  actionRequiredMarkdownCaseCount: number;
  metricComponentRowCount: number;
} {
  const componentCount = input.components.length;
  if (
    componentCount !== input.adjudication.threadIntelligence.components.length ||
    componentCount !== input.adjudication.receipt.componentCount
  ) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
  const expectedReservationCaseRefs = input.components
    .filter((component) => component.reservationScope !== 'not_reservation_related')
    .map((component) => component.caseRef);
  const reservationCaseCount = expectedReservationCaseRefs.length;
  const confirmedReservationComponentCount = input.components.filter(
    (component) => component.reservationScope === 'confirmed',
  ).length;
  const potentialReservationComponentCount = input.components.filter(
    (component) => component.reservationScope === 'potential',
  ).length;
  const expectedActionCaseRefs = input.components
    .filter((component) => component.component.state === 'action_required')
    .map((component) => component.caseRef);
  const actionRequiredComponentCount = expectedActionCaseRefs.length;
  assertCenturionThreadReportMarkdownReconciliation({
    expectedReservationCaseRefs,
    renderedReservationCaseRefs: input.renderedMarkdown.reservationCaseRefs,
    expectedActionCaseRefs,
    renderedActionCaseRefs: input.renderedMarkdown.actionCaseRefs,
  });
  const metricComponentRowCount = input.metrics
    .trim()
    .split('\n')
    .slice(1)
    .filter((line) => line.startsWith('component,')).length;
  if (metricComponentRowCount !== componentCount) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
  return {
    indexComponentCount: componentCount,
    reservationCaseCount,
    confirmedReservationComponentCount,
    potentialReservationComponentCount,
    actionRequiredComponentCount,
    actionRequiredMarkdownCaseCount: input.renderedMarkdown.actionCaseRefs.length,
    metricComponentRowCount,
  };
}

export function renderCenturionThreadReports(
  input: CenturionThreadReportsInput,
): CenturionThreadReportsResult {
  const { corpora, adjudication, generatedAt } = validateReportInput(input);
  const messagesById = new Map<string, CenturionThreadStateCorpusMessage>();
  for (const message of corpora.flatMap((corpus) => corpus.messages)) {
    if (messagesById.has(message.id)) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    messagesById.set(message.id, message);
  }
  const turnsByMessageId = new Map<string, CenturionThreadAdjudicationTurn>();
  for (const turn of adjudication.turns) {
    if (turnsByMessageId.has(turn.messageId) || !messagesById.has(turn.messageId)) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    turnsByMessageId.set(turn.messageId, turn);
  }
  if (turnsByMessageId.size !== messagesById.size) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }

  const allocator = new ReportReferenceAllocator(input.referenceFactory);
  const runRef = allocator.create('run');
  const messageRefs = new Map<string, string>();
  const threadRefs = new Map<string, PrivateThreadMapping>();
  const reportComponents: RenderedComponent[] = [];
  const seenTask3ComponentRefs = new Set<string>();
  const seenChronologyMessageIds = new Set<string>();

  for (const component of adjudication.threadIntelligence.components) {
    if (component.chronology.length === 0) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    const componentTurns: PrivateTurn[] = component.chronology.map((chronology) => {
      if (seenChronologyMessageIds.has(chronology.messageId)) {
        fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      }
      seenChronologyMessageIds.add(chronology.messageId);
      const message = messagesById.get(chronology.messageId);
      const adjudicationTurn = turnsByMessageId.get(chronology.messageId);
      if (!message || !adjudicationTurn) {
        fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      }
      assertChronologyBinding({
        message,
        chronology,
        component,
      });
      const messageRef =
        messageRefs.get(message.id) ?? allocator.create('message');
      messageRefs.set(message.id, messageRef);
      const key = threadKey(message.transportId, chronology.persistedThreadId);
      const thread =
        threadRefs.get(key) ??
        {
          threadRef: allocator.create('thread'),
          rawThreadId: chronology.persistedThreadId,
        };
      threadRefs.set(key, thread);
      return {
        message,
        messageRef,
        threadRef: thread.threadRef,
        turn: adjudicationTurn,
        chronology,
        task3QuoteProvenance: component.quotedEvidence
          .filter((evidence) => evidence.sourceMessageId === chronology.messageId)
          .map((evidence) => evidence.provenance.marker),
      };
    });
    const task3Refs = new Set(componentTurns.map((turn) => turn.turn.componentRef));
    if (task3Refs.size !== 1) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    const [task3Ref] = task3Refs;
    if (!task3Ref || seenTask3ComponentRefs.has(task3Ref)) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    seenTask3ComponentRefs.add(task3Ref);
    const caseRef = allocator.create('case');
    const componentMessageIds = new Set(
      componentTurns.map((turn) => turn.message.id),
    );
    const responseGaps = component.responseGaps.map((gap) => {
      if (
        !componentMessageIds.has(gap.actionableMessageId) ||
        (gap.responseMessageId !== null &&
          !componentMessageIds.has(gap.responseMessageId))
      ) {
        fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      }
      const actionableMessageRef =
        messageRefs.get(gap.actionableMessageId) ??
        fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      const responseMessageRef = gap.responseMessageId
        ? (messageRefs.get(gap.responseMessageId) ??
          fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH'))
        : null;
      return {
        kind: gap.kind,
        actionableMessageRef,
        responseMessageRef,
        durationMs: gap.durationMs,
        timing: timingForGap(gap),
      } satisfies ReportGap;
    });
    const timing = componentTiming({ component, responseGaps });
    const reservationScope = reservationScopeFor({
      component,
      turns: componentTurns.map((turn) => turn.turn),
    });
    const privateThreadMappings = [
      ...new Map(
        componentTurns.map((turn) => {
          const key = threadKey(
            turn.message.transportId,
            turn.chronology.persistedThreadId,
          );
          const mapping = threadRefs.get(key);
          if (!mapping) fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
          return [mapping.threadRef, mapping] as const;
        }),
      ).values(),
    ].sort((left, right) => left.threadRef.localeCompare(right.threadRef));
    const roles = roleCounts(component);
    const componentMessageRefs = new Map(
      componentTurns.map((turn) => [turn.message.id, turn.messageRef]),
    );
    const assertComponentMessageReference = (messageId: string | null): void => {
      if (messageId !== null && !componentMessageIds.has(messageId)) {
        fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
      }
    };
    assertComponentMessageReference(component.actionEvidence.messageId);
    assertComponentMessageReference(
      component.responseEvidence.latestActionResponseMessageId,
    );
    assertComponentMessageReference(
      component.firstVerifiedInternalEvidence?.sourceMessageId ?? null,
    );
    assertComponentMessageReference(
      component.lastVerifiedInternalEvidence?.sourceMessageId ?? null,
    );
    assertComponentMessageReference(
      component.latestExternalActionableTurn?.messageId ?? null,
    );
    for (const evidence of component.quotedEvidence) {
      assertComponentMessageReference(evidence.sourceMessageId);
    }
    const latestActionMessageRef = component.actionEvidence.messageId
      ? componentMessageRefs.get(component.actionEvidence.messageId)
      : null;
    const latestResponseMessageRef =
      component.responseEvidence.latestActionResponseMessageId
        ? componentMessageRefs.get(
            component.responseEvidence.latestActionResponseMessageId,
          )
        : null;
    if (
      (component.actionEvidence.messageId && !latestActionMessageRef) ||
      (component.responseEvidence.latestActionResponseMessageId &&
        !latestResponseMessageRef)
    ) {
      fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
    }
    const publicIndex = {
      caseRef,
      persistedThreadRefs: privateThreadMappings.map((mapping) => mapping.threadRef),
      participantRoles: roles,
      state: component.state,
      reservationScope,
      classificationSummary: classificationSummary(
        componentTurns.map((turn) => turn.turn),
      ),
      evidence: {
        tier: component.evidenceTier,
        action: {
          tier: component.actionEvidence.tier,
          actionRequiredEligible: component.actionEvidence.actionRequiredEligible,
          messageRef: latestActionMessageRef,
        },
        response: {
          tier: component.responseEvidence.tier,
          latestActionResponseMessageRef: latestResponseMessageRef,
        },
        firstVerifiedInternal: verifiedEvidenceForIndex(
          component.firstVerifiedInternalEvidence,
          componentMessageRefs,
        ),
        lastVerifiedInternal: verifiedEvidenceForIndex(
          component.lastVerifiedInternalEvidence,
          componentMessageRefs,
        ),
        quotedEvidence: component.quotedEvidence.map((evidence) => {
          const sourceMessageRef = componentMessageRefs.get(
            evidence.sourceMessageId,
          );
          if (!sourceMessageRef) {
            fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
          }
          return {
            sourceMessageRef,
            marker: evidence.provenance.marker,
            startLine: evidence.provenance.startLine,
            endLine: evidence.provenance.endLine,
            depth: evidence.provenance.depth,
          };
        }),
      },
      limitations: [...component.limitations],
      limitation: component.limitation,
      turnCount: componentTurns.length,
      responseGaps,
      timing,
      elapsedDuration: component.elapsedDuration,
      multiMessage: componentTurns.length >= 2,
      threePlusMessages: componentTurns.length >= 3,
      messages: componentTurns.map((turn) => ({
        messageRef: turn.messageRef,
        persistedThreadRef: turn.threadRef,
        direction: turn.chronology.direction,
        senderRole: turn.chronology.senderRole,
        eventTime: turn.chronology.eventTime,
        classification: turn.turn.classification ?? turn.turn.operationalKind,
        annotationFinal: turn.turn.annotationFinal,
        quoteCoverage: turn.turn.quoteCoverage,
      })),
    };
    reportComponents.push({
      caseRef,
      component,
      turns: componentTurns,
      reservationScope,
      timing,
      responseGaps,
      publicIndex,
      privateThreadMappings,
    });
  }
  if (seenTask3ComponentRefs.size !== adjudication.threadIntelligence.components.length) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }
  if (seenChronologyMessageIds.size !== messagesById.size) {
    fail('CENTURION_THREAD_REPORTS_RECONCILIATION_MISMATCH');
  }

  const metrics = renderMetricsCsv(reportComponents);
  const reservationMarkdown = renderReservationCasesMarkdown(reportComponents);
  const actionMarkdown = renderActionRequiredMarkdown(reportComponents);
  const renderedMarkdown = {
    reservationCaseRefs: reservationMarkdown.caseRefs,
    actionCaseRefs: actionMarkdown.caseRefs,
  };
  const reconciliation = assertReconciliation({
    components: reportComponents,
    adjudication,
    metrics,
    renderedMarkdown,
  });
  const businessFacts = buildCenturionThreadBusinessFacts(
    businessInsightsInput({
      runRef,
      generatedAt,
      corpora,
      adjudication,
      components: reportComponents,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion:
        CENTURION_THREAD_BUSINESS_INSIGHTS_METRIC_DEFINITION_VERSION,
    }),
  );
  const businessInsights = renderCenturionThreadBusinessInsights(businessFacts);
  const sealedAuditSnapshotEnvelopeBytes = auditSnapshotEnvelopeBytes({
    corpora,
    components: reportComponents,
    facts: businessFacts,
    generatedAt,
    identityRulesVersion: input.identityRulesVersion,
    classifierVersion: input.classifierVersion,
    metricDefinitionVersion: input.metricDefinitionVersion,
    reconciliation,
  });
  const allResponseGaps = reportComponents.flatMap((component) =>
    component.responseGaps,
  );
  const observedDurations = allResponseGaps
    .filter((gap) => gap.timing.status === 'observed')
    .map((gap) => {
      if (gap.durationMs === null) fail('CENTURION_THREAD_REPORTS_TIMING_INVALID');
      return gap.durationMs;
    });
  const stateCounts = distribution(
    reportComponents.map((component) => component.component.state),
  );
  const index = {
    schema: CENTURION_THREAD_REPORTS_SCHEMA,
    runRef,
    generatedAt,
    provenance: {
      adjudicationSchema: adjudication.schema,
      adjudicationOutputDigest: adjudication.receipt.outputDigest,
      identityRulesVersion: input.identityRulesVersion,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
      sourceCorpora: corpora.map((corpus) => ({
        sourceSchemaVersion: corpus.source.schemaVersion,
        corpusSha256: corpus.manifest.corpusSha256,
        eventCutoff: corpus.source.eventCutoff,
        ingestCutoff: corpus.source.ingestCutoff,
        messageCount: corpus.messages.length,
      })),
    },
    summary: {
      componentCount: reportComponents.length,
      reservationScopeCounts: distribution(
        reportComponents.map((component) => component.reservationScope),
      ),
      stateCounts,
      timing: {
        observedResponseGapCount: observedDurations.length,
        excludedResponseGapCount: allResponseGaps.filter(
          (gap) => gap.timing.status === 'excluded',
        ).length,
        unknownResponseGapCount: allResponseGaps.filter(
          (gap) => gap.timing.status === 'unknown',
        ).length,
        p50ResponseLatencyMs: percentileNearestRank(observedDurations, 50),
        p95ResponseLatencyMs: percentileNearestRank(observedDurations, 95),
      },
    },
    reconciliation,
    components: reportComponents.map((component) => component.publicIndex),
  };
  const files = {
    'thread-index.json': `${JSON.stringify(index, null, 2)}\n`,
    'reservation-thread-cases.md': reservationMarkdown.markdown,
    'action-required-threads.md': actionMarkdown.markdown,
    'thread-metrics.csv': metrics,
    'process-and-definitions.md': renderDefinitionsMarkdown({
      runRef,
      generatedAt,
      corpora,
      identityRulesVersion: input.identityRulesVersion,
      classifierVersion: input.classifierVersion,
      metricDefinitionVersion: input.metricDefinitionVersion,
    }),
    'business-insights.md': businessInsights.markdown,
  } satisfies Record<(typeof CENTURION_THREAD_REPORT_FILES)[number], string>;
  const receipt: CenturionThreadReportsReceipt = {
    schema: 'centurion_thread_reports_receipt_v1',
    runRef,
    componentCount: reconciliation.indexComponentCount,
    reservationCaseCount: reconciliation.reservationCaseCount,
    actionRequiredCaseCount: reconciliation.actionRequiredComponentCount,
    outputDigest: sha256(
      stableJson({
        index,
        metrics: files['thread-metrics.csv'],
        definitions: files['process-and-definitions.md'],
        businessInsights: files['business-insights.md'],
      }),
    ),
  };
  return {
    schema: CENTURION_THREAD_REPORTS_SCHEMA,
    receipt,
    auditSnapshotEnvelopeBytes: sealedAuditSnapshotEnvelopeBytes,
    renderedMarkdown,
    files,
  };
}

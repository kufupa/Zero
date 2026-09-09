import {
  MAIL_BASELINE_PROJECTION_VERSION,
  reduceMailBaseline,
  type MailBaselineCoverage,
  type MailBaselineEvidence,
  type MailBaselineProjection,
  type MailBaselineReducerInput,
} from './mail-baseline.js';
import { mailBaselineProjection } from '../db/schema/mail-baseline-projection.js';
import { and, asc, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { createHash } from 'node:crypto';

export type MailBaselineProjectionRowInput = {
  id: string;
  generationKey: string;
  generationId: string;
  projectionVersion: string;
  transportId: string;
  threadId: string;
  sourceMessageId: string | null;
  requestId: string;
  askId: string;
  eventKind: MailBaselineEvidence['eventType'];
  direction: MailBaselineEvidence['direction'];
  eventAt: Date | null;
  observedAt: Date | null;
  source: MailBaselineEvidence['source'];
  sourceBasis: MailBaselineEvidence['sourceBasis'];
  sourceVintage: string;
  interpretationVersion: string;
  classifierVersion: string | null;
  reviewerVersion: string | null;
  observationCutoff: Date;
  measurementStartAt: Date | null;
  coverage: MailBaselineCoverage;
  evidence: Record<string, unknown>;
};

export type MailBaselineProjectionRow = typeof mailBaselineProjection.$inferSelect;

function asDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function jsonSafeEvidence(evidence: MailBaselineEvidence): Record<string, unknown> {
  return {
    requiresHotelResponse: evidence.requiresHotelResponse ?? false,
    requiresCustomerInformation: evidence.requiresCustomerInformation ?? false,
    noReplyRequired: evidence.noReplyRequired ?? false,
    answerState: evidence.answerState ?? null,
    workState: evidence.workState ?? null,
    substantive: evidence.substantive ?? false,
    linkStrength: evidence.linkStrength ?? 'unknown',
    delivery: evidence.delivery ?? null,
    factKey: evidence.factKey ?? null,
    unknownReason: evidence.unknownReason ?? null,
  };
}

/** Convert semantic facts into immutable rows. No message body is accepted. */
export function createMailBaselineProjectionRows(input: {
  transportId: string;
  threadId: string;
  generationId: string;
  sourceVintage: string;
  interpretationVersion: string;
  reviewerVersion?: string | null;
  observationCutoff: string | Date;
  measurementStartAt?: string | Date | null;
  coverage?: MailBaselineCoverage;
  evidence: readonly MailBaselineEvidence[];
}): MailBaselineProjectionRowInput[] {
  const cutoff = asDate(input.observationCutoff);
  if (!cutoff) throw new Error('mail baseline projection cutoff must be a valid instant');
  const measurementStartAt = asDate(input.measurementStartAt);
  const coverage = input.coverage ?? {
    startAt: measurementStartAt?.toISOString() ?? null,
    endAt: cutoff.toISOString(),
    basis: 'coverage_unconfigured',
    complete: false,
  };
  return input.evidence.map((evidence) => {
    const eventAt = asDate(evidence.eventAt);
    const observedAt = asDate(evidence.observedAt);
    const generationKey = [
      input.transportId,
      input.threadId,
      input.generationId,
      evidence.id,
      MAIL_BASELINE_PROJECTION_VERSION,
      input.interpretationVersion,
    ].join(':');
    return {
      id: `mail-baseline:${hash(generationKey)}`,
      generationKey,
      generationId: input.generationId,
      projectionVersion: MAIL_BASELINE_PROJECTION_VERSION,
      transportId: input.transportId,
      threadId: input.threadId,
      sourceMessageId: evidence.sourceMessageId ?? null,
      requestId: evidence.requestId,
      askId: evidence.askId,
      eventKind: evidence.eventType,
      direction: evidence.direction,
      eventAt,
      observedAt,
      source: evidence.source,
      sourceBasis: evidence.sourceBasis,
      sourceVintage: input.sourceVintage,
      interpretationVersion: input.interpretationVersion,
      classifierVersion: evidence.classifierVersion ?? null,
      reviewerVersion: input.reviewerVersion ?? evidence.reviewerVersion ?? null,
      observationCutoff: cutoff,
      measurementStartAt,
      coverage,
      evidence: jsonSafeEvidence(evidence),
    };
  });
}

export async function persistMailBaselineProjection(
  db: DB = getDb(),
  input: Parameters<typeof createMailBaselineProjectionRows>[0],
): Promise<{ inserted: number; rows: MailBaselineProjectionRowInput[] }> {
  const rows = createMailBaselineProjectionRows(input);
  if (rows.length === 0) return { inserted: 0, rows };
  const inserted = await db
    .insert(mailBaselineProjection)
    .values(rows)
    .onConflictDoNothing({ target: mailBaselineProjection.generationKey })
    .returning({ id: mailBaselineProjection.id });
  return { inserted: inserted.length, rows };
}

export type MailBaselineProjectionQuery = {
  transportIds: readonly string[];
  threadIds?: readonly string[];
  observationCutoff: string | Date;
  since?: string | Date | null;
  limit?: number;
};

/** Bounded, body-free projection read used by dashboard queries. */
export async function queryMailBaselineProjection(
  db: DB = getDb(),
  query: MailBaselineProjectionQuery,
): Promise<MailBaselineProjectionRow[]> {
  const cutoff = asDate(query.observationCutoff);
  if (!cutoff) throw new Error('mail baseline query cutoff must be a valid instant');
  if (query.transportIds.length === 0) return [];
  const conditions = [
    inArray(mailBaselineProjection.transportId, [...query.transportIds]),
    or(isNull(mailBaselineProjection.eventAt), lt(mailBaselineProjection.eventAt, cutoff)),
  ];
  if (query.threadIds?.length) {
    conditions.push(inArray(mailBaselineProjection.threadId, [...query.threadIds]));
  }
  const since = asDate(query.since);
  if (since)
    conditions.push(
      or(isNull(mailBaselineProjection.eventAt), gt(mailBaselineProjection.eventAt, since)),
    );
  const limit = Math.min(Math.max(query.limit ?? 2000, 1), 10_000);
  return db
    .select()
    .from(mailBaselineProjection)
    .where(and(...conditions))
    .orderBy(asc(mailBaselineProjection.eventAt), asc(mailBaselineProjection.id))
    .limit(limit);
}

function evidenceFromRow(row: MailBaselineProjectionRow): MailBaselineEvidence {
  const payload = row.evidence ?? {};
  return {
    id: row.id,
    requestId: row.requestId,
    askId: row.askId,
    threadId: row.threadId,
    transportId: row.transportId,
    eventType: row.eventKind as MailBaselineEvidence['eventType'],
    direction: row.direction as MailBaselineEvidence['direction'],
    eventAt: row.eventAt,
    observedAt: row.observedAt,
    source: row.source as MailBaselineEvidence['source'],
    sourceBasis: row.sourceBasis as MailBaselineEvidence['sourceBasis'],
    sourceMessageId: row.sourceMessageId,
    requiresHotelResponse: payload.requiresHotelResponse === true,
    requiresCustomerInformation: payload.requiresCustomerInformation === true,
    noReplyRequired: payload.noReplyRequired === true,
    answerState: (payload.answerState as MailBaselineEvidence['answerState']) ?? null,
    workState: (payload.workState as MailBaselineEvidence['workState']) ?? null,
    substantive: payload.substantive === true,
    linkStrength: (payload.linkStrength as MailBaselineEvidence['linkStrength']) ?? 'unknown',
    delivery: (payload.delivery as MailBaselineEvidence['delivery']) ?? null,
    factKey: typeof payload.factKey === 'string' ? payload.factKey : undefined,
    classifierVersion: row.classifierVersion,
    reviewerVersion: row.reviewerVersion,
    unknownReason: typeof payload.unknownReason === 'string' ? payload.unknownReason : null,
  };
}

export function reduceProjectedMailBaseline(
  rows: readonly MailBaselineProjectionRow[] | readonly MailBaselineProjectionRowInput[],
  input: Pick<
    MailBaselineReducerInput,
    'observationCutoff' | 'sourceVintage' | 'interpretationVersion'
  > &
    Partial<
      Pick<MailBaselineReducerInput, 'transportId' | 'threadId' | 'measurementStartAt' | 'coverage'>
    >,
): MailBaselineProjection {
  const normalizedRows = rows as readonly MailBaselineProjectionRow[];
  const first = normalizedRows[0];
  const evidence = normalizedRows.map(evidenceFromRow);
  return reduceMailBaseline({
    transportId: input.transportId ?? first?.transportId ?? '',
    threadId: input.threadId ?? first?.threadId ?? '',
    observationCutoff: input.observationCutoff,
    sourceVintage: input.sourceVintage,
    interpretationVersion: input.interpretationVersion,
    measurementStartAt: input.measurementStartAt ?? first?.measurementStartAt ?? null,
    coverage: input.coverage ?? (first?.coverage as MailBaselineCoverage | undefined),
    evidence,
  });
}

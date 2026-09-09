import {
  aggregateAdminDashboardMetrics,
  type AdminDashboardClassificationSnapshot,
  type AdminDashboardAggregateResult,
  type ExecutiveDashboardQuery,
} from '../../metrics/admin-dashboard-aggregates.js';
import {
  assertAdminDashboardGrant,
  resolveAdminDashboardGrant,
  type AdminDashboardCohort,
  type AdminDashboardGrant,
} from '../../metrics/admin-dashboard-access.js';
import {
  mailCategory,
  mailThread,
  mailThreadCategory,
  mailboxTransport,
  message,
  outboundSendQueue,
} from '../../db/schema/mail.js';
import {
  parseMailboxMeasurementConfig,
  type MailboxMeasurementConfig,
} from '../../metrics/mail-measurement-config.js';
import {
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
} from '../../metrics/mail-baseline-repository.js';
import { loadShadowScorecard, SHADOW_EVALUATION_MODE } from '../../ai/shadow-evaluation.js';
import { serializeAdminDashboardExport } from '../../metrics/admin-dashboard-export.js';
import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { privateProcedure, router as tRouter } from '../trpc.js';
import { getDb } from '../../db/client.js';
import { z } from 'zod';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LONG_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const CENTURION_TRANSPORT_IDS = ['transport-centurion'] as const;
// Current pilot data contract has one non-Centurion transport. PMBOBO rows
// remain excluded from the default cohort; no unseeded transport ID is
// invented here until an owned mailbox config names one.
const RESEARCH_TRANSPORT_IDS = ['transport-nava'] as const;

export const executiveDashboardQueryInput = z
  .object({
    cohortId: z.enum(['centurion', 'research']).optional(),
    window: z.enum(['7d', '28d']).optional(),
    windowStart: z.string().optional(),
    windowEnd: z.string().optional(),
    observationCutoff: z.string().optional(),
    operation: z.enum(['aggregate', 'drilldown', 'export']).optional(),
  })
  .optional();

export type ExecutiveDashboardQueryInput = z.infer<typeof executiveDashboardQueryInput>;

export function resolveAdminDashboardWindow(now: Date = new Date()): {
  windowStart: Date;
  windowEnd: Date;
} {
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - WINDOW_MS);
  return { windowStart, windowEnd };
}

function parseInstant(raw: string | undefined, name: string): Date | null {
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`invalid ${name}`);
  return parsed;
}

/** Validate untrusted query input without making a database call. */
export function parseExecutiveDashboardQuery(
  raw: ExecutiveDashboardQueryInput | undefined,
  now: Date = new Date(),
): NonNullable<ExecutiveDashboardQueryInput> {
  const parsed = executiveDashboardQueryInput.parse(raw) ?? {};
  const nowMillis = now.getTime();
  const cutoff = parseInstant(parsed?.observationCutoff, 'observation cutoff') ?? now;
  if (cutoff.getTime() > nowMillis) throw new Error('observation cutoff cannot be in the future');

  const windowEnd = parseInstant(parsed?.windowEnd, 'window end') ?? cutoff;
  const preset = parsed?.window ?? '7d';
  const duration = preset === '28d' ? LONG_WINDOW_MS : WINDOW_MS;
  const windowStart =
    parseInstant(parsed?.windowStart, 'window start') ?? new Date(windowEnd.getTime() - duration);
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw new Error('dashboard window must have a start before its end');
  }
  if (windowEnd.getTime() > cutoff.getTime()) {
    throw new Error('dashboard window cannot extend beyond observation cutoff');
  }
  if (windowEnd.getTime() - windowStart.getTime() > duration) {
    throw new Error(`dashboard window exceeds selected ${preset} preset`);
  }
  return {
    cohortId: parsed?.cohortId ?? 'centurion',
    window: preset,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    observationCutoff: cutoff.toISOString(),
    operation: parsed?.operation ?? 'aggregate',
  };
}

export function resolveExecutiveDashboardQuery(
  raw: ExecutiveDashboardQueryInput | undefined,
  now: Date = new Date(),
): ExecutiveDashboardQuery {
  const parsed = parseExecutiveDashboardQuery(raw, now);
  return {
    cohortId: parsed.cohortId ?? 'centurion',
    window: parsed.window ?? '7d',
    windowStart: parsed.windowStart!,
    windowEnd: parsed.windowEnd!,
    observationCutoff: parsed.observationCutoff!,
    sourceVintage: parsed.observationCutoff!,
  };
}

function queryTransportIds(cohortId: AdminDashboardCohort): readonly string[] {
  return cohortId === 'research' ? RESEARCH_TRANSPORT_IDS : CENTURION_TRANSPORT_IDS;
}

function dbClockPredicate(windowStart: Date, observationCutoff: Date) {
  // createdAt is included only to retain rows whose historical event clock is
  // unknown for an explicit unscorable diagnostic; the pure aggregate never
  // treats it as an event clock.
  return or(
    and(gte(message.receivedAt, windowStart), lt(message.receivedAt, observationCutoff)),
    and(gte(message.sentAt, windowStart), lt(message.sentAt, observationCutoff)),
    and(
      isNull(message.receivedAt),
      isNull(message.sentAt),
      gte(message.createdAt, windowStart),
      lt(message.createdAt, observationCutoff),
    ),
    // Retain a bounded diagnostic row when its source clock is future-dated;
    // the aggregate labels it invalid rather than recasting createdAt as an
    // event clock. This keeps future-clock coverage visible to data health.
    and(
      gte(message.createdAt, windowStart),
      lt(message.createdAt, observationCutoff),
      or(gte(message.receivedAt, observationCutoff), gte(message.sentAt, observationCutoff)),
    ),
  );
}

type QueryMessageRow = {
  id: string;
  threadId: string;
  transportId: string;
  direction: 'inbound' | 'outbound';
  sourceMessageId: string | null;
  fromAddress: string;
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  sendState?: 'pending' | 'sending' | 'sent' | 'accepted' | 'cancelled' | 'failed' | null;
};

async function loadQueryRows(
  query: ExecutiveDashboardQuery,
  db: ReturnType<typeof getDb>,
  transportIds: readonly string[],
): Promise<{
  messages: QueryMessageRow[];
  previousMessages: QueryMessageRow[];
  preWindowThreadIds: string[];
  preWindowUnknownThreadIds: string[];
  preWindowEvidenceAvailable: boolean;
  threads: Array<{
    id: string;
    transportId: string;
    spamAt: Date | null;
    trashedAt: Date | null;
    createdAt: Date;
    latestMessageAt: Date | null;
  }>;
}> {
  if (transportIds.length === 0) {
    return {
      messages: [],
      previousMessages: [],
      preWindowThreadIds: [],
      preWindowUnknownThreadIds: [],
      preWindowEvidenceAvailable: false,
      threads: [],
    };
  }
  const windowStart = new Date(query.windowStart);
  const windowEnd = new Date(query.windowEnd);
  const cutoff = new Date(query.observationCutoff);
  const windowDuration = windowEnd.getTime() - windowStart.getTime();
  const previousStart = new Date(windowStart.getTime() - windowDuration);
  const columns = {
    id: message.id,
    threadId: message.threadId,
    transportId: message.transportId,
    direction: message.direction,
    sourceMessageId: message.messageIdHeader,
    fromAddress: message.fromAddress,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    createdAt: message.createdAt,
  };
  const messages = (await db
    .select(columns)
    .from(message)
    .where(
      and(inArray(message.transportId, [...transportIds]), dbClockPredicate(windowStart, cutoff)),
    )) as QueryMessageRow[];
  const previousMessages = (await db
    .select(columns)
    .from(message)
    .where(
      and(
        inArray(message.transportId, [...transportIds]),
        dbClockPredicate(previousStart, windowStart),
      ),
    )) as QueryMessageRow[];
  const threadIds = [...new Set(messages.map((row) => row.threadId))];
  if (threadIds.length === 0) {
    return {
      messages,
      previousMessages,
      preWindowThreadIds: [],
      preWindowUnknownThreadIds: [],
      preWindowEvidenceAvailable: true,
      threads: [],
    };
  }

  const preWindowRows = await db
    .selectDistinct({ threadId: message.threadId })
    .from(message)
    .where(
      and(
        inArray(message.transportId, [...transportIds]),
        inArray(message.threadId, threadIds),
        or(lt(message.receivedAt, windowStart), lt(message.sentAt, windowStart)),
      ),
    );
  const preWindowUnknownRows = await db
    .selectDistinct({ threadId: message.threadId })
    .from(message)
    .where(
      and(
        inArray(message.transportId, [...transportIds]),
        inArray(message.threadId, threadIds),
        isNull(message.receivedAt),
        isNull(message.sentAt),
        lt(message.createdAt, windowStart),
      ),
    );

  const threads = await db
    .select({
      id: mailThread.id,
      transportId: mailThread.transportId,
      spamAt: mailThread.spamAt,
      trashedAt: mailThread.trashedAt,
      createdAt: mailThread.createdAt,
      latestMessageAt: mailThread.latestMessageAt,
    })
    .from(mailThread)
    .where(
      and(inArray(mailThread.id, threadIds), inArray(mailThread.transportId, [...transportIds])),
    );

  // A response may be after the activity window, but never after the
  // observation cutoff. This upper bound is part of every evidence join.
  const outboundExtras = (await db
    .select(columns)
    .from(message)
    .where(
      and(
        inArray(message.transportId, [...transportIds]),
        inArray(message.threadId, threadIds),
        eq(message.direction, 'outbound'),
        dbClockPredicate(windowStart, cutoff),
      ),
    )) as QueryMessageRow[];
  const byId = new Map<string, QueryMessageRow>();
  for (const row of [...messages, ...outboundExtras]) byId.set(row.id, row);

  const queueRows = await db
    .select({ messageId: outboundSendQueue.messageId, status: outboundSendQueue.status })
    .from(outboundSendQueue)
    .where(inArray(outboundSendQueue.messageId, [...byId.keys()]));
  const statusByMessage = new Map(queueRows.map((row) => [row.messageId, row.status]));
  for (const row of byId.values()) {
    if (row.direction !== 'outbound') continue;
    const status = statusByMessage.get(row.id);
    if (status === 'pending' || status === 'sending' || status === 'cancelled')
      row.sendState = status;
    else if (status === 'sent') row.sendState = 'sent';
    else if (status === 'failed') row.sendState = 'failed';
    else if (status === 'accepted') row.sendState = 'accepted';
  }
  return {
    messages: [...byId.values()],
    previousMessages: previousMessages.map((row) => byId.get(row.id) ?? row),
    preWindowThreadIds: preWindowRows.map((row) => row.threadId),
    preWindowUnknownThreadIds: preWindowUnknownRows.map((row) => row.threadId),
    preWindowEvidenceAvailable: true,
    threads,
  };
}

const CURRENT_CLASSIFICATION_MAX_AGE_MS = 5_000;

function canUseCurrentClassificationSnapshot(
  query: ExecutiveDashboardQuery,
  now = new Date(),
): boolean {
  const cutoff = new Date(query.observationCutoff).getTime();
  return (
    Number.isFinite(cutoff) && Math.abs(now.getTime() - cutoff) <= CURRENT_CLASSIFICATION_MAX_AGE_MS
  );
}

/**
 * Project the currently retained folder/spam/trash state for a current
 * request. A historical cutoff never reuses this mutable state: callers get
 * null and the aggregate keeps classification-dependent sections unavailable.
 */
async function loadCurrentClassificationSnapshot(
  db: ReturnType<typeof getDb>,
  query: ExecutiveDashboardQuery,
  threads: readonly {
    id: string;
    transportId: string;
    spamAt: Date | null;
    trashedAt: Date | null;
  }[],
  transportIds: readonly string[],
): Promise<AdminDashboardClassificationSnapshot | null> {
  if (!canUseCurrentClassificationSnapshot(query)) return null;

  if (threads.length === 0) {
    return {
      classificationAsOf: query.observationCutoff,
      snapshotBasis: 'current_observed_snapshot_at_request',
      threads: [],
    };
  }

  const threadIds = threads.map((thread) => thread.id);
  const transportByThread = new Map(threads.map((thread) => [thread.id, thread.transportId]));
  const categoryRows = await db
    .select({
      threadId: mailThreadCategory.threadId,
      transportId: mailThreadCategory.transportId,
      slug: mailCategory.slug,
      sortOrder: mailCategory.sortOrder,
    })
    .from(mailThreadCategory)
    .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
    .where(
      and(
        inArray(mailThreadCategory.threadId, threadIds),
        inArray(mailThreadCategory.transportId, [...transportIds]),
      ),
    )
    .orderBy(asc(mailCategory.sortOrder), asc(mailCategory.slug));
  const byThread = new Map<string, string[]>();
  for (const row of categoryRows) {
    if (row.transportId !== transportByThread.get(row.threadId)) continue;
    const slugs = byThread.get(row.threadId) ?? [];
    if (!slugs.includes(row.slug)) slugs.push(row.slug);
    byThread.set(row.threadId, slugs);
  }

  return {
    classificationAsOf: query.observationCutoff,
    snapshotBasis: 'current_observed_snapshot_at_request',
    threads: threads.map((thread) => {
      const slugs = byThread.get(thread.id) ?? [];
      const primarySlugs = slugs.filter((slug) => slug !== 'urgent');
      return {
        threadId: thread.id,
        primaryFolder: primarySlugs[0] ?? null,
        folderSlugs: primarySlugs,
        urgent: slugs.includes('urgent'),
        spam: thread.spamAt != null,
        trashed: thread.trashedAt != null,
      };
    }),
  };
}

export async function loadAdminDashboardMetrics(
  queryOrNow?: ExecutiveDashboardQuery | Date,
): Promise<AdminDashboardAggregateResult> {
  const query =
    queryOrNow instanceof Date
      ? resolveExecutiveDashboardQuery(undefined, queryOrNow)
      : (queryOrNow ?? resolveExecutiveDashboardQuery(undefined));
  const db = getDb();
  const transportIds = queryTransportIds(query.cohortId);
  const transports = await db
    .select({
      id: mailboxTransport.id,
      email: mailboxTransport.email,
      displayName: mailboxTransport.displayName,
    })
    .from(mailboxTransport)
    .where(
      and(eq(mailboxTransport.isActive, true), inArray(mailboxTransport.id, [...transportIds])),
    );
  const selectedTransportIds = transports.map((transport) => transport.id);
  const loaded = await loadQueryRows(query, db, selectedTransportIds);
  const classificationSnapshot = await loadCurrentClassificationSnapshot(
    db,
    query,
    loaded.threads,
    selectedTransportIds,
  );
  const measurementConfig: MailboxMeasurementConfig | null = parseMailboxMeasurementConfig(
    process.env.MAIL_MEASUREMENT_CONFIG_JSON,
  );
  const projectionRows = await queryMailBaselineProjection(db, {
    transportIds: selectedTransportIds,
    observationCutoff: new Date(query.observationCutoff),
    // No lower bound is applied: pre-T0 rows are retained so the reducer can
    // expose left-censored backlog instead of silently treating it as new.
    limit: 10_000,
  });
  const projectionsByScope = new Map<string, typeof projectionRows>();
  for (const row of projectionRows) {
    const key = `${row.transportId}:${row.threadId}`;
    const scoped = projectionsByScope.get(key) ?? [];
    scoped.push(row);
    projectionsByScope.set(key, scoped);
  }
  const requestBaselines = [...projectionsByScope.values()].map((rows) => {
    const first = rows[0]!;
    const sourceVintage =
      rows
        .map((row) => row.sourceVintage)
        .sort()
        .at(-1) ?? first.sourceVintage;
    return reduceProjectedMailBaseline(rows, {
      transportId: first.transportId,
      threadId: first.threadId,
      observationCutoff: query.observationCutoff,
      sourceVintage,
      interpretationVersion: first.interpretationVersion,
    });
  });
  const aggregate = aggregateAdminDashboardMetrics({
    cohortId: query.cohortId,
    observationCutoff: new Date(query.observationCutoff),
    classificationSnapshot,
    measurementConfig,
    threads: loaded.threads,
    messages: loaded.messages,
    previousMessages: loaded.previousMessages,
    preWindowThreadIds: loaded.preWindowThreadIds,
    preWindowUnknownThreadIds: loaded.preWindowUnknownThreadIds,
    preWindowEvidenceAvailable: loaded.preWindowEvidenceAvailable,
    transports,
    requestBaselines,
    windowStart: new Date(query.windowStart),
    windowEnd: new Date(query.windowEnd),
  });
  const shadowScorecard = await loadShadowScorecard({
    evaluationMode: SHADOW_EVALUATION_MODE,
    transportIds: selectedTransportIds,
    windowStart: new Date(query.windowStart),
    windowEnd: new Date(query.windowEnd),
    observationCutoff: new Date(query.observationCutoff),
    db,
  });
  return { ...aggregate, shadowScorecard };
}

export const adminDashboardRouter = tRouter({
  getMetrics: privateProcedure.input(executiveDashboardQueryInput).query(async ({ input, ctx }) => {
    // Resolve and authorize the cohort/grant before touching the database.
    const query = resolveExecutiveDashboardQuery(input);
    const grant: AdminDashboardGrant = resolveAdminDashboardGrant(
      ctx.sessionUser.email,
      query.cohortId,
    );
    assertAdminDashboardGrant(grant, input?.operation ?? 'aggregate');
    const payload = await loadAdminDashboardMetrics(query);
    return input?.operation === 'export' ? serializeAdminDashboardExport(payload) : payload;
  }),
});

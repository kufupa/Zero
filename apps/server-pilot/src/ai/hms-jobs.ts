/**
 * Pane HMS lookups as persisted jobs.
 *
 * A job is a read_tool run on the hms lane with promptVersion hms-job/1. The
 * pane enqueues it, polls by run id, and reads the dated snapshot from the
 * database, so a lookup keeps running while the pane is unmounted.
 *
 * User jobs (priority 10) take the property lock and wait for it. Prefetch
 * jobs (priority 0) try the lock once, yield to a staff quote in flight, and
 * requeue on contention. Availability probes (U10) are a third kind, enqueued
 * from a stored quote extraction behind HMS_AVAILABILITY_PREFETCH=on.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { and, desc, eq, gt, gte, inArray, like, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { parseEnv } from '../env.js';
import { staffQuoteInFlight } from '../hms/property-queue-state.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
import {
  availabilityRequestSchema,
  availabilityRequestsFor,
  probeAvailability,
  type AvailabilityRequest,
} from './hms-availability.js';
import { classifyFind, classifySearch, recordedToolRun, toolInputDigest } from './hitl-tool-run.js';
import {
  findStay,
  GUEST_SURNAME_PATTERN,
  paneStayLookupLoaders,
  searchGuest,
} from './pane-stay-lookup.js';
import {
  PANE_RUN_ID_PATTERN,
  paneStayPropertyLock,
  pruneExpiredPaneRuns,
  registerPaneRun,
} from './pane-stay-save.js';
import { normalizeEmailAddress } from './never-spam.js';
import { extractVoucherGuest } from './voucher-find.js';
import { isStaffSender, knownSenders } from './work-items.js';
import {
  type AiFailureClass,
  type AiRunFence,
  type AiWorkflowRun,
  type AiWorkflowRunState,
  HMS_JOB_PROMPT_VERSION,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
  NOT_APPLICABLE_MODEL_ID,
} from './run-ledger.js';

/**
 * The queued pane path. Only the exact value `on` enables it. Off (the default), pane finds and searches run
 * synchronously in the web process as before, no job is queued or prefetched, and no worker claims hms jobs.
 */
export function hmsJobQueueEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.HMS_JOB_QUEUE === 'on';
}

/** Availability probes for quote stays (U10). Off (the default) unless HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on. */
export function availabilityPrefetchEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.HMS_AVAILABILITY_PREFETCH === 'on' && hmsJobQueueEnabled(env);
}

const AVAILABILITY_PROBES_PER_HOUR_DEFAULT = 6;

/**
 * Availability probes per transport per hour (HMS_AVAILABILITY_PER_HOUR). Counted apart from confirmation prefetch
 * (HMS_PREFETCH_PER_HOUR) and kept smaller: a probe is a full Hotel Availability read. Unset or invalid means 6.
 */
export function availabilityProbesPerHour(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.HMS_AVAILABILITY_PER_HOUR?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : AVAILABILITY_PROBES_PER_HOUR_DEFAULT;
}

export const HMS_JOB_PRIORITY_USER = 10;
export const HMS_JOB_PRIORITY_PREFETCH = 0;
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_MS = 30_000;
const JOB_YIELD_MS = 30_000;
const PREFETCH_PER_MAIL_MAX = 3;
const PREFETCH_WINDOW_MS = 60 * 60_000;
const ISO_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Same shape amend-find.ts accepts for an HMS confirmation number. Prefetch takes only numbers in this shape.
const HMS_CONFIRMATION = /^\d{6,10}-\d{1,2}$/;
const CONFIRMATION_IN_TEXT = /(?<![\d-])\d{6,10}-\d{1,2}(?![\d-])/g;

export const hmsJobRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('find'),
      confirmation: z.string().regex(/^\d+-\d+$/),
      arrival: ISO_DAY.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('search_guest'),
      lastName: z.string().min(2).max(40).regex(GUEST_SURNAME_PATTERN),
      arrival: ISO_DAY,
      departure: ISO_DAY.optional(),
    })
    .strict(),
  availabilityRequestSchema,
]);
export type HmsJobRequest = z.infer<typeof hmsJobRequestSchema>;

export type HmsJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed';

export type HmsJobView = {
  runId: string;
  request: HmsJobRequest | null;
  prefetch: boolean;
  status: HmsJobStatus;
  /** 1-based place in the hms lane queue; set only while queued. */
  position: number | null;
  attempts: number;
  failureClass: string | null;
  /** When the snapshot in `result` was taken (ISO). Null until a run succeeds. */
  asOf: string | null;
  result: Record<string, unknown> | null;
};

export type HmsBatchStatus = 'queued' | 'running' | 'partial' | 'done' | 'failed' | 'cancelled';
export type HmsBatchItemStatus = HmsJobStatus | 'skipped' | 'reused' | 'cancelled';

export type HmsBatchItemView = {
  itemIndex: number;
  workItemId: string;
  status: HmsBatchItemStatus;
  reason: 'insufficient_data' | null;
  runId: string | null;
  request: HmsJobRequest | null;
  /** The linked lookup view, including its persisted snapshot when one exists. */
  job: HmsJobView | null;
};

export type HmsBatchView = {
  batchId: string;
  status: HmsBatchStatus;
  summary: {
    total: number;
    queued: number;
    running: number;
    retrying: number;
    done: number;
    failed: number;
    cancelled: number;
    skipped: number;
    reused: number;
  };
  items: HmsBatchItemView[];
};

export class HmsBatchInputError extends Error {
  constructor(
    message: string,
    readonly trpcCode: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
  ) {
    super(message);
    this.name = 'HmsBatchInputError';
  }
}

type Mark = {
  runId: string;
  claimOwner: string;
  claimToken: string;
  expectedStates: AiWorkflowRunState[];
};

/** Confirmation numbers in mail text, validated and de-duplicated. Only the first few per mail. */
export function extractHmsConfirmations(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(CONFIRMATION_IN_TEXT)) {
    const value = match[0];
    if (HMS_CONFIRMATION.test(value) && !found.includes(value)) found.push(value);
    if (found.length === PREFETCH_PER_MAIL_MAX) break;
  }
  return found;
}

/** A surname from an explicit guest label, never the extraction's sender/booker contact. */
function explicitGuestSurname(subject: string | null, textBody: string | null): string | null {
  return extractVoucherGuest({
    subject: subject ?? '',
    bodyText: (textBody ?? '').slice(0, 4_000),
    attachmentTexts: [],
  }).lastName;
}

function extractionConfirmations(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const values = (payload as { confirmationNumbers?: unknown }).confirmationNumbers;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === 'string' && HMS_CONFIRMATION.test(value));
}

/** Reads only when every valid matching stay resolves to one arrival; ambiguous/missing dates are not auto-searched. */
export function extractUniqueArrivalForHmsPrefetch(kind: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const stays = (payload as { stays?: unknown }).stays;
  if (!Array.isArray(stays) || stays.length === 0) return null;
  const arrivals = new Set<string>();
  for (const value of stays) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const stay = value as { requested?: unknown; booked?: unknown };
    const range = kind === 'booking' ? stay.requested : stay.booked;
    if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
    const arrival = (range as { arrival?: unknown }).arrival;
    if (typeof arrival !== 'string' || !ISO_DAY.safeParse(arrival).success) return null;
    const date = new Date(`${arrival}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== arrival) return null;
    arrivals.add(arrival);
  }
  return arrivals.size === 1 ? [...arrivals][0]! : null;
}

/** The auto-start and prefetch paths share this key so a remount cannot queue the same guest lookup twice. */
export function guestSearchPrefetchIdempotencyKey(
  transportId: string,
  threadId: string,
  lastName: string,
  arrival: string,
): string {
  const digest = createHash('sha256')
    .update(`${lastName.replace(/\s+/g, ' ').trim().toLowerCase()}\n${arrival}`)
    .digest('hex')
    .slice(0, 24);
  return `hms-job:prefetch-guest:${transportId}:${threadId}:${digest}`;
}

function prefetchConfirmations(payload: unknown, subject: string | null, textBody: string | null): string[] {
  const text = extractHmsConfirmations(`${subject ?? ''}\n${textBody ?? ''}`);
  return [...new Set([...extractionConfirmations(payload), ...text])].slice(0, PREFETCH_PER_MAIL_MAX);
}

export function selectHmsBatchRequest(input: {
  kind: string | null;
  payload: unknown;
  subject: string | null;
  textBody: string | null;
}): { request: HmsJobRequest } | { skipped: 'insufficient_data' } {
  const confirmation = prefetchConfirmations(input.payload, input.subject, input.textBody)[0];
  if (confirmation) return { request: { kind: 'find', confirmation } };

  const lastName = explicitGuestSurname(input.subject, input.textBody);
  const arrival = extractUniqueArrivalForHmsPrefetch(input.kind ?? '', input.payload);
  const search = hmsJobRequestSchema.safeParse({ kind: 'search_guest', lastName, arrival });
  if (search.success) return { request: search.data };
  return { skipped: 'insufficient_data' };
}

async function latestWorkItemId(db: DB, transportId: string, threadId: string): Promise<string | null> {
  const item = await latestWorkItem(db, transportId, threadId);
  return item?.id ?? null;
}

async function latestWorkItem(
  db: DB,
  transportId: string,
  threadId: string,
): Promise<{ id: string; status: string } | null> {
  const [item] = await db
    .select({ id: workItem.id, status: workItem.status })
    .from(workItem)
    .where(and(eq(workItem.transportId, transportId), eq(workItem.threadId, threadId)))
    .orderBy(desc(workItem.updatedAt), desc(workItem.createdAt), desc(workItem.id))
    .limit(1);
  return item ?? null;
}

/** The work item created from this inbound message; another message's resolved item must not suppress its lookup. */
async function workItemForMessage(
  db: DB,
  transportId: string,
  threadId: string,
  messageId: string,
): Promise<{ id: string; status: string } | null> {
  const items = await db
    .select({ id: workItem.id, status: workItem.status })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, transportId),
        eq(workItem.threadId, threadId),
        eq(workItem.sourceMessageId, messageId),
      ),
    )
    .orderBy(desc(workItem.updatedAt), desc(workItem.createdAt), desc(workItem.id));
  return items.find((item) => item.status === 'needs_you' || item.status === 'review') ?? items[0] ?? null;
}

async function latestInboundMessageId(
  db: DB,
  transportId: string,
  threadId: string,
): Promise<string | null> {
  const [trigger] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.transportId, transportId),
        eq(message.threadId, threadId),
        eq(message.direction, 'inbound'),
      ),
    )
    .orderBy(desc(message.receivedAt), desc(message.id))
    .limit(1);
  return trigger?.id ?? null;
}

type HmsJobEnqueueInput = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  workItemId: string | null;
  userId: string | null;
  request: HmsJobRequest;
  priority: number;
  idempotencyKey: string;
  createdAt?: Date;
  nextRunAt?: Date;
  extraMetrics?: Record<string, unknown>;
};

function hmsJobInsertValues(input: HmsJobEnqueueInput): typeof aiWorkflowRun.$inferInsert {
  const now = new Date();
  const createdAt = input.createdAt ?? now;
  return {
    id: randomUUID(),
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    workItemId: input.workItemId,
    runKind: 'read_tool',
    idempotencyKey: input.idempotencyKey,
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: HMS_JOB_PROMPT_VERSION,
    readRequest: input.request,
    executorLane: 'hms',
    priority: input.priority,
    state: 'queued',
    nextRunAt: input.nextRunAt ?? now,
    metrics: {
      hmsJob: true,
      prefetch: input.priority === HMS_JOB_PRIORITY_PREFETCH,
      userId: input.userId,
      owner: input.userId ? `${input.userId}:${input.transportId}` : null,
      ...input.extraMetrics,
    },
    createdAt,
    updatedAt: now,
  };
}

export async function enqueueHmsJob(
  input: HmsJobEnqueueInput,
  db: DB = getDb(),
): Promise<{ run: AiWorkflowRun; created: boolean }> {
  const [inserted] = await db
    .insert(aiWorkflowRun)
    .values(hmsJobInsertValues(input))
    .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey })
    .returning();
  if (inserted) return { run: inserted, created: true };
  // A shared job (the same read from another thread's mail) lists this thread too, so its lookup finds the snapshot.
  const threadJson = JSON.stringify([input.threadId]);
  const [shared] = await db
    .update(aiWorkflowRun)
    .set({
      metrics: sql`jsonb_set(coalesce(${aiWorkflowRun.metrics}, '{}'::jsonb), '{sharedThreadIds}', coalesce(${aiWorkflowRun.metrics}->'sharedThreadIds', '[]'::jsonb) || ${threadJson}::jsonb)`,
    })
    .where(
      and(
        eq(aiWorkflowRun.idempotencyKey, input.idempotencyKey),
        ne(aiWorkflowRun.threadId, input.threadId),
        sql`not coalesce(${aiWorkflowRun.metrics}->'sharedThreadIds', '[]'::jsonb) @> ${threadJson}::jsonb`,
      ),
    )
    .returning();
  const [existing] = shared
    ? [shared]
    : await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, input.idempotencyKey))
        .limit(1);
  if (!existing) throw new Error(`failed to enqueue or load HMS job for ${input.idempotencyKey}`);
  return { run: existing, created: false };
}

/** A pane lookup from the signed-in user. Null when the thread has no inbound mail to anchor the run to. */
export async function queueUserHmsJob(
  input: {
    transportId: string;
    userId: string;
    threadId: string;
    request: HmsJobRequest;
    idempotencyKey?: string;
  },
  db: DB = getDb(),
): Promise<AiWorkflowRun | null> {
  const triggerMessageId = await latestInboundMessageId(db, input.transportId, input.threadId);
  if (!triggerMessageId) return null;
  const { run } = await enqueueHmsJob(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId,
      workItemId: await latestWorkItemId(db, input.transportId, input.threadId),
      userId: input.userId,
      request: input.request,
      priority: HMS_JOB_PRIORITY_USER,
      idempotencyKey: input.idempotencyKey ?? `hms-job:user:${randomUUID()}`,
    },
    db,
  );
  return run;
}

const HMS_BATCH_INSERT_CHUNK = 500;
const HMS_BATCH_RESULT_FRESH_MS = 60 * 60_000;

type HmsBatchEnqueueInput = {
  batchId: string;
  transportId: string;
  userId: string;
  workItemIds: string[];
};

type HmsBatchScope = { batchId: string; transportId: string };

type HmsBatchLink = {
  batchId: string;
  itemIndex: number;
  workItemId: string;
  idempotencyKey: string;
  status: 'reused' | 'cancelled';
  linkedRunId: string;
};

type HmsBatchSource = {
  workItemId: string;
  threadId: string;
  triggerMessageId: string;
  extraction: { status: string; kind: string | null; payload: unknown } | null;
  subject: string | null;
  textBody: string | null;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function batchItemIdempotencyKey(batchId: string, workItemId: string): string {
  return `hms-job:batch:${batchId}:${workItemId}`;
}

async function acquireHmsBatchLock(db: DB, input: HmsBatchScope): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'hms-batch:' + input.transportId + ':' + input.batchId}, 0))`,
  );
}

function batchMembershipWhere(input: HmsBatchScope) {
  return and(
    eq(aiWorkflowRun.transportId, input.transportId),
    eq(aiWorkflowRun.runKind, 'read_tool'),
    eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
    or(
      sql`${aiWorkflowRun.metrics}->>'batchId' = ${input.batchId}`,
      sql`${aiWorkflowRun.metrics}->'batchLinks' @> ${JSON.stringify([{ batchId: input.batchId }])}::jsonb`,
    ),
  );
}

async function hmsBatchRows(db: DB, input: HmsBatchScope, forUpdate = false): Promise<AiWorkflowRun[]> {
  const query = db
    .select()
    .from(aiWorkflowRun)
    .where(batchMembershipWhere(input));
  return forUpdate ? query.for('update') : query;
}

function batchMemberships(rows: AiWorkflowRun[], batchId: string): Array<{ itemIndex: number; workItemId: string }> {
  const memberships: Array<{ itemIndex: number; workItemId: string }> = [];
  for (const row of rows) {
    const metrics = objectRecord(row.metrics);
    if (metrics.batchId === batchId && typeof row.workItemId === 'string') {
      const itemIndex = Number(metrics.itemIndex);
      if (Number.isInteger(itemIndex) && itemIndex >= 0) memberships.push({ itemIndex, workItemId: row.workItemId });
    }
    if (!Array.isArray(metrics.batchLinks)) continue;
    for (const value of metrics.batchLinks) {
      const link = objectRecord(value);
      const itemIndex = Number(link.itemIndex);
      if (
        link.batchId === batchId &&
        typeof link.workItemId === 'string' &&
        Number.isInteger(itemIndex) &&
        itemIndex >= 0
      ) {
        memberships.push({ itemIndex, workItemId: link.workItemId });
      }
    }
  }
  return memberships;
}

function assertBatchReplayMatches(
  rows: AiWorkflowRun[],
  input: HmsBatchEnqueueInput,
): void {
  const existing = batchMemberships(rows, input.batchId).sort((a, b) => a.itemIndex - b.itemIndex);
  if (
    existing.length !== input.workItemIds.length ||
    existing.some((item, index) => item.itemIndex !== index || item.workItemId !== input.workItemIds[index])
  ) {
    throw new HmsBatchInputError('batchId was already used for a different work-item list', 'CONFLICT');
  }
}

async function loadHmsBatchSources(db: DB, input: HmsBatchEnqueueInput): Promise<HmsBatchSource[]> {
  const rows: Array<{
    workItemId: string;
    threadId: string;
    triggerMessageId: string;
    subject: string | null;
    textBody: string | null;
  }> = [];
  for (let start = 0; start < input.workItemIds.length; start += HMS_BATCH_INSERT_CHUNK) {
    const ids = input.workItemIds.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    rows.push(
      ...(await db
        .select({
          workItemId: workItem.id,
          threadId: mailThread.id,
          triggerMessageId: message.id,
          subject: message.subject,
          textBody: message.textBody,
        })
        .from(workItem)
        .innerJoin(
          mailThread,
          and(eq(mailThread.id, workItem.threadId), eq(mailThread.transportId, input.transportId)),
        )
        .innerJoin(
          message,
          and(
            eq(message.id, workItem.sourceMessageId),
            eq(message.transportId, input.transportId),
            eq(message.threadId, workItem.threadId),
            eq(message.direction, 'inbound'),
          ),
        )
        .where(and(eq(workItem.transportId, input.transportId), inArray(workItem.id, ids)))),
    );
  }
  if (new Set(rows.map((row) => row.workItemId)).size !== input.workItemIds.length) {
    throw new HmsBatchInputError('one or more work items are unavailable', 'NOT_FOUND');
  }

  const extractions = new Map<string, { status: string; kind: string | null; payload: unknown }>();
  const messageIds = rows.map((row) => row.triggerMessageId);
  for (let start = 0; start < messageIds.length; start += HMS_BATCH_INSERT_CHUNK) {
    const ids = messageIds.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    const versions = await db
      .select({
        messageId: mailExtraction.messageId,
        status: mailExtraction.status,
        kind: mailExtraction.kind,
        payload: mailExtraction.payload,
      })
      .from(mailExtraction)
      .where(inArray(mailExtraction.messageId, ids))
      .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id));
    for (const version of versions) {
      if (!extractions.has(version.messageId)) {
        extractions.set(version.messageId, {
          status: version.status,
          kind: version.kind,
          payload: version.payload,
        });
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    extraction: extractions.get(row.triggerMessageId) ?? null,
  }));
}

function hmsRequestKey(request: HmsJobRequest): string {
  if (request.kind === 'find') {
    return JSON.stringify({ kind: request.kind, confirmation: request.confirmation, arrival: request.arrival ?? null });
  }
  if (request.kind === 'search_guest') {
    return JSON.stringify({
      kind: request.kind,
      lastName: request.lastName.trim().replace(/\s+/g, ' ').toLowerCase(),
      arrival: request.arrival,
      departure: request.departure ?? null,
    });
  }
  return JSON.stringify(request);
}

function batchPrefetchKeys(
  transportId: string,
  threadId: string,
  request: HmsJobRequest,
  now: Date,
): string[] {
  if (request.kind === 'find') {
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    return [today, yesterday].map((day) => `hms-job:prefetch:${transportId}:${request.confirmation}:${day}`);
  }
  if (request.kind === 'search_guest') {
    return [guestSearchPrefetchIdempotencyKey(transportId, threadId, request.lastName, request.arrival)];
  }
  return [];
}

function isReusableHmsRun(run: AiWorkflowRun, request: HmsJobRequest, now: Date): boolean {
  const parsed = hmsJobRequestSchema.safeParse(run.readRequest);
  if (!parsed.success || hmsRequestKey(parsed.data) !== hmsRequestKey(request)) return false;
  if (run.state === 'queued' || run.state === 'claimed' || run.state === 'running' || run.state === 'retry_wait') {
    return true;
  }
  return (
    run.state === 'succeeded' &&
    run.readResult !== null &&
    run.readResult !== undefined &&
    run.finishedAt !== null &&
    run.finishedAt.getTime() <= now.getTime() &&
    now.getTime() - run.finishedAt.getTime() < HMS_BATCH_RESULT_FRESH_MS
  );
}

async function loadReusableHmsRuns(
  db: DB,
  input: HmsBatchEnqueueInput,
  requests: Array<{ source: HmsBatchSource; request: HmsJobRequest }>,
  now: Date,
): Promise<AiWorkflowRun[]> {
  const sourceIds = requests.map(({ source }) => source.workItemId);
  const allPrefetchKeys = [
    ...new Set(
      requests.flatMap(({ source, request }) =>
        batchPrefetchKeys(input.transportId, source.threadId, request, now),
      ),
    ),
  ];
  const rows = new Map<string, AiWorkflowRun>();
  for (let start = 0; start < Math.max(sourceIds.length, allPrefetchKeys.length); start += HMS_BATCH_INSERT_CHUNK) {
    const ids = sourceIds.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    const keys = allPrefetchKeys.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    const candidatePredicates = [
      ...(ids.length ? [inArray(aiWorkflowRun.workItemId, ids)] : []),
      ...(keys.length ? [inArray(aiWorkflowRun.idempotencyKey, keys)] : []),
    ];
    if (candidatePredicates.length === 0) continue;
    const candidates = await db
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.transportId, input.transportId),
          eq(aiWorkflowRun.runKind, 'read_tool'),
          eq(aiWorkflowRun.executorLane, 'hms'),
          eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          or(
            inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']),
            and(eq(aiWorkflowRun.state, 'succeeded'), gte(aiWorkflowRun.finishedAt, new Date(now.getTime() - HMS_BATCH_RESULT_FRESH_MS))),
          ),
          or(...candidatePredicates),
        ),
      )
      .for('update');
    for (const candidate of candidates) rows.set(candidate.id, candidate);
  }
  return [...rows.values()];
}

function hmsBatchLink(input: {
  batchId: string;
  itemIndex: number;
  workItemId: string;
  linkedRunId: string;
}): HmsBatchLink {
  return {
    ...input,
    idempotencyKey: batchItemIdempotencyKey(input.batchId, input.workItemId),
    status: 'reused',
  };
}

function hmsBatchSkippedValues(input: HmsBatchEnqueueInput, source: HmsBatchSource, itemIndex: number, now: Date) {
  return {
    id: randomUUID(),
    transportId: input.transportId,
    threadId: source.threadId,
    triggerMessageId: source.triggerMessageId,
    workItemId: source.workItemId,
    runKind: 'read_tool' as const,
    idempotencyKey: batchItemIdempotencyKey(input.batchId, source.workItemId),
    modelId: NOT_APPLICABLE_MODEL_ID,
    promptVersion: HMS_JOB_PROMPT_VERSION,
    readRequest: null,
    executorLane: 'hms' as const,
    priority: HMS_JOB_PRIORITY_PREFETCH,
    state: 'succeeded' as const,
    nextRunAt: null,
    finishedAt: now,
    metrics: {
      hmsJob: false,
      batchId: input.batchId,
      itemIndex,
      batchItemStatus: 'skipped',
      batchItemReason: 'insufficient_data',
    },
    createdAt: new Date(now.getTime() + itemIndex),
    updatedAt: now,
  };
}

function appendBatchLink(run: { metrics?: unknown }, link: HmsBatchLink): void {
  const metrics = objectRecord(run.metrics);
  const links = Array.isArray(metrics.batchLinks) ? metrics.batchLinks : [];
  run.metrics = { ...metrics, batchLinks: [...links, link] };
}

/** Enqueues all eligible items atomically; skipped items are durable markers, reused lookups add only a metrics link. */
export async function enqueueHmsBatch(
  input: HmsBatchEnqueueInput,
  db: DB = getDb(),
): Promise<HmsBatchView | null> {
  if (!hmsJobQueueEnabled()) return null;
  if (input.workItemIds.length === 0) {
    throw new HmsBatchInputError('a batch must contain at least one work item', 'BAD_REQUEST');
  }
  if (new Set(input.workItemIds).size !== input.workItemIds.length) {
    throw new HmsBatchInputError('workItemIds must be unique', 'BAD_REQUEST');
  }

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DB;
    const scope = { batchId: input.batchId, transportId: input.transportId };
    await acquireHmsBatchLock(scoped, scope);
    const existing = await hmsBatchRows(scoped, scope);
    if (existing.length > 0) {
      assertBatchReplayMatches(existing, input);
      const replay = await readHmsBatchView(scope, scoped);
      if (!replay) throw new Error(`failed to read existing HMS batch ${input.batchId}`);
      return replay;
    }

    const sources = await loadHmsBatchSources(scoped, input);
    const sourceById = new Map(sources.map((source) => [source.workItemId, source]));
    const orderedSources = input.workItemIds.map((id) => sourceById.get(id)!);
    const now = new Date();
    const selections = orderedSources.map((source) =>
      source.extraction?.status === 'succeeded'
        ? selectHmsBatchRequest({
            kind: source.extraction.kind,
            payload: source.extraction.payload,
            subject: source.subject,
            textBody: source.textBody,
          })
        : { skipped: 'insufficient_data' as const },
    );
    const requested = orderedSources.flatMap((source, itemIndex) => {
      const selection = selections[itemIndex]!;
      return 'request' in selection ? [{ source, request: selection.request }] : [];
    });
    const reusable = await loadReusableHmsRuns(scoped, input, requested, now);
    const reusableBySignature = new Map<string, AiWorkflowRun[]>();
    for (const run of reusable) {
      const request = hmsJobRequestSchema.safeParse(run.readRequest);
      if (!request.success || !isReusableHmsRun(run, request.data, now)) continue;
      const signature = hmsRequestKey(request.data);
      reusableBySignature.set(signature, [...(reusableBySignature.get(signature) ?? []), run]);
    }
    for (const runs of reusableBySignature.values()) {
      runs.sort((left, right) => {
        const leftActive = left.state === 'queued' || left.state === 'claimed' || left.state === 'running' || left.state === 'retry_wait';
        const rightActive = right.state === 'queued' || right.state === 'claimed' || right.state === 'running' || right.state === 'retry_wait';
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        return right.createdAt.getTime() - left.createdAt.getTime();
      });
    }

    const insertRows: Array<typeof aiWorkflowRun.$inferInsert> = [];
    const newRunBySignature = new Map<string, typeof aiWorkflowRun.$inferInsert>();
    const linksByExistingRunId = new Map<string, HmsBatchLink[]>();
    for (const [itemIndex, source] of orderedSources.entries()) {
      const selection = selections[itemIndex]!;
      if ('skipped' in selection) {
        insertRows.push(hmsBatchSkippedValues(input, source, itemIndex, now));
        continue;
      }

      const request = selection.request;
      const signature = hmsRequestKey(request);
      const linkedRun = reusableBySignature.get(signature)?.[0];
      if (linkedRun) {
        const link = hmsBatchLink({
          batchId: input.batchId,
          itemIndex,
          workItemId: source.workItemId,
          linkedRunId: linkedRun.id,
        });
        linksByExistingRunId.set(linkedRun.id, [...(linksByExistingRunId.get(linkedRun.id) ?? []), link]);
        continue;
      }

      const plannedRun = newRunBySignature.get(signature);
      if (plannedRun) {
        appendBatchLink(plannedRun, hmsBatchLink({
          batchId: input.batchId,
          itemIndex,
          workItemId: source.workItemId,
          linkedRunId: String(plannedRun.id),
        }));
        continue;
      }

      const job = hmsJobInsertValues({
        transportId: input.transportId,
        threadId: source.threadId,
        triggerMessageId: source.triggerMessageId,
        workItemId: source.workItemId,
        userId: input.userId,
        request,
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: batchItemIdempotencyKey(input.batchId, source.workItemId),
        createdAt: new Date(now.getTime() + itemIndex),
        nextRunAt: now,
        extraMetrics: {
          batchId: input.batchId,
          itemIndex,
          batchItemStatus: 'queued',
        },
      });
      newRunBySignature.set(signature, job);
      insertRows.push(job);
    }

    for (let start = 0; start < insertRows.length; start += HMS_BATCH_INSERT_CHUNK) {
      await scoped
        .insert(aiWorkflowRun)
        .values(insertRows.slice(start, start + HMS_BATCH_INSERT_CHUNK))
        .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey });
    }
    for (const [runId, links] of linksByExistingRunId) {
      const run = reusable.find((candidate) => candidate.id === runId);
      if (!run) continue;
      const metrics = objectRecord(run.metrics);
      const oldLinks = Array.isArray(metrics.batchLinks) ? metrics.batchLinks : [];
      await scoped
        .update(aiWorkflowRun)
        .set({ metrics: { ...metrics, batchLinks: [...oldLinks, ...links] } })
        .where(eq(aiWorkflowRun.id, runId));
    }

    const view = await readHmsBatchView(scope, scoped);
    if (!view || view.items.length !== input.workItemIds.length) {
      throw new Error(`HMS batch ${input.batchId} did not persist all items`);
    }
    return view;
  });
}

// Each prefetch kind has its own hourly budget, so reads of one kind never use another kind's cap.
async function countRecentPrefetches(
  db: DB,
  transportId: string,
  kind: 'find' | 'search_guest' | 'availability',
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, transportId),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
        sql`${aiWorkflowRun.readRequest}->>'kind' = ${kind}`,
        gt(aiWorkflowRun.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Serializes the guest-search count and insert per transport so concurrent extractions cannot overspend the cap. */
async function enqueueGuestPrefetchWithinCap(
  db: DB,
  input: Parameters<typeof enqueueHmsJob>[0],
  perHour: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'hms-prefetch:search_guest:' + input.transportId}, 0))`,
    );
    const scoped = tx as unknown as DB;
    const used = await countRecentPrefetches(scoped, input.transportId, 'search_guest', new Date(Date.now() - PREFETCH_WINDOW_MS));
    if (used >= perHour) return false;
    const result = await enqueueHmsJob(input, scoped);
    return result.created;
  });
}

/**
 * Called after a live inbound extraction or matching triage succeeds. It waits for both when a classifier run exists;
 * only eligible booking-like reads queue, and each is capped per transport per hour. Backfill, sent copies, spam, and
 * resolved source messages never prefetch. Returns jobs created.
 */
export async function prefetchHmsConfirmations(
  run: AiWorkflowRun,
  db: DB = getDb(),
  env = parseEnv(process.env as Record<string, string | undefined>),
): Promise<number> {
  if (!env.HMS_PREFETCH_ENABLED || !hmsJobQueueEnabled()) return 0;
  // Live admission stamps an admission snapshot; backfill and imports do not.
  const isLiveExtraction = run.runKind === 'inbound_extraction' && run.idempotencyKey.startsWith('inbound-extraction:');
  const isLiveTriage = run.runKind === 'inbound_triage' && run.idempotencyKey.startsWith('inbound-triage:');
  if ((!isLiveExtraction && !isLiveTriage) || !run.admissionSnapshotId) {
    return 0;
  }
  const [extractionRun] = await db
    .select({ id: aiWorkflowRun.id })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, run.transportId),
        eq(aiWorkflowRun.threadId, run.threadId),
        eq(aiWorkflowRun.triggerMessageId, run.triggerMessageId),
        eq(aiWorkflowRun.admissionSnapshotId, run.admissionSnapshotId),
        eq(aiWorkflowRun.runKind, 'inbound_extraction'),
        eq(aiWorkflowRun.state, 'succeeded'),
        like(aiWorkflowRun.idempotencyKey, 'inbound-extraction:%'),
      ),
    )
    .limit(1);
  if (!extractionRun) return 0;
  const [triageRun] = await db
    .select({ state: aiWorkflowRun.state })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, run.transportId),
        eq(aiWorkflowRun.threadId, run.threadId),
        eq(aiWorkflowRun.triggerMessageId, run.triggerMessageId),
        eq(aiWorkflowRun.admissionSnapshotId, run.admissionSnapshotId),
        eq(aiWorkflowRun.runKind, 'inbound_triage'),
        like(aiWorkflowRun.idempotencyKey, 'inbound-triage:%'),
      ),
    )
    .limit(1);
  if (triageRun && triageRun.state !== 'succeeded') return 0;
  const [source] = await db
    .select({
      extractionStatus: mailExtraction.status,
      kind: mailExtraction.kind,
      payload: mailExtraction.payload,
      subject: message.subject,
      textBody: message.textBody,
      direction: message.direction,
      historyOnly: message.historyOnly,
      fromAddress: message.fromAddress,
      threadHistoryOnly: mailThread.historyOnly,
      spamAt: mailThread.spamAt,
      mailboxEmail: mailboxTransport.email,
    })
    .from(mailExtraction)
    .innerJoin(message, eq(message.id, mailExtraction.messageId))
    .innerJoin(mailThread, eq(mailThread.id, message.threadId))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(
      and(
        eq(mailExtraction.messageId, run.triggerMessageId),
        eq(message.transportId, run.transportId),
        eq(message.threadId, run.threadId),
      ),
    )
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  // Spam and imported/history copies never spend either prefetch budget.
  if (
    !source ||
    source.extractionStatus !== 'succeeded' ||
    (source.kind !== 'booking' &&
      source.kind !== 'amendment' &&
      source.kind !== 'cancellation' &&
      source.kind !== 'voucher_pop') ||
    source.spamAt ||
    source.threadHistoryOnly ||
    source.historyOnly ||
    source.direction !== 'inbound'
  ) {
    return 0;
  }
  const from = normalizeEmailAddress(source.fromAddress);
  const mailbox = normalizeEmailAddress(source.mailboxEmail);
  if (from === mailbox) return 0;
  if (isStaffSender(source.fromAddress, source.mailboxEmail)) {
    const sentFrom = await knownSenders(db, run.transportId, [source.fromAddress]);
    if (sentFrom.has(from)) return 0;
  }

  const triggerItem = await workItemForMessage(db, run.transportId, run.threadId, run.triggerMessageId);
  if (triggerItem?.status === 'done' || triggerItem?.status === 'dismissed') return 0;
  const workItemId = triggerItem?.id ?? null;
  let created = 0;
  const numbers = prefetchConfirmations(source.payload, source.subject, source.textBody);
  // Find keeps its existing cap; extraction confirmations are first, followed by any number in the mail text.
  const dayKey = new Date().toISOString().slice(0, 10);
  for (const confirmation of numbers) {
    const used = await countRecentPrefetches(
      db,
      run.transportId,
      'find',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
    if (used >= env.HMS_PREFETCH_PER_HOUR) break;
    const result = await enqueueHmsJob(
      {
        transportId: run.transportId,
        threadId: run.threadId,
        triggerMessageId: run.triggerMessageId,
        workItemId,
        userId: null,
        request: { kind: 'find', confirmation },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        // Same number again on the same day is a no-op, whichever mail carried it.
        idempotencyKey: `hms-job:prefetch:${run.transportId}:${confirmation}:${dayKey}`,
      },
      db,
    );
    if (result.created) created += 1;
  }

  if (numbers.length === 0) {
    const lastName = explicitGuestSurname(source.subject, source.textBody);
    const arrival = extractUniqueArrivalForHmsPrefetch(source.kind ?? '', source.payload);
    if (!lastName || !arrival || env.HMS_GUEST_PREFETCH_PER_HOUR <= 0) return created;
    const queued = await enqueueGuestPrefetchWithinCap(
      db,
      {
        transportId: run.transportId,
        threadId: run.threadId,
        triggerMessageId: run.triggerMessageId,
        workItemId,
        userId: null,
        request: { kind: 'search_guest', lastName, arrival },
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: guestSearchPrefetchIdempotencyKey(run.transportId, run.threadId, lastName, arrival),
      },
      env.HMS_GUEST_PREFETCH_PER_HOUR,
    );
    if (queued) created += 1;
  }
  return created;
}

/** Fire-and-forget from the worker after the live inbound run succeeds. Off unless HMS_JOB_QUEUE=on and HMS_PREFETCH_ENABLED=1. */
export function schedulePrefetchForInbound(run: AiWorkflowRun): void {
  void prefetchHmsConfirmations(run).catch(() => undefined);
}

/**
 * Availability probes for an admitted quote's stored extraction: one per complete stay, at prefetch priority and under
 * their own hourly cap (HMS_AVAILABILITY_PER_HOUR), separate from confirmation prefetch. Only quote mail, never spam. The same stay on the same day is one job, whichever mail carried
 * it. Returns how many jobs were created.
 */
export async function prefetchAvailabilityForExtraction(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId'>,
  db: DB = getDb(),
  env: NodeJS.Dict<string> = process.env,
): Promise<number> {
  if (!availabilityPrefetchEnabled(env) || run.runKind !== 'inbound_extraction') return 0;
  const [extraction] = await db
    .select({ threadId: message.threadId, payload: mailExtraction.payload, spamAt: mailThread.spamAt })
    .from(mailExtraction)
    .innerJoin(message, eq(message.id, mailExtraction.messageId))
    .innerJoin(mailThread, eq(mailThread.id, message.threadId))
    .where(
      and(
        eq(mailExtraction.messageId, run.triggerMessageId),
        eq(mailExtraction.kind, 'quote'),
        eq(mailExtraction.status, 'succeeded'),
        eq(message.transportId, run.transportId),
      ),
    )
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!extraction || extraction.spamAt) return 0;
  const perHour = availabilityProbesPerHour(env);
  const workItemId = await latestWorkItemId(db, run.transportId, extraction.threadId);
  const dayKey = new Date().toISOString().slice(0, 10);
  let created = 0;
  for (const request of availabilityRequestsFor(extraction.payload)) {
    const used = await countRecentPrefetches(
      db,
      run.transportId,
      'availability',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
    if (used >= perHour) break;
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
    const result = await enqueueHmsJob(
      {
        transportId: run.transportId,
        threadId: extraction.threadId,
        triggerMessageId: run.triggerMessageId,
        workItemId,
        userId: null,
        request,
        priority: HMS_JOB_PRIORITY_PREFETCH,
        idempotencyKey: `hms-job:availability:${run.transportId}:${digest}:${dayKey}`,
      },
      db,
    );
    if (result.created) created += 1;
  }
  return created;
}

/** Fire-and-forget from the worker after a quote extraction is stored. Off unless HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on. */
export function scheduleAvailabilityPrefetch(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId'>,
): void {
  void prefetchAvailabilityForExtraction(run).catch(() => undefined);
}

async function requeueRun(
  db: DB,
  mark: Mark,
  input: { attempts: number; delayMs: number; failureClass: AiFailureClass; lastError: string },
): Promise<'retry_wait'> {
  await markAiRunRetry(
    {
      ...mark,
      attempts: input.attempts,
      nextRunAt: new Date(Date.now() + input.delayMs),
      lastError: input.lastError,
      failureClass: input.failureClass,
      // A yielded or retried job runs again later, so its next claim gets a fresh run deadline.
      resetDeadline: true,
    },
    db,
  );
  return 'retry_wait';
}

async function retryOrFail(
  db: DB,
  run: AiWorkflowRun,
  mark: Mark,
  failureClass: AiFailureClass,
  lastError: string,
): Promise<'retry_wait' | 'dead_letter'> {
  const attempts = run.attempts + 1;
  if (attempts >= JOB_MAX_ATTEMPTS) {
    await markAiRunDeadLetter({ ...mark, lastError, failureClass }, db);
    return 'dead_letter';
  }
  await requeueRun(db, mark, {
    attempts,
    delayMs: JOB_RETRY_MS * attempts,
    failureClass,
    lastError,
  });
  return 'retry_wait';
}

/**
 * Runs one claimed job. Called from executeAiRun after markAiRunRunning, so
 * the fence is already live. Returns the state the run should end in.
 */
export async function executeHmsJob(input: {
  run: AiWorkflowRun;
  fence: AiRunFence;
  db?: DB;
}): Promise<'succeeded' | 'retry_wait' | 'dead_letter'> {
  const db = input.db ?? getDb();
  const { run, fence } = input;
  const mark: Mark = {
    runId: run.id,
    claimOwner: fence.claimOwner,
    claimToken: fence.claimToken,
    expectedStates: ['running'],
  };
  const parsed = hmsJobRequestSchema.safeParse(run.readRequest);
  if (!parsed.success) {
    await markAiRunDeadLetter(
      { ...mark, lastError: 'hms job request invalid', failureClass: 'SCHEMA_DRIFT' },
      db,
    );
    return 'dead_letter';
  }
  const request = parsed.data;
  const background = run.priority < HMS_JOB_PRIORITY_USER;
  if (background && (await staffQuoteInFlight(db))) {
    // Yield without counting an attempt, so a quote in flight does not use up the job's retries.
    return requeueRun(db, mark, {
      attempts: run.attempts,
      delayMs: JOB_YIELD_MS,
      failureClass: 'STAFF_QUOTE_ACTIVE',
      lastError: 'staff quote in flight',
    });
  }

  const metrics = (run.metrics ?? {}) as { userId?: string | null; owner?: string | null };
  const ownerKey = metrics.owner ?? `hms-job-prefetch:${run.transportId}`;
  const screenshotDir: { value: string | null } = { value: null };
  const deps = {
    lock: () => paneStayLookupLoaders.lock ?? paneStayPropertyLock(),
    acquisition: background ? { tryOnce: true } : acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    onRun: ({ runId, dir }: { runId: string; dir: string }) => {
      screenshotDir.value = dir;
      registerPaneRun({ runId, dir, owner: ownerKey, now: Date.now() });
    },
  };
  const audit = {
    transportId: run.transportId,
    messageId: null,
    userId: metrics.userId ?? null,
    inputDigest: toolInputDigest(request as Record<string, unknown>),
  };
  const result =
    request.kind === 'availability'
      ? await probeAvailability(request, { lock: deps.lock, acquisition: deps.acquisition })
      : request.kind === 'find'
        ? await recordedToolRun(
            { kind: 'stay_lookup', ...audit },
            () =>
              findStay(
                {
                  confirmation: request.confirmation,
                  ...(request.arrival ? { arrival: request.arrival } : {}),
                },
                deps,
              ),
            classifyFind,
          )
        : await recordedToolRun(
            { kind: 'guest_search', ...audit },
            () =>
              searchGuest(
                {
                  lastName: request.lastName,
                  arrival: request.arrival,
                  ...(request.departure ? { departure: request.departure } : {}),
                },
                deps,
              ),
            classifySearch,
          );

  const outcome: string = result.outcome;
  if (outcome === 'refused_lock_busy') {
    if (background) {
      return requeueRun(db, mark, {
        attempts: run.attempts,
        delayMs: JOB_YIELD_MS,
        failureClass: 'HMS_LOCK_BUSY',
        lastError: 'property lock busy',
      });
    }
    return retryOrFail(db, run, mark, 'HMS_LOCK_BUSY', 'property lock busy');
  }
  if (outcome === 'execution_failure') {
    return retryOrFail(db, run, mark, 'TRANSIENT_NETWORK', 'lookup execution failed');
  }
  if (outcome.startsWith('refused_')) {
    await markAiRunDeadLetter(
      {
        ...mark,
        lastError: outcome,
        failureClass: outcome === 'refused_input_invalid' ? 'SCHEMA_DRIFT' : 'POLICY_BLOCK',
      },
      db,
    );
    return 'dead_letter';
  }

  // Found, not found, ambiguous, or a completed guest search. Stored as a dated snapshot.
  const marked = await markAiRunSucceeded(
    {
      ...mark,
      readResult: { ...result, kind: request.kind, asOf: new Date().toISOString() },
      metrics: { hmsJob: true, kind: request.kind, outcome, screenshotDir: screenshotDir.value },
    },
    db,
  );
  // ponytail: the CLI spawn keeps its own 5-minute timeout; the run deadline is enforced at claim time, not during the spawn.
  await pruneExpiredPaneRuns(Date.now());
  return marked ? 'succeeded' : 'retry_wait';
}

const STATUS_BY_STATE: Record<AiWorkflowRunState, HmsJobStatus> = {
  queued: 'queued',
  claimed: 'running',
  running: 'running',
  retry_wait: 'retrying',
  succeeded: 'done',
  dead_letter: 'failed',
  superseded: 'failed',
};

async function queuePosition(db: DB, run: AiWorkflowRun): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.executorLane, 'hms'),
        // Pane jobs only: an hms_write run in the lane is never ahead of a job in this queue.
        eq(aiWorkflowRun.runKind, 'read_tool'),
        inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
        or(
          gt(aiWorkflowRun.priority, run.priority),
          and(
            eq(aiWorkflowRun.priority, run.priority),
            lt(aiWorkflowRun.createdAt, run.createdAt),
          ),
        ),
      ),
    );
  return Number(row?.n ?? 0) + 1;
}

async function toView(
  db: DB,
  run: AiWorkflowRun,
  options: { includePosition?: boolean } = {},
): Promise<HmsJobView> {
  const request = hmsJobRequestSchema.safeParse(run.readRequest);
  const status = STATUS_BY_STATE[run.state];
  const result = run.state === 'succeeded' && run.readResult ? run.readResult : null;
  return {
    runId: run.id,
    request: request.success ? request.data : null,
    prefetch: run.priority === HMS_JOB_PRIORITY_PREFETCH,
    status,
    position: status === 'queued' && options.includePosition !== false ? await queuePosition(db, run) : null,
    attempts: run.attempts,
    failureClass: run.failureClass,
    asOf: typeof result?.asOf === 'string' ? result.asOf : null,
    result,
  };
}

/**
 * The job's status and snapshot from the database. By run id for polling, or
 * the latest job of one kind on a thread (and confirmation, for finds) to
 * resume after the pane remounts. Null when nothing matches.
 */
export async function readHmsJobView(
  input:
    | { transportId: string; runId: string }
    | {
        transportId: string;
        threadId: string;
        kind: 'find' | 'search_guest' | 'availability';
        confirmation?: string;
        /** A guest search's surname, compared case- and space-insensitively: one thread can carry two guests' searches. */
        lastName?: string;
        /** A stay's dates pick its availability snapshot; its rooms tell apart two stays on the same dates. */
        arrival?: string;
        /** Null explicitly matches a guest-search request with no departure constraint. */
        departure?: string | null;
        rooms?: AvailabilityRequest['rooms'];
      },
  db: DB = getDb(),
): Promise<HmsJobView | null> {
  const scope = and(
    eq(aiWorkflowRun.transportId, input.transportId),
    eq(aiWorkflowRun.runKind, 'read_tool'),
    eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
  );
  const [run] =
    'runId' in input
      ? await db
          .select()
          .from(aiWorkflowRun)
          .where(and(eq(aiWorkflowRun.id, input.runId), scope))
          .limit(1)
      : await db
          .select()
          .from(aiWorkflowRun)
          .where(
            and(
              or(
                eq(aiWorkflowRun.threadId, input.threadId),
                sql`${aiWorkflowRun.metrics}->'sharedThreadIds' @> ${JSON.stringify([input.threadId])}::jsonb`,
              ),
              scope,
              sql`${aiWorkflowRun.readRequest}->>'kind' = ${input.kind}`,
              ...(input.confirmation
                ? [sql`${aiWorkflowRun.readRequest}->>'confirmation' = ${input.confirmation}`]
                : []),
              ...(input.lastName
                ? [
                    sql`lower(btrim(regexp_replace(${aiWorkflowRun.readRequest}->>'lastName', '[[:space:]]+', ' ', 'g'))) = ${input.lastName.trim().replace(/\s+/g, ' ').toLowerCase()}`,
                  ]
                : []),
              ...(input.arrival
                ? [sql`${aiWorkflowRun.readRequest}->>'arrival' = ${input.arrival}`]
                : []),
              ...(input.departure === undefined
                ? []
                : input.departure === null
                  ? [sql`${aiWorkflowRun.readRequest}->>'departure' IS NULL`]
                  : [sql`${aiWorkflowRun.readRequest}->>'departure' = ${input.departure}`]),
              ...(input.rooms
                ? [sql`${aiWorkflowRun.readRequest}->'rooms' = ${JSON.stringify(input.rooms)}::jsonb`]
                : []),
            ),
          )
          .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
          .limit(1);
  return run ? toView(db, run) : null;
}

function batchEffectiveStatus(item: HmsBatchItemView): HmsJobStatus | 'cancelled' {
  if (item.status === 'skipped') return 'done';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status === 'reused') return item.job?.status ?? 'done';
  return item.status;
}

function hmsBatchRollup(items: HmsBatchItemView[]): HmsBatchStatus {
  const effective = items.map(batchEffectiveStatus);
  if (effective.includes('cancelled')) return 'cancelled';

  const hasQueued = effective.some((status) => status === 'queued' || status === 'retrying');
  const hasRunning = effective.includes('running');
  if (hasQueued || hasRunning) {
    const started = items.some((item) =>
      item.status !== 'skipped' &&
      item.status !== 'cancelled' &&
      item.job !== null &&
      (item.job.status !== 'queued' || item.job.attempts > 0),
    );
    return started ? 'running' : 'queued';
  }

  const failed = effective.filter((status) => status === 'failed').length;
  if (failed > 0) return failed === items.length ? 'failed' : 'partial';
  return 'done';
}

function hmsBatchSummary(items: HmsBatchItemView[]): HmsBatchView['summary'] {
  const summary: HmsBatchView['summary'] = {
    total: items.length,
    queued: 0,
    running: 0,
    retrying: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    reused: 0,
  };
  for (const item of items) summary[item.status] += 1;
  return summary;
}

/** Reads durable batch membership and the linked job snapshots; no pane state is required after remount. */
export async function readHmsBatchView(input: HmsBatchScope, db: DB = getDb()): Promise<HmsBatchView | null> {
  const rows = await hmsBatchRows(db, input);
  if (rows.length === 0) return null;

  const items: HmsBatchItemView[] = [];
  for (const run of rows) {
    const metrics = objectRecord(run.metrics);
    if (metrics.batchId === input.batchId && typeof metrics.itemIndex === 'number') {
      if (metrics.batchItemStatus === 'skipped') {
        items.push({
          itemIndex: metrics.itemIndex,
          workItemId: run.workItemId ?? '',
          status: 'skipped',
          reason: metrics.batchItemReason === 'insufficient_data' ? 'insufficient_data' : null,
          runId: null,
          request: null,
          job: null,
        });
      } else {
        const job = await toView(db, run, { includePosition: false });
        items.push({
          itemIndex: metrics.itemIndex,
          workItemId: run.workItemId ?? '',
          status: metrics.batchItemStatus === 'cancelled' ? 'cancelled' : job.status,
          reason: null,
          runId: run.id,
          request: job.request,
          job,
        });
      }
    }

    if (!Array.isArray(metrics.batchLinks)) continue;
    for (const value of metrics.batchLinks) {
      const link = objectRecord(value);
      if (
        link.batchId !== input.batchId ||
        typeof link.itemIndex !== 'number' ||
        typeof link.workItemId !== 'string'
      ) {
        continue;
      }
      const job = await toView(db, run, { includePosition: false });
      items.push({
        itemIndex: link.itemIndex,
        workItemId: link.workItemId,
        status: link.status === 'cancelled' ? 'cancelled' : 'reused',
        reason: null,
        runId: typeof link.linkedRunId === 'string' ? link.linkedRunId : run.id,
        request: job.request,
        job,
      });
    }
  }

  items.sort((left, right) => left.itemIndex - right.itemIndex);
  if (items.some((item, index) => item.itemIndex !== index)) {
    throw new Error(`HMS batch ${input.batchId} has incomplete item membership`);
  }
  return {
    batchId: input.batchId,
    status: hmsBatchRollup(items),
    summary: hmsBatchSummary(items),
    items,
  };
}

/** Cancels this batch's unclaimed remainder without stopping a lookup another batch still reuses. */
export async function cancelHmsBatch(input: HmsBatchScope, db: DB = getDb()): Promise<HmsBatchView | null> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DB;
    await acquireHmsBatchLock(scoped, input);
    const rows = await hmsBatchRows(scoped, input, true);
    const now = new Date();
    for (const run of rows) {
      const metrics = objectRecord(run.metrics);
      let nextMetrics = metrics;
      let changed = false;
      const primaryItem = metrics.batchId === input.batchId;
      const queued = run.state === 'queued' || run.state === 'retry_wait';
      const cancelPrimary =
        primaryItem &&
        queued &&
        metrics.batchItemStatus !== 'skipped' &&
        metrics.batchItemStatus !== 'cancelled';
      if (cancelPrimary) {
        nextMetrics = { ...nextMetrics, batchItemStatus: 'cancelled' };
        changed = true;
      }
      let batchLinks = Array.isArray(metrics.batchLinks) ? metrics.batchLinks : [];
      if (Array.isArray(metrics.batchLinks) && queued) {
        let linkChanged = false;
        batchLinks = metrics.batchLinks.map((value) => {
          const link = objectRecord(value);
          if (link.batchId === input.batchId && link.status === 'reused') {
            linkChanged = true;
            return { ...link, status: 'cancelled' };
          }
          return value;
        });
        if (linkChanged) {
          nextMetrics = { ...nextMetrics, batchLinks };
          changed = true;
        }
      }
      const primaryCancelled =
        cancelPrimary ||
        (typeof metrics.batchId === 'string' && metrics.batchItemStatus === 'cancelled');
      const hasOtherBatchConsumers = batchLinks.some((value) => objectRecord(value).status === 'reused');
      const cancelRun = queued && primaryCancelled && !hasOtherBatchConsumers;
      changed ||= cancelRun;
      if (!changed) continue;
      await scoped
        .update(aiWorkflowRun)
        .set({
          metrics: nextMetrics,
          ...(cancelRun
            ? {
                state: 'superseded',
                nextRunAt: null,
                claimOwner: null,
                claimToken: null,
                deadlineAt: null,
                lastError: 'HMS_BATCH_CANCELLED',
                failureClass: null,
                finishedAt: now,
                updatedAt: now,
              }
            : {}),
        })
        .where(eq(aiWorkflowRun.id, run.id));
    }
    return readHmsBatchView(input, scoped);
  });
}

/**
 * Re-registers a job's screenshot directory for the web process, which keeps
 * no record of lookups the worker ran. Only the owner's own job on this
 * transport, and only the directory the worker recorded for it.
 */
export async function registerJobScreenshotRun(
  input: { transportId: string; owner: string; cliRunId: string },
  db: DB = getDb(),
): Promise<void> {
  if (!PANE_RUN_ID_PATTERN.test(input.cliRunId)) return;
  const [run] = await db
    .select({ metrics: aiWorkflowRun.metrics })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        sql`${aiWorkflowRun.metrics}->>'owner' = ${input.owner}`,
        sql`${aiWorkflowRun.readResult}->>'runId' = ${input.cliRunId}`,
      ),
    )
    .limit(1);
  const dir = (run?.metrics as { screenshotDir?: unknown } | null | undefined)?.screenshotDir;
  if (typeof dir !== 'string' || basename(dir) !== `pane-lookup-${input.cliRunId}`) return;
  registerPaneRun({ runId: input.cliRunId, dir, owner: input.owner, now: Date.now() });
}

/** A claim whose heartbeat is older than this belongs to a dead worker: three lease heartbeats of slack. */
const HMS_CLAIM_STALE_MS = 60_000;

/**
 * Runs at worker start. Read runs that a dead hms worker still held go back to
 * retry_wait now, not after the stale-claim timeout. A claim with a fresh
 * heartbeat belongs to a live worker and is left alone.
 */
export async function requeueHmsReadsAfterRestart(
  input: { ownerId: string },
  db: DB = getDb(),
): Promise<number> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const staleRuns = await tx
      .select()
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.executorLane, 'hms'),
          eq(aiWorkflowRun.runKind, 'read_tool'),
          inArray(aiWorkflowRun.state, ['claimed', 'running']),
          like(aiWorkflowRun.claimOwner, 'hms-ai-worker-%'),
          ne(aiWorkflowRun.claimOwner, input.ownerId),
          lt(aiWorkflowRun.heartbeatAt, new Date(now.getTime() - HMS_CLAIM_STALE_MS)),
        ),
      )
      .for('update', { skipLocked: true });

    for (const run of staleRuns) {
      const metrics = objectRecord(run.metrics);
      const previousCrashes = Number(metrics.crashCount);
      const crashCount = (Number.isInteger(previousCrashes) && previousCrashes >= 0 ? previousCrashes : 0) + 1;
      const deadLetter = crashCount >= 3;
      await tx
        .update(aiWorkflowRun)
        .set({
          state: deadLetter ? 'dead_letter' : 'retry_wait',
          claimOwner: null,
          claimToken: null,
          nextRunAt: deadLetter ? null : now,
          // The dead worker's deadline may have elapsed; a retry gets a fresh one on claim.
          deadlineAt: null,
          lastError: deadLetter ? 'HMS_RESTART_LIMIT' : 'hms worker restarted',
          failureClass: 'LEASE_LOST',
          finishedAt: deadLetter ? now : null,
          metrics: { ...metrics, crashCount },
          updatedAt: now,
        })
        .where(eq(aiWorkflowRun.id, run.id));
    }
    return staleRuns.length;
  });
}

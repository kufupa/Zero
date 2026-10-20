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
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte, inArray, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailCategory,
  mailboxTransport,
  mailThread,
  mailThreadCategory,
  message,
} from '../db/schema/mail.js';
import { aiAgentRun } from '../db/schema/hitl.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { parseEnv } from '../env.js';
import { classifyMailSource, isMailSourceClassification } from './mail-source.js';
import {
  isOwnedHotelHost,
  lookupLearnedSenderHistory,
  partyHistoryBindEnabled,
  recordSenderParty,
  type RecordSenderPartyInput,
} from './party-sender-map.js';
import { staffQuoteInFlight } from '../hms/property-queue-state.js';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  hmsDavinciReadsEnabled,
  hmsReadAuditMetrics,
  hmsReadTargetJobMetrics,
  isDaVinciTransport,
  parseHmsReadTarget,
  resolveHmsReadJobTarget,
  type HmsReadTarget,
} from '../hms/hms-read-target.js';
import { guardCenturionHmsMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import {
  availabilityRequestSchema,
  availabilityRequestsFor,
  probeAvailability,
  type AvailabilityRequest,
} from './hms-availability.js';
import {
  classifyFind,
  classifySearch,
  classifyStaffQuote,
  createToolRunRecorder,
  ledgerQuoteInput,
  recordedToolRun,
  toolInputDigest,
} from './hitl-tool-run.js';
import {
  findStay,
  GUEST_SURNAME_PATTERN,
  paneStayLookupLoaders,
  searchGuest,
} from './pane-stay-lookup.js';
import { findParty, findPartyJob, type PanePartyFindResult, type PanePartyKind } from './pane-party-lookup.js';
import { suggestPartiesFor } from './party-aliases.js';
import { QUOTE_WORKFLOW_PROMPT_VERSION, quoteWorkflowLlmEnabled } from './quote-workflow-llm.js';
import { resolveAdapter } from './quote-workflow-analyse-selection.js';
import {
  applyPartyBindRule,
  buildPartyMatchCandidates,
  distinctivePartyTokens,
  partyMatchEmailContext,
  PARTY_MATCH_V2_ROW_CAP,
  PARTY_MATCH_V2_SEARCH_CAP,
  pickPartyMatch,
  planPartySearches,
  type PartyMatchEmailContext,
  type PartyMatchRow,
} from './party-match-v2.js';
import {
  PANE_RUN_ID_PATTERN,
  paneStayPropertyLock,
  pruneExpiredPaneRuns,
  registerPaneRun,
} from './pane-stay-save.js';
import { normalizeEmailAddress } from './never-spam.js';
import { extractVoucherGuest, surnameFrom } from './voucher-find.js';
import { isStaffSender, knownSenders } from './work-items.js';
import {
  staffQuoteInput,
  staffQuoteSourceHash,
  type StaffQuoteInput,
} from './staff-quote-workflow.js';
import {
  buildPreparedStaffQuotePlan,
  confidentPartyFromV2Result,
  quotePrepareKindReason,
  staffQuoteInputsPriceEquivalent,
  type PreparedStaffQuotePlan,
} from './quote-ready.js';
import {
  runStaffQuote,
  staffQuoteFailureCode,
  staffQuoteFailureMessage,
  staffQuoteFailurePhase,
  staffQuoteRoomAlternatives,
  type StaffQuoteRunIdentity,
} from './staff-quote-run.js';
import { PRICED_QUOTE_REUSE_MS, quoteDigest } from '../quote-proposal/quote-revision.js';
import {
  type AiFailureClass,
  type AiRunFence,
  type AiWorkflowRun,
  type AiWorkflowRunState,
  HMS_JOB_PROMPT_VERSION,
  markAiRunDeadLetter,
  markAiRunPolicyRefused,
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

/** Default-off quote preparation. It can enqueue only when the persisted HMS queue is enabled. */
export function quotePreparationEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return (
    env.HMS_QUOTE_PREPARE === 'true' ||
    env.HMS_QUOTE_PREPARE === '1' ||
    env.HMS_QUOTE_PREPARE === 'on'
  ) && hmsJobQueueEnabled(env);
}

/** System-prepared quote jobs per transport/hour. Invalid direct test input fails back to the safe default. */
export function quotePreparationPerHour(env: NodeJS.Dict<string> = process.env): number {
  const raw = env.HMS_QUOTE_PREPARE_PER_HOUR?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 6;
}

/** Availability probes for quote stays (U10). Off (the default) unless HMS_JOB_QUEUE=on and HMS_AVAILABILITY_PREFETCH=on. */
export function availabilityPrefetchEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.HMS_AVAILABILITY_PREFETCH === 'on' && hmsJobQueueEnabled(env);
}

/** Default-off so the V2 prefetch cannot run until a deployment explicitly enables it. */
export function partyMatchV2Enabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env.PARTY_MATCH_V2 === 'true' || env.PARTY_MATCH_V2 === '1';
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
export const HMS_JOB_PRIORITY_DEV = -10;
export const HMS_JOB_PRIORITY_REFRESH = -20;

export function isSystemPreparedPriority(priority: number): boolean {
  return priority <= HMS_JOB_PRIORITY_PREFETCH;
}
const JOB_MAX_ATTEMPTS = 3;
const JOB_RETRY_MS = 30_000;
const JOB_YIELD_MS = 30_000;
const STAFF_QUOTE_RESULT_TTL_MS = 6 * 60 * 60_000;
const PREFETCH_PER_MAIL_MAX = 3;
const PREFETCH_WINDOW_MS = 60 * 60_000;
const PARTY_USER_PER_HOUR = 12;
const PARTY_READBACK_FRESH_MS = 24 * 60 * 60_000;
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
  z
    .object({
      kind: z.literal('party'),
      name: z.string().min(1).max(256),
      partyKind: z.enum(['company', 'agency']).optional(),
      /** Only inbound prefetch can opt into the experimental V2 worker path. */
      matchVersion: z.literal(2).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('staff_quote'),
      input: staffQuoteInput,
    })
    .strict(),
  availabilityRequestSchema,
]);
export type HmsJobRequest = z.infer<typeof hmsJobRequestSchema>;

export type HmsJobStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed';

export type HmsJobView = {
  runId: string;
  sourceMessageId: string;
  request: HmsJobRequest | null;
  prefetch: boolean;
  status: HmsJobStatus;
  /** 1-based place in the hms lane queue; set only while queued. */
  position: number | null;
  attempts: number;
  failureClass: string | null;
  /** When the snapshot in `result` was taken (ISO). Null until a run succeeds. */
  asOf: string | null;
  /** When the job entered the HMS lane (ISO), used to show elapsed time while it runs. */
  createdAt: string;
  /** A safe, closed outcome for party failures that do not have a result snapshot. */
  outcome: string | null;
  result: Record<string, unknown> | null;
};

export type HmsBatchStatus = 'queued' | 'running' | 'partial' | 'done' | 'failed' | 'cancelled';
export type HmsBatchItemStatus = HmsJobStatus | 'skipped' | 'reused' | 'cancelled';
export type HmsBatchSkipReason = 'insufficient_data' | 'spam' | 'davinci_origin';

export type HmsBatchItemView = {
  itemIndex: number;
  workItemId: string;
  status: HmsBatchItemStatus;
  reason: HmsBatchSkipReason | null;
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

const COMPANY_NAME_TOKEN = /^(?:pty|ltd|holdings|group|travel|services|bank|hotel)$/i;

/** Two-or-more word person name with no company tokens, digits, or email. Surname is the last token via surnameFrom. */
function personSurnameFromName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || /\d/.test(name) || name.includes('@')) return null;
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  if (tokens.some((token) => COMPANY_NAME_TOKEN.test(token.replace(/[().,]/g, '')))) return null;
  return surnameFrom(name);
}

/** Labelled guest first; else a person endClient; else a private-sender contact name. */
function prefetchGuestSurname(
  subject: string | null,
  textBody: string | null,
  payload: unknown,
): string | null {
  const labelled = explicitGuestSurname(subject, textBody);
  if (labelled) return labelled;
  const record = objectRecord(payload);
  const fromEndClient = personSurnameFromName(record.endClient);
  if (fromEndClient) return fromEndClient;
  const agency = typeof record.agency === 'string' ? record.agency.trim() : '';
  if (agency) return null;
  return personSurnameFromName(objectRecord(record.contact).name);
}

function extractionConfirmations(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const values = (payload as { confirmationNumbers?: unknown }).confirmationNumbers;
  if (!Array.isArray(values)) return [];
  return values.filter(
    (value): value is string => typeof value === 'string' && HMS_CONFIRMATION.test(value),
  );
}

/**
 * One arrival for every stay, else null. Booking uses requested; amendment/cancellation/voucher_pop use booked only.
 * search_guest matches the stay's arrival day exactly, so requested (often the new dates) is not a fallback.
 */
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

/** The automatic pane find shares this daily key with confirmation prefetches. */
export function confirmationPrefetchIdempotencyKey(
  transportId: string,
  confirmation: string,
  day = new Date().toISOString().slice(0, 10),
): string {
  return `hms-job:prefetch:${transportId}:${confirmation}:${day}`;
}

/** One kind-less party prefetch per transport, normalized name and UTC day.
 * Its result can be read by either matching picker.
 */
export function partyPrefetchIdempotencyKey(
  transportId: string,
  name: string,
  day: string,
): string {
  const digest = createHash('sha256')
    .update(`${name.replace(/\s+/g, ' ').trim().toLowerCase()}\n${day}`)
    .digest('hex')
    .slice(0, 24);
  return `hms-job:prefetch-party:${transportId}:${digest}`;
}

/** V2 decisions use email-specific evidence, so they must never reuse another email's party pick. */
export function partyPrefetchV2IdempotencyKey(
  transportId: string,
  messageId: string,
  day: string,
): string {
  const digest = createHash('sha256')
    .update(`${messageId}\n${day}`)
    .digest('hex')
    .slice(0, 24);
  return `hms-job:prefetch-party-v2:${transportId}:${digest}`;
}

/** A quote's extracted agency wins; otherwise use the first unverified email hint.
 * Never infer a party id.
 */
export function selectPartyPrefetchRequest(input: {
  kind: string | null;
  payload: unknown;
  sender: string | null;
  body: string | null;
}): Extract<HmsJobRequest, { kind: 'party' }> | null {
  if (quotePrepareKindReason({ kind: input.kind, payload: input.payload }) === 'not_quote') return null;
  const payload = objectRecord(input.payload);
  const agency = typeof payload.agency === 'string' ? payload.agency.trim() : '';
  if (agency.length > 0 && agency.length <= 256)
    return { kind: 'party', name: agency };
  const suggestion = suggestPartiesFor({ sender: input.sender ?? '', body: input.body ?? '' })[0];
  if (!suggestion || !suggestion.name.trim() || suggestion.name.trim().length > 256) return null;
  return { kind: 'party', name: suggestion.name.trim() };
}

/** V2 keeps every useful extracted agency/client name; no HMS id is guessed during enqueue. */
export function selectPartyMatchV2PrefetchRequest(input: {
  kind: string | null;
  payload: unknown;
  sender: string | null;
  subject?: string | null;
  body: string | null;
  allowLearnedSenderHistory?: boolean;
}): Extract<HmsJobRequest, { kind: 'party' }> | null {
  if (
    quotePrepareKindReason({ kind: input.kind, payload: input.payload, subject: input.subject }) === 'not_quote'
  ) {
    return null;
  }
  const candidates = buildPartyMatchCandidates({
    payload: input.payload,
    fromAddress: input.sender,
    subject: input.subject,
    body: input.body,
    allowLearnedSenderHistory: input.allowLearnedSenderHistory,
  });
  const first = planPartySearches(candidates)[0];
  if (!first || !first.candidateName.trim() || first.candidateName.length > 256) return null;
  return { kind: 'party', name: first.candidateName, matchVersion: 2 };
}

function prefetchConfirmations(
  payload: unknown,
  subject: string | null,
  textBody: string | null,
): string[] {
  const text = extractHmsConfirmations(`${subject ?? ''}\n${textBody ?? ''}`);
  return [...new Set([...extractionConfirmations(payload), ...text])].slice(
    0,
    PREFETCH_PER_MAIL_MAX,
  );
}

export function selectHmsBatchRequest(input: {
  kind: string | null;
  payload: unknown;
  subject: string | null;
  textBody: string | null;
}): { request: HmsJobRequest } | { skipped: 'insufficient_data' } {
  const confirmation = prefetchConfirmations(input.payload, input.subject, input.textBody)[0];
  if (confirmation) return { request: { kind: 'find', confirmation } };

  const lastName = prefetchGuestSurname(input.subject, input.textBody, input.payload);
  const arrival = extractUniqueArrivalForHmsPrefetch(input.kind ?? '', input.payload);
  const search = hmsJobRequestSchema.safeParse({ kind: 'search_guest', lastName, arrival });
  if (search.success) return { request: search.data };
  return { skipped: 'insufficient_data' };
}

async function latestWorkItemId(
  db: DB,
  transportId: string,
  threadId: string,
): Promise<string | null> {
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
  return (
    items.find((item) => item.status === 'needs_you' || item.status === 'review') ??
    items[0] ??
    null
  );
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
      prefetch: isSystemPreparedPriority(input.priority),
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

/** Auto-starts serialize one actor/mail/input request so simultaneous pane mounts share a fresh run. */
export async function queueAutoStaffQuoteHmsJob(
  input: Omit<HmsJobEnqueueInput, 'idempotencyKey' | 'request'> & {
    userId: string;
    request: Extract<HmsJobRequest, { kind: 'staff_quote' }>;
  },
  db: DB = getDb(),
): Promise<{ run: AiWorkflowRun; created: boolean }> {
  const lockKey = JSON.stringify([
    'hms-auto-staff-quote', input.transportId, input.userId, input.triggerMessageId,
    hmsRequestKey(input.request),
  ]);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const scoped = tx as unknown as DB;
    const [existing] = await latestStaffQuoteRunFor(
      scoped,
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.executorLane, 'hms'),
        eq(aiWorkflowRun.triggerMessageId, input.triggerMessageId),
      ),
      input.request.input.messageId,
      input.request.input,
      input.userId,
      input.extraMetrics?.devEval === true,
    );
    if (existing) return { run: existing, created: false };
    return enqueueHmsJob({ ...input, idempotencyKey: `hms-job:staff-quote:${randomUUID()}` }, scoped);
  });
}

/** A pane lookup from the signed-in user. Null when the thread has no inbound mail to anchor the run to. */
export async function queueUserHmsJob(
  input: {
    transportId: string;
    userId: string;
    threadId: string;
    request: HmsJobRequest;
    idempotencyKey?: string;
    target?: HmsReadTarget;
    devEval?: boolean;
    extraMetrics?: Record<string, unknown>;
  },
  db: DB = getDb(),
): Promise<AiWorkflowRun | null> {
  const triggerMessageId = await latestInboundMessageId(db, input.transportId, input.threadId);
  if (!triggerMessageId) return null;
  const target = input.target ?? CENTURION_HMS_READ_TARGET;
  const { run } = await enqueueHmsJob(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId,
      workItemId: await latestWorkItemId(db, input.transportId, input.threadId),
      userId: input.userId,
      request: input.request,
      priority: input.devEval ? HMS_JOB_PRIORITY_DEV : HMS_JOB_PRIORITY_USER,
      idempotencyKey: input.idempotencyKey ?? `hms-job:user:${randomUUID()}`,
      extraMetrics: {
        ...hmsReadAuditMetrics({ actorKind: 'user', actorUserId: input.userId, target }),
        ...hmsReadTargetJobMetrics(target),
        ...input.extraMetrics,
        ...(input.devEval ? { devEval: true } : {}),
      },
    },
    db,
  );
  return run;
}

export class HmsPartyQueueLimitError extends Error {
  constructor() {
    super('HMS party search limit reached for this mailbox. Try again later.');
    this.name = 'HmsPartyQueueLimitError';
  }
}

export function userPartyIdempotencyKey(input: {
  transportId: string;
  request: Extract<HmsJobRequest, { kind: 'party' }>;
  day: string;
  retry: boolean;
  propertyCode: string;
  devEval?: boolean;
}): string {
  const digest = createHash('sha256')
    .update(
      `${input.propertyCode}\n${input.request.partyKind ?? ''}\n${input.request.name.replace(/\s+/g, ' ').trim().toLowerCase()}\n${input.day}`,
    )
    .digest('hex')
    .slice(0, 24);
  const key = `hms-job:user-party:${input.propertyCode}:${input.transportId}:${digest}${input.devEval ? ':dev-eval' : ''}`;
  return input.retry ? `${key}:retry:${randomUUID()}` : key;
}

/** A pane party search: user-priority, transport-capped, and deduplicated for one normalized field/name per day. */
export async function queueUserPartyHmsJob(
  input: {
    transportId: string;
    userId: string;
    threadId: string;
    request: Extract<HmsJobRequest, { kind: 'party' }>;
    retry?: boolean;
    devEval?: boolean;
    propertyCode?: string;
    extraMetrics?: Record<string, unknown>;
  },
  db: DB = getDb(),
): Promise<AiWorkflowRun | null> {
  const triggerMessageId = await latestInboundMessageId(db, input.transportId, input.threadId);
  if (!triggerMessageId) return null;
  const workItemId = await latestWorkItemId(db, input.transportId, input.threadId);
  const day = new Date().toISOString().slice(0, 10);
  const propertyCode = input.propertyCode ?? 'HRCEN';
  const target =
    input.propertyCode === DAVINCI_HMS_READ_TARGET.propertyCode
      ? DAVINCI_HMS_READ_TARGET
      : CENTURION_HMS_READ_TARGET;
  const audit = hmsReadAuditMetrics({
    actorKind: 'user',
    actorUserId: input.userId,
    target,
  });
  let idempotencyKey = userPartyIdempotencyKey({
    transportId: input.transportId,
    request: input.request,
    day,
    retry: input.retry === true,
    propertyCode,
    devEval: input.devEval === true,
  });
  const priority = input.devEval ? HMS_JOB_PRIORITY_DEV : HMS_JOB_PRIORITY_USER;
  const extraMetrics = { ...audit, ...input.extraMetrics, ...(input.devEval ? { devEval: true } : {}) };

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'hms-user-party:' + input.transportId}, 0))`,
    );
    const scoped = tx as unknown as DB;
    if (!input.retry) {
      const [existing] = await scoped
        .select({ lastError: aiWorkflowRun.lastError })
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing && existing.lastError !== 'HMS_PARTY_SUPERSEDED') {
        return (
          await enqueueHmsJob(
            {
              transportId: input.transportId,
              threadId: input.threadId,
              triggerMessageId,
              workItemId,
              userId: input.userId,
              request: input.request,
              priority,
              idempotencyKey,
              extraMetrics,
            },
            scoped,
          )
        ).run;
      }
      if (existing) idempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
    }

    const [usedRow] = await scoped
      .select({ n: sql<number>`count(*)::int` })
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.transportId, input.transportId),
          eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          eq(aiWorkflowRun.priority, HMS_JOB_PRIORITY_USER),
          sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
          gt(aiWorkflowRun.createdAt, new Date(Date.now() - PREFETCH_WINDOW_MS)),
        ),
      );
    if (Number(usedRow?.n ?? 0) >= PARTY_USER_PER_HOUR) throw new HmsPartyQueueLimitError();

    const fieldKind = input.request.partyKind;
    await scoped
      .update(aiWorkflowRun)
      .set({
        state: 'superseded',
        nextRunAt: null,
        claimOwner: null,
        claimToken: null,
        deadlineAt: null,
        lastError: 'HMS_PARTY_SUPERSEDED',
        failureClass: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiWorkflowRun.transportId, input.transportId),
          eq(aiWorkflowRun.threadId, input.threadId),
          eq(aiWorkflowRun.runKind, 'read_tool'),
          eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          eq(aiWorkflowRun.priority, priority),
          eq(aiWorkflowRun.state, 'queued'),
          sql`coalesce(${aiWorkflowRun.metrics}->'sharedThreadIds', '[]'::jsonb) = '[]'::jsonb`,
          sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
          fieldKind
            ? sql`${aiWorkflowRun.readRequest}->>'partyKind' = ${fieldKind}`
            : sql`${aiWorkflowRun.readRequest}->>'partyKind' IS NULL`,
        ),
      );

    return (
      await enqueueHmsJob(
        {
          transportId: input.transportId,
          threadId: input.threadId,
          triggerMessageId,
          workItemId,
          userId: input.userId,
          request: input.request,
          priority,
          idempotencyKey,
          extraMetrics,
        },
        scoped,
      )
    ).run;
  });
}

const HMS_BATCH_INSERT_CHUNK = 500;
const HMS_BATCH_RESULT_FRESH_MS = 60 * 60_000;

type HmsBatchEnqueueInput = {
  batchId: string;
  transportId: string;
  userId: string;
  workItemIds: string[];
  originRefusedWorkItemIds?: readonly string[];
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
  spamAt: Date | null;
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

// Lock order: this transaction lock is taken only in enqueueHmsBatch and cancelHmsBatch, and nothing inside those
// transactions takes the property lock (paneStayPropertyLock) or the guest-prefetch lock. Property-lock holders (HMS
// spawns, the staff quote, the read service) never enqueue batch or prefetch rows, so no path nests the two locks.
// One lock per transport, not per batch: overlapping batches must see each other's runs before they reuse or insert,
// or the same work item is read twice.
async function acquireHmsBatchLock(db: DB, input: { transportId: string }): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'hms-batch:' + input.transportId}, 0))`,
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

// Locking reads take rows in id order, the same order the restart sweep uses, so no two transactions wait on each other.
async function hmsBatchRows(
  db: DB,
  input: HmsBatchScope,
  forUpdate = false,
): Promise<AiWorkflowRun[]> {
  const query = db
    .select()
    .from(aiWorkflowRun)
    .where(batchMembershipWhere(input))
    .orderBy(aiWorkflowRun.id);
  return forUpdate ? query.for('update') : query;
}

function batchMemberships(
  rows: AiWorkflowRun[],
  batchId: string,
): Array<{ itemIndex: number; workItemId: string }> {
  const memberships: Array<{ itemIndex: number; workItemId: string }> = [];
  for (const row of rows) {
    const metrics = objectRecord(row.metrics);
    if (metrics.batchId === batchId && typeof row.workItemId === 'string') {
      const itemIndex = Number(metrics.itemIndex);
      if (Number.isInteger(itemIndex) && itemIndex >= 0)
        memberships.push({ itemIndex, workItemId: row.workItemId });
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

function assertBatchReplayMatches(rows: AiWorkflowRun[], input: HmsBatchEnqueueInput): void {
  const existing = batchMemberships(rows, input.batchId).sort((a, b) => a.itemIndex - b.itemIndex);
  if (
    existing.length !== input.workItemIds.length ||
    existing.some(
      (item, index) => item.itemIndex !== index || item.workItemId !== input.workItemIds[index],
    )
  ) {
    throw new HmsBatchInputError(
      'batchId was already used for a different work-item list',
      'CONFLICT',
    );
  }
}

async function loadHmsBatchSources(db: DB, input: HmsBatchEnqueueInput): Promise<HmsBatchSource[]> {
  const rows: Array<{
    workItemId: string;
    threadId: string;
    triggerMessageId: string;
    spamAt: Date | null;
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
          spamAt: mailThread.spamAt,
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
      // Only a succeeded version carries a payload. A newer failed or pending version must not hide an older
      // succeeded one; with none, selectHmsBatchRequest falls back to the message text.
      if (version.status !== 'succeeded') continue;
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

function stableStaffQuoteInput(
  input: StaffQuoteInput,
): Omit<StaffQuoteInput, 'selectionEpoch' | 'inputRevision'> {
  const stable: Partial<StaffQuoteInput> = { ...input };
  delete stable.selectionEpoch;
  delete stable.inputRevision;
  return stable as Omit<StaffQuoteInput, 'selectionEpoch' | 'inputRevision'>;
}

function hmsRequestKey(request: HmsJobRequest): string {
  if (request.kind === 'find') {
    return JSON.stringify({
      kind: request.kind,
      confirmation: request.confirmation,
      arrival: request.arrival ?? null,
    });
  }
  if (request.kind === 'search_guest') {
    return JSON.stringify({
      kind: request.kind,
      lastName: request.lastName.trim().replace(/\s+/g, ' ').toLowerCase(),
      arrival: request.arrival,
      departure: request.departure ?? null,
    });
  }
  if (request.kind === 'staff_quote') {
    return JSON.stringify({ kind: request.kind, input: stableStaffQuoteInput(request.input) });
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
    return [today, yesterday].map(
      (day) => `hms-job:prefetch:${transportId}:${request.confirmation}:${day}`,
    );
  }
  if (request.kind === 'search_guest') {
    return [
      guestSearchPrefetchIdempotencyKey(transportId, threadId, request.lastName, request.arrival),
    ];
  }
  return [];
}

function isReusableHmsRun(run: AiWorkflowRun, request: HmsJobRequest, now: Date): boolean {
  const parsed = hmsJobRequestSchema.safeParse(run.readRequest);
  if (!parsed.success || hmsRequestKey(parsed.data) !== hmsRequestKey(request)) return false;
  if (
    run.state === 'queued' ||
    run.state === 'claimed' ||
    run.state === 'running' ||
    run.state === 'retry_wait'
  ) {
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
  // Pass 1, unlocked: collect every candidate id across the chunks.
  const candidateIds = new Set<string>();
  for (
    let start = 0;
    start < Math.max(sourceIds.length, allPrefetchKeys.length);
    start += HMS_BATCH_INSERT_CHUNK
  ) {
    const ids = sourceIds.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    const keys = allPrefetchKeys.slice(start, start + HMS_BATCH_INSERT_CHUNK);
    // A run also serves every work item in its batchLinks, so a link to the item is a match, not only workItemId.
    const candidatePredicates = [
      ...(ids.length
        ? [
            inArray(aiWorkflowRun.workItemId, ids),
            ...ids.map(
              (id) =>
                sql`${aiWorkflowRun.metrics}->'batchLinks' @> ${JSON.stringify([{ workItemId: id }])}::jsonb`,
            ),
          ]
        : []),
      ...(keys.length ? [inArray(aiWorkflowRun.idempotencyKey, keys)] : []),
    ];
    if (candidatePredicates.length === 0) continue;
    const found = await db
      .select({ id: aiWorkflowRun.id })
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.transportId, input.transportId),
          eq(aiWorkflowRun.runKind, 'read_tool'),
          eq(aiWorkflowRun.executorLane, 'hms'),
          eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
          or(
            inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']),
            and(
              eq(aiWorkflowRun.state, 'succeeded'),
              gte(aiWorkflowRun.finishedAt, new Date(now.getTime() - HMS_BATCH_RESULT_FRESH_MS)),
            ),
          ),
          or(...candidatePredicates),
        ),
      );
    for (const row of found) candidateIds.add(row.id);
  }
  if (candidateIds.size === 0) return [];
  // Pass 2 locks every candidate in ONE statement, in id order, before any insert. The restart sweep also locks in
  // id order, so the two cannot wait on each other; a lock statement per chunk could.
  return db
    .select()
    .from(aiWorkflowRun)
    .where(inArray(aiWorkflowRun.id, [...candidateIds]))
    .orderBy(aiWorkflowRun.id)
    .for('update');
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

function hmsBatchSkippedValues(
  input: HmsBatchEnqueueInput,
  source: HmsBatchSource,
  itemIndex: number,
  now: Date,
  reason: HmsBatchSkipReason,
) {
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
      batchItemReason: reason,
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
    // Spam gets no lookup: the thread-state gate (spamAt) the automatic prefetch also applies. An extraction label
    // alone is not spam, because staff can clear spam on a thread whose extraction still says spam.
    const originRefused = new Set(input.originRefusedWorkItemIds ?? []);
    const selections = await Promise.all(
      orderedSources.map(
        async (source): Promise<{ skipped: HmsBatchSkipReason } | { request: HmsJobRequest }> => {
          if (source.spamAt) return { skipped: 'spam' };
          if (originRefused.has(source.workItemId)) return { skipped: 'davinci_origin' };
          const guard = await guardCenturionHmsMailboxOrigin({
            transportId: input.transportId,
            threadId: source.threadId,
            messageId: source.triggerMessageId,
          });
          if (!guard.ok) return { skipped: 'davinci_origin' };
          // No succeeded extraction still leaves the message text, so a confirmation in the subject or body queues.
          return selectHmsBatchRequest({
            kind: source.extraction?.kind ?? null,
            payload: source.extraction?.payload ?? null,
            subject: source.subject,
            textBody: source.textBody,
          });
        },
      ),
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
        const leftActive =
          left.state === 'queued' ||
          left.state === 'claimed' ||
          left.state === 'running' ||
          left.state === 'retry_wait';
        const rightActive =
          right.state === 'queued' ||
          right.state === 'claimed' ||
          right.state === 'running' ||
          right.state === 'retry_wait';
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
        insertRows.push(hmsBatchSkippedValues(input, source, itemIndex, now, selection.skipped));
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
        linksByExistingRunId.set(linkedRun.id, [
          ...(linksByExistingRunId.get(linkedRun.id) ?? []),
          link,
        ]);
        continue;
      }

      const plannedRun = newRunBySignature.get(signature);
      if (plannedRun) {
        appendBatchLink(
          plannedRun,
          hmsBatchLink({
            batchId: input.batchId,
            itemIndex,
            workItemId: source.workItemId,
            linkedRunId: String(plannedRun.id),
          }),
        );
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
  kind: 'find' | 'search_guest' | 'party' | 'availability' | 'staff_quote',
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, transportId),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        lte(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
        // Staff batch rows share the prefetch priority but carry batchId: they neither use nor are capped by these budgets.
        sql`${aiWorkflowRun.metrics}->>'batchId' IS NULL`,
        ...(kind === 'staff_quote'
          ? [
              sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
            ]
          : []),
        sql`${aiWorkflowRun.readRequest}->>'kind' = ${kind}`,
        gt(aiWorkflowRun.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Serializes prepared-quote cap checks/inserts across workers for one mailbox. Live digests remain idempotent. */
async function enqueuePreparedQuoteWithinCap(
  db: DB,
  input: Parameters<typeof enqueueHmsJob>[0],
  perHour: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${'hms-prefetch:staff_quote:' + input.transportId}, 0
      ))`,
    );
    const scoped = tx as unknown as DB;
    const existing = await scoped
      .select({ id: aiWorkflowRun.id, idempotencyKey: aiWorkflowRun.idempotencyKey, state: aiWorkflowRun.state })
      .from(aiWorkflowRun)
      .where(
        and(
          eq(aiWorkflowRun.transportId, input.transportId),
          eq(aiWorkflowRun.triggerMessageId, input.triggerMessageId),
          sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
          sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
          sql`left(${aiWorkflowRun.idempotencyKey}, length(${input.idempotencyKey})) = ${input.idempotencyKey}`,
        ),
      );
    if (existing.some((run) => run.state !== 'dead_letter' && run.state !== 'superseded')) return false;
    const used = await countRecentPrefetches(
      scoped,
      input.transportId,
      'staff_quote',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
    if (used >= perHour) return false;
    const retryInput = existing.length
      ? { ...input, idempotencyKey: `${input.idempotencyKey}:retry:${randomUUID()}` }
      : input;
    const queued = await enqueueHmsJob(retryInput, scoped);
    return queued.created;
  });
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
    const used = await countRecentPrefetches(
      scoped,
      input.transportId,
      'search_guest',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
    if (used >= perHour) return false;
    const result = await enqueueHmsJob(input, scoped);
    return result.created;
  });
}

/** Serializes the party count and insert per transport, using the shared mail-prefetch cap. */
async function enqueuePartyPrefetchWithinCap(
  db: DB,
  input: Parameters<typeof enqueueHmsJob>[0],
  perHour: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${'hms-prefetch:party:' + input.transportId}, 0
      ))`,
    );
    const scoped = tx as unknown as DB;
    const used = await countRecentPrefetches(
      scoped,
      input.transportId,
      'party',
      new Date(Date.now() - PREFETCH_WINDOW_MS),
    );
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
  const isLiveExtraction =
    run.runKind === 'inbound_extraction' && run.idempotencyKey.startsWith('inbound-extraction:');
  const isLiveTriage =
    run.runKind === 'inbound_triage' && run.idempotencyKey.startsWith('inbound-triage:');
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
  if (source.fromAddress && isStaffSender(source.fromAddress, source.mailboxEmail)) {
    const sentFrom = await knownSenders(db, run.transportId, [source.fromAddress]);
    if (sentFrom.has(from)) return 0;
  }

  const triggerItem = await workItemForMessage(
    db,
    run.transportId,
    run.threadId,
    run.triggerMessageId,
  );
  if (triggerItem?.status === 'done' || triggerItem?.status === 'dismissed') return 0;
  const origin = await guardCenturionHmsMailboxOrigin({
    transportId: run.transportId,
    threadId: run.threadId,
    messageId: run.triggerMessageId,
  });
  if (!origin.ok) return 0;
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
        idempotencyKey: confirmationPrefetchIdempotencyKey(run.transportId, confirmation, dayKey),
        extraMetrics: hmsReadAuditMetrics({ actorKind: 'system', target: CENTURION_HMS_READ_TARGET }),
      },
      db,
    );
    if (result.created) created += 1;
  }

  if (numbers.length === 0) {
    const lastName = prefetchGuestSurname(source.subject, source.textBody, source.payload);
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
        idempotencyKey: guestSearchPrefetchIdempotencyKey(
          run.transportId,
          run.threadId,
          lastName,
          arrival,
        ),
        extraMetrics: hmsReadAuditMetrics({ actorKind: 'system', target: CENTURION_HMS_READ_TARGET }),
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
    .select({
      threadId: message.threadId,
      payload: mailExtraction.payload,
      spamAt: mailThread.spamAt,
    })
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
  const origin = await guardCenturionHmsMailboxOrigin({
    transportId: run.transportId,
    threadId: extraction.threadId,
    messageId: run.triggerMessageId,
  });
  if (!origin.ok) return 0;
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

/** One background company/agency search for a successful quote extraction,
 * under the normal mail-prefetch cap.
 */
export async function prefetchPartyForExtraction(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId'>,
  db: DB = getDb(),
  env = parseEnv(process.env as Record<string, string | undefined>),
): Promise<number> {
  if (!env.HMS_PREFETCH_ENABLED || !hmsJobQueueEnabled() || run.runKind !== 'inbound_extraction')
    return 0;
  const [source] = await db
    .select({
      threadId: message.threadId,
      extractionStatus: mailExtraction.status,
      kind: mailExtraction.kind,
      payload: mailExtraction.payload,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      direction: message.direction,
      historyOnly: message.historyOnly,
      fromAddress: message.fromAddress,
      ownerHeaderValue: message.ownerHeaderValue,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
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
      ),
    )
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
    .limit(1);
  if (
    !source ||
    source.extractionStatus !== 'succeeded' ||
    quotePrepareKindReason({ kind: source.kind, payload: source.payload, subject: source.subject }) ===
      'not_quote' ||
    source.spamAt ||
    source.threadHistoryOnly ||
    source.historyOnly ||
    source.direction !== 'inbound' ||
    objectRecord(source.payload).action === 'no_action'
  ) {
    return 0;
  }
  const sourceClassification = classifyMailSource({
    fromAddress: source.fromAddress,
    subject: source.subject,
    bodyText: source.textBody ?? source.htmlBody,
  });
  if (sourceClassification.kind !== 'direct') return 0;
  const from = normalizeEmailAddress(source.fromAddress);
  const mailbox = normalizeEmailAddress(source.mailboxEmail);
  if (from === mailbox) return 0;
  const origin = await guardCenturionHmsMailboxOrigin({
    transportId: run.transportId,
    threadId: source.threadId,
    messageId: run.triggerMessageId,
  });
  if (!origin.ok) return 0;
  if (isStaffSender(source.fromAddress, source.mailboxEmail)) {
    const sentFrom = await knownSenders(db, run.transportId, [source.fromAddress]);
    if (sentFrom.has(from)) return 0;
  }

  const request = env.PARTY_MATCH_V2
    ? selectPartyMatchV2PrefetchRequest({
        kind: source.kind,
        payload: source.payload,
        sender: source.fromAddress,
        subject: source.subject,
        body: source.textBody,
        allowLearnedSenderHistory: isCenturionPartyHistoryTarget(null, run.transportId),
      })
    : selectPartyPrefetchRequest({
        kind: source.kind,
        payload: source.payload,
        sender: source.fromAddress,
        body: source.textBody,
      });
  if (!request || env.HMS_PREFETCH_PER_HOUR <= 0) return 0;
  const queued = await enqueuePartyPrefetchWithinCap(
    db,
    {
      transportId: run.transportId,
      threadId: source.threadId,
      triggerMessageId: run.triggerMessageId,
      workItemId: await latestWorkItemId(db, run.transportId, source.threadId),
      userId: null,
      request,
      priority: HMS_JOB_PRIORITY_PREFETCH,
      idempotencyKey:
        request.matchVersion === 2
          ? partyPrefetchV2IdempotencyKey(
              run.transportId,
              run.triggerMessageId,
              new Date().toISOString().slice(0, 10),
            )
          : partyPrefetchIdempotencyKey(
              run.transportId,
              request.name,
              new Date().toISOString().slice(0, 10),
            ),
    },
    env.HMS_PREFETCH_PER_HOUR,
  );
  return queued ? 1 : 0;
}

/** Fire-and-forget after a successful quote extraction.
 * Off unless the queue and HMS_PREFETCH_ENABLED are on.
 */
export function schedulePartyPrefetch(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId'>,
): void {
  void prefetchPartyForExtraction(run).catch(() => undefined);
}

type QuoteReadyMessageSource = {
  extractionStatus: string;
  kind: string;
  payload: unknown;
  messageId: string;
  transportId: string;
  threadId: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  direction: string;
  historyOnly: boolean;
  fromAddress: string | null;
  threadHistoryOnly: boolean;
  spamAt: Date | null;
  mailboxEmail: string;
};

export type QuoteReadyMessageEvaluation = {
  messageId: string;
  transportId: string | null;
  threadId: string | null;
  preparationEnabled: boolean;
  plan: PreparedStaffQuotePlan | null;
  reason: string | null;
};

async function quoteReadySourceForMessage(
  db: DB,
  messageId: string,
  transportId?: string,
): Promise<QuoteReadyMessageSource | null> {
  const [source] = await db
    .select({
      extractionStatus: mailExtraction.status,
      kind: mailExtraction.kind,
      payload: mailExtraction.payload,
      messageId: message.id,
      transportId: message.transportId,
      threadId: message.threadId,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
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
        eq(mailExtraction.messageId, messageId),
        ...(transportId ? [eq(message.transportId, transportId)] : []),
      ),
    )
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
    .limit(1);
  return (source as QuoteReadyMessageSource | undefined) ?? null;
}

async function threadIsAutomatedChannel(db: DB, source: QuoteReadyMessageSource): Promise<boolean> {
  const [category] = await db
    .select({ threadId: mailThreadCategory.threadId })
    .from(mailThreadCategory)
    .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
    .where(
      and(
        eq(mailThreadCategory.threadId, source.threadId),
        eq(mailThreadCategory.transportId, source.transportId),
        eq(mailCategory.transportId, source.transportId),
        eq(mailCategory.slug, 'automated-channel'),
      ),
    )
    .limit(1);
  return Boolean(category);
}

function sourceDecisionIsAutomated(value: unknown): boolean {
  return isMailSourceClassification(value) && value.kind !== 'direct';
}

async function inboundTriagePendingOrAutomated(
  db: DB,
  source: QuoteReadyMessageSource,
): Promise<'pending' | 'automated' | null> {
  const [triage] = await db
    .select({ state: aiWorkflowRun.state, metrics: aiWorkflowRun.metrics })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, source.transportId),
        eq(aiWorkflowRun.threadId, source.threadId),
        eq(aiWorkflowRun.triggerMessageId, source.messageId),
        eq(aiWorkflowRun.runKind, 'inbound_triage'),
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);
  if (!triage) return null;
  if (sourceDecisionIsAutomated(objectRecord(triage.metrics).mailSourceDecision)) return 'automated';
  return ['queued', 'claimed', 'running', 'retry_wait'].includes(triage.state) ? 'pending' : null;
}

async function latestPartyMatchV2ForMessage(
  db: DB,
  source: QuoteReadyMessageSource,
): Promise<AiWorkflowRun | null> {
  const [run] = await db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, source.transportId),
        eq(aiWorkflowRun.threadId, source.threadId),
        eq(aiWorkflowRun.triggerMessageId, source.messageId),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.executorLane, 'hms'),
        lte(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
        sql`${aiWorkflowRun.metrics}->>'userId' IS NULL`,
        sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
        sql`${aiWorkflowRun.readRequest}->>'matchVersion' = '2'`,
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);
  return run ?? null;
}

/** Read-only evaluation shared by the worker and quote-ready-eval.ts. No message text leaves this function. */
export async function evaluateQuoteReadyForMessage(
  input: { messageId: string; transportId?: string },
  db: DB = getDb(),
  env: NodeJS.Dict<string> = process.env,
  now: Date = new Date(),
): Promise<QuoteReadyMessageEvaluation> {
  const preparationEnabled = quotePreparationEnabled(env);
  const empty = (reason: string, source?: QuoteReadyMessageSource): QuoteReadyMessageEvaluation => ({
    messageId: input.messageId,
    transportId: source?.transportId ?? input.transportId ?? null,
    threadId: source?.threadId ?? null,
    preparationEnabled,
    plan: null,
    reason,
  });
  const source = await quoteReadySourceForMessage(db, input.messageId, input.transportId);
  if (!source) return empty('source_not_found');
  if (source.extractionStatus !== 'succeeded') return empty('extraction_not_succeeded', source);
  if (quotePrepareKindReason({ kind: source.kind, payload: source.payload, subject: source.subject }) === 'not_quote') {
    return empty('not_quote', source);
  }
  if (source.direction !== 'inbound') return empty('not_inbound', source);
  if (source.historyOnly || source.threadHistoryOnly) return empty('history_copy', source);
  if (source.spamAt) return empty('spam', source);
  const payload = objectRecord(source.payload);
  if (payload.origin === 'system_notice') return empty('system_notice', source);
  if (payload.action === 'no_action') return empty('no_action', source);
  const sourceClassification = classifyMailSource({
    fromAddress: source.fromAddress,
    subject: source.subject,
    bodyText: source.textBody ?? source.htmlBody,
  });
  if (sourceClassification.kind !== 'direct') return empty('channel_or_ota', source);
  if (await threadIsAutomatedChannel(db, source)) return empty('channel_or_ota', source);
  const triage = await inboundTriagePendingOrAutomated(db, source);
  if (triage === 'pending') return empty('triage_pending', source);
  if (triage === 'automated') return empty('channel_or_ota', source);
  if (!source.fromAddress) return empty('missing_sender', source);

  const from = normalizeEmailAddress(source.fromAddress);
  const mailbox = normalizeEmailAddress(source.mailboxEmail);
  if (from === mailbox) return empty('mailbox_sender', source);
  if (isStaffSender(source.fromAddress, source.mailboxEmail)) {
    const sentFrom = await knownSenders(db, source.transportId, [source.fromAddress]);
    if (sentFrom.has(from)) return empty('staff_sender', source);
  }

  const partyRun = await latestPartyMatchV2ForMessage(db, source);
  if (partyRun && ['queued', 'claimed', 'running', 'retry_wait'].includes(partyRun.state)) {
    return empty('party_match_pending', source);
  }
  let parties;
  if (partyRun?.state === 'succeeded') {
    const quoteLlmParty = await existingQuoteWorkflowParty(db, source.transportId, source.messageId);
    const partyMetrics = objectRecord(partyRun.metrics);
    const hasRecordedTarget = partyMetrics.hmsReadTarget !== undefined;
    const target = hasRecordedTarget ? parseHmsReadTarget(partyMetrics.hmsReadTarget) : null;
    const allowLearnedSenderHistory =
      !isDaVinciTransport(source.transportId) &&
      (!hasRecordedTarget || target?.propertyCode === CENTURION_HMS_READ_TARGET.propertyCode);
    parties = confidentPartyFromV2Result({
      payload: source.payload,
      fromAddress: source.fromAddress,
      subject: source.subject,
      body: source.textBody ?? source.htmlBody,
      quoteLlmParty,
      allowLearnedSenderHistory,
      result: partyRun.readResult,
    });
  }
  const plan = buildPreparedStaffQuotePlan({
    messageId: source.messageId,
    sourceHash: staffQuoteSourceHash({
      id: source.messageId,
      subject: source.subject,
      textBody: source.textBody,
      htmlBody: source.htmlBody,
    }),
    payload: source.payload,
    ...(parties ? { parties } : {}),
    now,
  });
  return {
    messageId: source.messageId,
    transportId: source.transportId,
    threadId: source.threadId,
    preparationEnabled,
    plan,
    reason: plan.reason,
  };
}

/** Creates one userless, low-priority staff-quote read for each complete future stay. */
export async function prefetchQuoteReadyForExtraction(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId'>,
  db: DB = getDb(),
  env: NodeJS.Dict<string> = process.env,
  now: Date = new Date(),
  priority: number = HMS_JOB_PRIORITY_PREFETCH,
): Promise<number> {
  if (run.runKind !== 'inbound_extraction' || !quotePreparationEnabled(env)) return 0;
  const evaluation = await evaluateQuoteReadyForMessage(
    { messageId: run.triggerMessageId, transportId: run.transportId },
    db,
    env,
    now,
  );
  if (!evaluation.plan?.inputs.length || !evaluation.transportId || !evaluation.threadId) return 0;
  const origin = await guardCenturionHmsMailboxOrigin({
    transportId: evaluation.transportId,
    threadId: evaluation.threadId,
    messageId: evaluation.messageId,
  });
  if (!origin.ok) return 0;
  const workItemId = await latestWorkItemId(db, evaluation.transportId, evaluation.threadId);
  const perHour = quotePreparationPerHour(env);
  let created = 0;
  for (const quoteInput of evaluation.plan.inputs) {
    const digest = createHash('sha256').update(JSON.stringify(quoteInput)).digest('hex');
    const queued = await enqueuePreparedQuoteWithinCap(
      db,
      {
        transportId: evaluation.transportId,
        threadId: evaluation.threadId,
        triggerMessageId: evaluation.messageId,
        workItemId,
        userId: null,
        request: { kind: 'staff_quote', input: quoteInput },
        priority,
        idempotencyKey: `hms-job:staff-quote-prepared:${evaluation.transportId}:${evaluation.messageId}:${digest}`,
        extraMetrics: { quotePrepared: true },
      },
      perHour,
    );
    if (queued) created += 1;
  }
  return created;
}

/**
 * Sequences party matching before quote preparation so an available V2 bind is never raced by a public-rate quote.
 * Live admission only: a backfill re-extraction (no admission snapshot) of days-old mail must not fill the one HMS browser.
 */
export function scheduleQuotePreparationForExtraction(
  run: Pick<AiWorkflowRun, 'runKind' | 'transportId' | 'triggerMessageId' | 'admissionSnapshotId'>,
): void {
  if (!run.admissionSnapshotId) return;
  const extraction = { ...run, runKind: 'inbound_extraction' as const };
  void (async () => {
    const db = getDb();
    const env = parseEnv(process.env as Record<string, string | undefined>);
    await prefetchPartyForExtraction(extraction, db, env).catch(() => 0);
    await prefetchQuoteReadyForExtraction(extraction, db, process.env);
  })().catch(() => undefined);
}

/** A terminal V2 party result unblocks its waiting public-or-contract quote preparation. */
export function scheduleQuotePreparationAfterPartyMatch(
  run: Pick<AiWorkflowRun, 'transportId' | 'triggerMessageId'>,
): void {
  void prefetchQuoteReadyForExtraction(
    { runKind: 'inbound_extraction', transportId: run.transportId, triggerMessageId: run.triggerMessageId },
  ).catch(() => undefined);
}

type PartyMatchV2JobResult = PanePartyFindResult & {
  matchVersion: 2;
  matcher?: 'v3';
  matchStatus: 'bound' | 'needs_pick';
  boundParty: PartyMatchRow | null;
  suggestions: PartyMatchRow[];
  reason: string;
  searchesTried: Array<{
    term: string;
    candidateName: string;
    kind: PanePartyKind;
    outcome: string;
    returned: number;
  }>;
  confidence: 'high' | 'medium' | 'low';
  pickSource: 'llm' | 'fallback';
};

function partyMatchV2NoMatch(reason: string): PartyMatchV2JobResult {
  return {
    outcome: 'no_match',
    results: [],
    truncated: false,
    best: null,
    searchedFor: null,
    matchVersion: 2,
    matchStatus: 'needs_pick',
    boundParty: null,
    suggestions: [],
    reason,
    searchesTried: [],
    confidence: 'low',
    pickSource: 'fallback',
  };
}

/** Reads an already-recorded quote-workflow answer only; V2 does not invoke the quote extraction model a second time. */
async function existingQuoteWorkflowParty(
  db: DB,
  transportId: string,
  messageId: string,
): Promise<unknown> {
  const [run] = await db
    .select({ output: aiAgentRun.output })
    .from(aiAgentRun)
    .where(
      and(
        eq(aiAgentRun.transportId, transportId),
        eq(aiAgentRun.messageId, messageId),
        eq(aiAgentRun.agent, 'luna'),
        eq(aiAgentRun.promptVersion, QUOTE_WORKFLOW_PROMPT_VERSION),
        eq(aiAgentRun.source, 'luna'),
        // Cache-hit ledger rows store JSON null; read the original persisted Luna answer instead.
        sql`${aiAgentRun.output} <> 'null'::jsonb`,
        gt(aiAgentRun.retentionExpiresAt, new Date()),
      ),
    )
    .orderBy(desc(aiAgentRun.createdAt))
    .limit(1);
  return run?.output ?? null;
}

/** Executes a V2 plan as bounded, single-term reads through the normal party runner and HMS job lock. */
async function executePartyMatchV2(input: {
  run: AiWorkflowRun;
  db: DB;
  signal?: AbortSignal;
  deadlineAt: number;
  acquisition: ReturnType<typeof acquisitionWithin>;
}): Promise<PartyMatchV2JobResult | PanePartyFindResult> {
  const [source] = await input.db
    .select({
      payload: mailExtraction.payload,
      extractionStatus: mailExtraction.status,
      extractionKind: mailExtraction.kind,
      fromAddress: message.fromAddress,
      ownerHeaderValue: message.ownerHeaderValue,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      subject: message.subject,
      textBody: message.textBody,
      direction: message.direction,
      historyOnly: message.historyOnly,
      threadHistoryOnly: mailThread.historyOnly,
      spamAt: mailThread.spamAt,
    })
    .from(mailExtraction)
    .innerJoin(message, eq(message.id, mailExtraction.messageId))
    .innerJoin(mailThread, eq(mailThread.id, message.threadId))
    .where(
      and(
        eq(mailExtraction.messageId, input.run.triggerMessageId),
        eq(message.transportId, input.run.transportId),
        eq(mailExtraction.status, 'succeeded'),
      ),
    )
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
    .limit(1);
  if (
    !source ||
    source.extractionStatus !== 'succeeded' ||
    quotePrepareKindReason({
      kind: source.extractionKind,
      payload: source.payload,
      subject: source.subject,
    }) === 'not_quote' ||
    source.direction !== 'inbound' ||
    source.historyOnly ||
    source.threadHistoryOnly ||
    source.spamAt
  ) {
    return partyMatchV2NoMatch('The source email is no longer eligible for party prefetch.');
  }

  const mailboxOrigin = {
    fromAddress: source.fromAddress,
    ownerHeaderValue: source.ownerHeaderValue,
    toAddresses: source.toAddresses,
    ccAddresses: source.ccAddresses,
  };
  const origin = await guardCenturionHmsMailboxOrigin({
    transportId: input.run.transportId,
    threadId: input.run.threadId,
    messageId: input.run.triggerMessageId,
  });
  const davinciRead = isDaVinciTransport(input.run.transportId) || !origin.ok;
  if (davinciRead && !hmsDavinciReadsEnabled()) {
    return {
      ...partyMatchV2NoMatch('Da Vinci mailbox origin is not bound to Centurion HMS'),
      outcome: 'refused_origin_mismatch',
    };
  }
  const davinciTarget = davinciRead ? DAVINCI_HMS_READ_TARGET : null;

  const quoteLlmParty = await existingQuoteWorkflowParty(
    input.db,
    input.run.transportId,
    input.run.triggerMessageId,
  );
  const emailInput = {
    payload: source.payload,
    fromAddress: source.fromAddress,
    subject: source.subject,
    body: source.textBody,
    quoteLlmParty,
  };
  const historyTargetAllowed = isCenturionPartyHistoryTarget(
    davinciTarget,
    input.run.transportId,
  );
  const candidates = buildPartyMatchCandidates({
    ...emailInput,
    allowLearnedSenderHistory: historyTargetAllowed,
  });
  const context: PartyMatchEmailContext = partyMatchEmailContext(emailInput);
  const senderHost = source.fromAddress?.match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase().replace(/\.+$/, '');
  const learnedSender =
    partyHistoryBindEnabled(process.env) && historyTargetAllowed && senderHost
      ? lookupLearnedSenderHistory(senderHost)
      : null;
  const { partyMatchV3Enabled, runPartyMatchV3 } = await import('./party-match-v3.js');
  if (partyMatchV3Enabled(process.env)) {
    let adapter: ReturnType<typeof resolveAdapter>['adapter'] = null;
    try {
      const route = resolveAdapter(quoteWorkflowLlmEnabled(process.env), null);
      if (route.enabled) adapter = route.adapter;
    } catch {
      // Invalid/unavailable route settings are a closed-model case; exact-name fallback remains safe.
    }
    return runPartyMatchV3({
      adapter,
      candidates,
      context,
      emailText: `${source.subject ?? ''}\n${source.textBody ?? ''}`,
      senderHistory: learnedSender
        ? [{ kind: learnedSender.kind, nativeId: learnedSender.nativeId, name: learnedSender.name }]
        : undefined,
      findParty: async (searches) => {
        if (!searches.length) return [];
        return findPartyJob(
          searches.map((search) => ({ name: search.term, kind: search.kind })),
          {
            acquisition: input.acquisition,
            resultCap: PARTY_MATCH_V2_ROW_CAP,
            origin: mailboxOrigin,
            target: davinciTarget,
          },
        );
      },
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
  }
  const plan = planPartySearches(candidates).slice(0, PARTY_MATCH_V2_SEARCH_CAP);
  const searchesTried: PartyMatchV2JobResult['searchesTried'] = [];
  const rowsById = new Map<string, PartyMatchRow>();
  let truncated = false;
  let failure: PanePartyFindResult | null = null;

  const jobResults = plan.length
    ? await findPartyJob(
        plan.map((search) => ({ name: search.term, kind: search.kind })),
        {
          acquisition: input.acquisition,
          resultCap: PARTY_MATCH_V2_ROW_CAP,
          origin: mailboxOrigin,
          target: davinciTarget,
        },
      )
    : [];

  for (const [index, search] of plan.entries()) {
    const result = jobResults[index] ?? {
      outcome: 'execution_failure' as const,
      results: [],
      truncated: false,
      best: null,
      searchedFor: search.term,
    };
    searchesTried.push({
      term: search.term,
      candidateName: search.candidateName,
      kind: search.kind,
      outcome: result.outcome,
      returned: result.results.length,
    });
    truncated ||= result.truncated;
    for (const row of result.results) rowsById.set(`${row.kind}:${row.nativeId}`, row);
    if (!['resolved', 'ambiguous', 'no_match'].includes(result.outcome)) {
      failure = result;
      break;
    }
  }
  if (failure) {
    const partialRows = [...rowsById.values()];
    const failedRows = partialRows.slice(0, PARTY_MATCH_V2_ROW_CAP);
    const failureTruncated =
      truncated || failure.truncated || partialRows.length > PARTY_MATCH_V2_ROW_CAP;
    const partialDecision = applyPartyBindRule({
      candidates,
      rows: failedRows,
      pick: {
        pickNativeId: null,
        kind: null,
        confidence: 'low',
        reason: 'HMS could not complete every planned party search.',
        alternatives: [],
        source: 'fallback',
      },
      truncated: failureTruncated,
    });
    return {
      ...failure,
      results: failedRows,
      truncated: failureTruncated,
      best: null,
      searchedFor: searchesTried.at(-1)?.term ?? failure.searchedFor,
      matchVersion: 2,
      matchStatus: 'needs_pick',
      boundParty: null,
      suggestions: partialDecision.suggestions,
      reason: `HMS could not complete every planned party search (${failure.outcome}); choose a suggestion or use Find in HMS.`,
      searchesTried,
      confidence: 'low',
      pickSource: 'fallback',
    };
  }

  const unboundedRows = [...rowsById.values()];
  if (unboundedRows.length > PARTY_MATCH_V2_ROW_CAP) truncated = true;
  const rows = unboundedRows.slice(0, PARTY_MATCH_V2_ROW_CAP);
  let adapter: ReturnType<typeof resolveAdapter>['adapter'] = null;
  try {
    const route = resolveAdapter(quoteWorkflowLlmEnabled(process.env), null);
    if (route.enabled) adapter = route.adapter;
  } catch {
    // Invalid/unavailable route settings are a closed-model case; exact-name fallback remains safe.
  }
  const pick = await pickPartyMatch({
    adapter: rows.length ? adapter : null,
    candidates,
    rows,
    context,
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  const decision = applyPartyBindRule({ candidates, rows, pick, truncated });
  const outcome = decision.matchStatus === 'bound' ? 'resolved' : rows.length ? 'ambiguous' : 'no_match';
  return {
    outcome,
    results: rows,
    truncated,
    best: decision.boundParty,
    searchedFor: searchesTried.at(-1)?.term ?? null,
    matchVersion: 2,
    matchStatus: decision.matchStatus,
    boundParty: decision.boundParty,
    suggestions: decision.suggestions,
    reason: decision.reason,
    searchesTried,
    confidence: pick.confidence,
    pickSource: pick.source,
  };
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

const PREPARED_QUOTE_LOCK_WAIT_MS = 15 * 60_000;
const PREPARED_QUOTE_ATTACH_FAILED = 'staff quote attach failed';

/** Uncharged yields must not wipe the attach-retry token stored in lastError. */
function preparedQuoteYieldLastError(run: AiWorkflowRun, lastError: string): string {
  return run.lastError === PREPARED_QUOTE_ATTACH_FAILED ? PREPARED_QUOTE_ATTACH_FAILED : lastError;
}

async function retryOrFail(
  db: DB,
  run: AiWorkflowRun,
  mark: Mark,
  failureClass: AiFailureClass,
  lastError: string,
  maxAttempts = JOB_MAX_ATTEMPTS,
): Promise<'retry_wait' | 'dead_letter'> {
  const attempts = run.attempts + 1;
  if (attempts >= maxAttempts) {
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

const STAFF_QUOTE_TRANSIENT_CODES = new Set([
  'TRANSIENT_NETWORK',
  'EXECUTION_FAILURE',
  'AUTHENTICATED_SHELL_TIMEOUT',
  'staff_quote_native_unavailable',
  'staff_quote_native_capture_unavailable',
  'native_quote_capture_unavailable',
  'native_quote_read_unavailable',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'ETIMEDOUT',
  'TIMEOUT',
  'TARGET_CLOSED',
  '40001',
  '40P01',
]);

const STAFF_QUOTE_BUSINESS_CODES = new Set([
  'staff_quote_failed',
  'native_quote_no_matching_rate',
  'native_quote_business_evidence_unavailable',
  'native_quote_insufficient_inventory',
  'native_quote_restricted_nights',
  'native_quote_capture_scope_or_completeness_invalid',
  'native_quote_capture_oversized',
  'business_quote_policy_unavailable',
  'business_party_identity_unavailable',
  'business_party_lookup_unavailable',
  'business_selected_joint_inventory_unavailable',
  'business_selected_price_unavailable',
  'business_quote_source_expired',
  'staff_quote_party_unavailable',
  'staff_quote_party_invalid',
  'staff_quote_party_changed',
  'staff_quote_source_changed',
]);
const STAFF_QUOTE_PARTY_LOOKUP_UNAVAILABLE_MESSAGE =
  "Nava couldn't check the picked company or agency in HMS. Try again.";

function staffQuoteErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : staffQuoteFailureCode(error);
}

function staffQuoteTransientFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current && typeof current === 'object') {
      const record = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
      const code = record.code;
      const message = typeof record.message === 'string' ? record.message : '';
      if (
        record.name === 'TimeoutError' ||
        record.name === 'AbortError' ||
        /timeout|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|network|socket hang up/i.test(message) ||
        /Target\b.*\bclosed\b/i.test(message)
      ) {
        return true;
      }
      if (
        current instanceof TRPCError &&
        current.code === 'PRECONDITION_FAILED' &&
        message === STAFF_QUOTE_PARTY_LOOKUP_UNAVAILABLE_MESSAGE
      ) {
        return true;
      }
      if (typeof code === 'string' && STAFF_QUOTE_TRANSIENT_CODES.has(code)) return true;
      if (current instanceof TRPCError && current.code === 'INTERNAL_SERVER_ERROR') return true;
      // Refusal detail (tRPC wraps a plain { alternatives } cause in an Error) is not an unknown failure.
      if (
        depth > 0 &&
        current instanceof Error &&
        !('alternatives' in current) &&
        !(current instanceof TRPCError) &&
        !STAFF_QUOTE_BUSINESS_CODES.has(staffQuoteErrorCode(current))
      ) {
        return true;
      }
      current = record.cause ?? null;
    } else {
      current = null;
    }
  }
  return !(error instanceof TRPCError) && !STAFF_QUOTE_BUSINESS_CODES.has(staffQuoteErrorCode(error));
}

function staffQuoteAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') return false;
    const record = current as { name?: unknown; cause?: unknown };
    if (record.name === 'AbortError') return true;
    current = record.cause ?? null;
  }
  return false;
}

function staffQuoteLockBusy(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object') {
      const code = 'code' in current ? current.code : undefined;
      if (code === 'HMS_LOCK_BUSY') return true;
      current = 'cause' in current ? current.cause : null;
    } else {
      current = null;
    }
  }
  return false;
}

function preparedQuoteYielded(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object') {
      if ('code' in current && current.code === 'STAFF_QUOTE_ACTIVE') return true;
      current = 'cause' in current ? current.cause : null;
    } else {
      current = null;
    }
  }
  return false;
}

function staffQuoteUserFromMetrics(metrics: Record<string, unknown>): StaffQuoteRunIdentity['user'] | null {
  const user = objectRecord(metrics.staffQuoteUser);
  if (
    typeof user.id !== 'string' ||
    user.id !== metrics.userId ||
    !(user.name === null || typeof user.name === 'string') ||
    typeof user.email !== 'string'
  ) {
    return null;
  }
  return { id: user.id, name: user.name, email: user.email };
}

/**
 * How long a staff quote result is reused. A priced result lives 24 h from the HMS observation (`asOf`).
 * Other results (refusals, no rate) keep the 6-hour TTL.
 */
export function staffQuoteResultExpiry(result: Record<string, unknown>, now: Date): Date {
  if (result.status === 'ready') {
    const asOf = typeof result.asOf === 'string' ? Date.parse(result.asOf) : Number.NaN;
    const origin = Number.isFinite(asOf) ? asOf : now.getTime();
    return new Date(origin + PRICED_QUOTE_REUSE_MS);
  }
  const ttl = now.getTime() + STAFF_QUOTE_RESULT_TTL_MS;
  const fresh = typeof result.freshUntil === 'string' ? Date.parse(result.freshUntil) : Number.NaN;
  return new Date(Number.isFinite(fresh) ? Math.min(ttl, fresh) : ttl);
}

/** A priced result is reused for 24 h from `asOf`; one stored without `asOf` or `freshUntil` never is. */
export function staffQuoteResultReusable(result: unknown, now: Date): boolean {
  if (!result || typeof result !== 'object') return true;
  const stored = result as { status?: unknown; freshUntil?: unknown; asOf?: unknown };
  if (stored.status !== 'ready') return true;
  const asOf = typeof stored.asOf === 'string' ? Date.parse(stored.asOf) : Number.NaN;
  if (Number.isFinite(asOf)) return asOf <= now.getTime() && asOf + PRICED_QUOTE_REUSE_MS > now.getTime();
  const fresh = typeof stored.freshUntil === 'string' ? Date.parse(stored.freshUntil) : Number.NaN;
  return Number.isFinite(fresh) && fresh > now.getTime();
}

async function storeStaffQuoteResult(input: {
  db: DB;
  mark: Mark;
  result: Record<string, unknown>;
  outcome: string;
}): Promise<'succeeded' | 'retry_wait'> {
  const now = new Date();
  const marked = await markAiRunSucceeded(
    {
      ...input.mark,
      readResult: {
        ...input.result,
        kind: 'staff_quote',
        asOf: now.toISOString(),
      },
      readResultExpiresAt: staffQuoteResultExpiry(input.result, now),
      metrics: { hmsJob: true, kind: 'staff_quote', outcome: input.outcome },
    },
    input.db,
  );
  return marked ? 'succeeded' : 'retry_wait';
}

export function staffQuoteRefusal(error: unknown, request: StaffQuoteInput): {
  code: string;
  message: string;
  alternatives?: ReturnType<typeof staffQuoteRoomAlternatives>;
} {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'string' ? rawCode : staffQuoteFailureCode(error);
  const directMessage = error instanceof Error ? error.message : '';
  const businessTrpcError = error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR';
  const message = businessTrpcError
    ? directMessage
    : staffQuoteFailureMessage(error, {
        salesStrategy: request.salesStrategy,
        dinnerRequested: request.groups.some((group) => group.board === 'dinner_bb'),
      });
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const detail = error && typeof error === 'object' && 'detail' in error ? error.detail : undefined;
  const fromCause = cause && typeof cause === 'object' && 'alternatives' in cause
    ? (cause as { alternatives?: unknown }).alternatives
    : undefined;
  const fromDetail = detail && typeof detail === 'object' && 'alternatives' in detail
    ? (detail as { alternatives?: unknown }).alternatives
    : undefined;
  const alternatives = staffQuoteRoomAlternatives(fromCause ?? fromDetail);
  return {
    code,
    message: message || 'The requested quote could not be qualified; review the stay inputs and try again.',
    ...(alternatives.length ? { alternatives } : {}),
  };
}

type SenderPartyObservation = Omit<RecordSenderPartyInput, 'host'>;

function senderPartyObservation(
  kind: 'company' | 'agency',
  value: unknown,
): SenderPartyObservation | null {
  const row = objectRecord(value);
  if (typeof row.name !== 'string' || typeof row.nativeId !== 'string') return null;
  const name = row.name.trim();
  const nativeId = row.nativeId.trim();
  if (!name || !nativeId) return null;
  return {
    kind,
    name,
    nativeId,
    iata: typeof row.iata === 'string' ? row.iata : null,
  };
}

/** Pick a single party only when sender-host evidence separates company from agency. */
export function selectSenderPartyForHost(
  host: string,
  parties: readonly SenderPartyObservation[],
): SenderPartyObservation | null {
  const agency = parties.find((party) => party.kind === 'agency');
  const company = parties.find((party) => party.kind === 'company');
  if (!agency || !company) return agency ?? company ?? null;

  const hostLabel = (host.trim().toLowerCase().replace(/\.+$/, '').split('.')[0] ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
  if (!hostLabel) return null;

  const matchesHost = (name: string) =>
    distinctivePartyTokens(name).some((token) => hostLabel.includes(token));
  const agencyMatches = matchesHost(agency.name);
  const companyMatches = matchesHost(company.name);
  if (agencyMatches === companyMatches) return null;
  return agencyMatches ? agency : company;
}

function senderPartiesFromFindResult(result: unknown): SenderPartyObservation[] {
  const commercial = objectRecord(objectRecord(result).commercial);
  return [
    senderPartyObservation('agency', commercial.agency),
    senderPartyObservation('company', commercial.company),
  ].filter((party): party is SenderPartyObservation => party !== null);
}

function senderHostFromAddress(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return address
    .slice(at + 1)
    .trim()
    .match(/^[a-z0-9.-]+/i)?.[0]
    ?.toLowerCase()
    .replace(/\.+$/, '') ?? null;
}

export function isCenturionPartyHistoryTarget(
  target: HmsReadTarget | null,
  transportId: string,
): boolean {
  return (
    !isDaVinciTransport(transportId) &&
    (!target || target.propertyCode === CENTURION_HMS_READ_TARGET.propertyCode)
  );
}

export function staffQuoteCanTeachSenderHistory(
  hasStaffUser: boolean,
  systemPreparedQuote: boolean,
): boolean {
  return hasStaffUser && !systemPreparedQuote;
}

type SenderHistorySourceMessage = {
  direction: string;
  fromAddress: string | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
};

function directExternalSenderHost(row: SenderHistorySourceMessage): string | null {
  if (
    row.direction !== 'inbound' ||
    classifyMailSource({
      fromAddress: row.fromAddress,
      subject: row.subject,
      bodyText: row.textBody ?? row.htmlBody,
    }).kind !== 'direct'
  ) {
    return null;
  }
  const host = row.fromAddress ? senderHostFromAddress(row.fromAddress) : null;
  return host && !isOwnedHotelHost(host) ? host : null;
}

export function senderHostForPartyHistory(input: {
  trigger: SenderHistorySourceMessage | null;
  inbound: SenderHistorySourceMessage[];
}): string | null {
  if (input.trigger?.direction === 'inbound') {
    return directExternalSenderHost(input.trigger);
  }
  for (const row of input.inbound) {
    const host = directExternalSenderHost(row);
    if (host) return host;
  }
  return null;
}

async function firstDirectInboundSenderHost(
  db: DB,
  run: AiWorkflowRun,
): Promise<string | null> {
  if (!run.threadId) return null;
  const sourceColumns = {
    direction: message.direction,
    fromAddress: message.fromAddress,
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody,
  };
  const [trigger] = await db
    .select(sourceColumns)
    .from(message)
    .where(
      and(
        eq(message.id, run.triggerMessageId),
        eq(message.transportId, run.transportId),
        eq(message.threadId, run.threadId),
      ),
    )
    .limit(1);
  if (trigger?.direction === 'inbound') {
    return senderHostForPartyHistory({ trigger, inbound: [] });
  }
  const inbound = await db
    .select(sourceColumns)
    .from(message)
    .where(
      and(
        eq(message.transportId, run.transportId),
        eq(message.threadId, run.threadId),
        eq(message.direction, 'inbound'),
      ),
    )
    .orderBy(asc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`));
  return senderHostForPartyHistory({ trigger: trigger ?? null, inbound });
}

async function recordSenderHistoryAfterRead(
  db: DB,
  run: AiWorkflowRun,
  parties: readonly SenderPartyObservation[],
  target: HmsReadTarget | null,
): Promise<void> {
  if (
    !parties.length ||
    !partyHistoryBindEnabled(process.env) ||
    !isCenturionPartyHistoryTarget(target, run.transportId)
  ) return;
  try {
    const host = await firstDirectInboundSenderHost(db, run);
    if (!host) return;
    const party = selectSenderPartyForHost(host, parties);
    if (!party) return;
    await recordSenderParty(db, { host, ...party });
  } catch {
    console.warn('party_sender_map_write_failed', { count: 1 });
  }
}

/**
 * Runs one claimed job. Called from executeAiRun after markAiRunRunning, so
 * the fence is already live. Returns the state the run should end in.
 */
export async function executeHmsJob(input: {
  run: AiWorkflowRun;
  fence: AiRunFence;
  signal?: AbortSignal;
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
  // Worker-time origin recheck: jobs queued before the enqueue guard, or whose
  // thread became mixed-origin after enqueue, must not reach Centurion HMS.
  // Party V2 keeps its own refusal result shape below.
  const partyV2 = request.kind === 'party' && request.matchVersion === 2;
  let davinciReadTarget: HmsReadTarget | null = null;
  if (!partyV2 && run.threadId) {
    if (request.kind === 'find' || request.kind === 'search_guest' || request.kind === 'party') {
      const resolved = await resolveHmsReadJobTarget({
        transportId: run.transportId,
        threadId: run.threadId,
        messageId: run.triggerMessageId,
      });
      if (!resolved.ok) {
        await markAiRunPolicyRefused({ ...mark, lastError: 'davinci_origin_refused' }, db);
        return 'dead_letter';
      }
      davinciReadTarget = hmsReadTargetJobMetrics(resolved.target)?.hmsReadTarget ?? null;
    } else {
      const origin = await guardCenturionHmsMailboxOrigin({
        transportId: run.transportId,
        threadId: run.threadId,
        messageId: run.triggerMessageId,
      });
      if (!origin.ok) {
        await markAiRunPolicyRefused({ ...mark, lastError: 'davinci_origin_refused' }, db);
        return 'dead_letter';
      }
    }
  }
  const metrics = objectRecord(run.metrics) as {
    userId?: string | null;
    owner?: string;
    staffQuoteUser?: unknown;
    quotePrepared?: boolean;
  };
  const systemPreparedQuote =
    request.kind === 'staff_quote' &&
    isSystemPreparedPriority(run.priority) &&
    metrics.userId == null &&
    metrics.quotePrepared === true;
  if (systemPreparedQuote && !quotePreparationEnabled()) {
    await markAiRunPolicyRefused({ ...mark, lastError: 'quote_preparation_disabled' }, db);
    return 'dead_letter';
  }
  if (
    systemPreparedQuote &&
    run.attempts > 0 &&
    !(run.attempts === 1 && run.lastError === PREPARED_QUOTE_ATTACH_FAILED)
  ) {
    await markAiRunDeadLetter(
      { ...mark, lastError: 'prepared_quote_attempt_exhausted', failureClass: 'TRANSIENT_NETWORK' },
      db,
    );
    return 'dead_letter';
  }
  const background = run.priority < HMS_JOB_PRIORITY_USER;
  if (background && (await staffQuoteInFlight(db))) {
    // Yield without counting an attempt, so a quote in flight does not use up the job's retries.
    return requeueRun(db, mark, {
      attempts: run.attempts,
      delayMs: JOB_YIELD_MS,
      failureClass: 'STAFF_QUOTE_ACTIVE',
      lastError: preparedQuoteYieldLastError(run, 'staff quote in flight'),
    });
  }

  if (request.kind === 'staff_quote') {
    const user = staffQuoteUserFromMetrics(metrics);
    const systemPrepared = !user && systemPreparedQuote;
    if (!user && !systemPrepared) {
      await markAiRunDeadLetter(
        { ...mark, lastError: 'staff_quote_identity_unavailable', failureClass: 'SCHEMA_DRIFT' },
        db,
      );
      return 'dead_letter';
    }
    try {
      await recordedToolRun(
        {
          kind: 'quote',
          transportId: run.transportId,
          messageId: request.input.messageId,
          userId: user?.id ?? null,
          input: ledgerQuoteInput(request.input),
          inputDigest: quoteDigest(request.input),
        },
        () =>
          runStaffQuote(
            request.input,
            { transportId: run.transportId, ...(user ? { user } : {}) },
            db,
            {
              signal: input.signal,
              deadlineAt: fence.deadlineAt.getTime(),
              ...(systemPrepared ? { preparedRunId: run.id } : {}),
              commitQueuedResult: async (quoteResult, transaction) =>
                (await storeStaffQuoteResult({
                  db: transaction,
                  mark,
                  result: quoteResult,
                  outcome: 'ready',
                })) === 'succeeded',
            },
          ),
        classifyStaffQuote,
        undefined,
        { recorder: createToolRunRecorder(db, { enabled: true }) ?? undefined },
      );
      if (staffQuoteCanTeachSenderHistory(Boolean(user), systemPreparedQuote)) {
        const selectedParties: SenderPartyObservation[] = [];
        if (request.input.parties?.agency) {
          selectedParties.push({
            kind: 'agency',
            name: request.input.parties.agency.name,
            nativeId: request.input.parties.agency.nativeId,
            iata: null,
          });
        }
        if (request.input.parties?.company) {
          selectedParties.push({
            kind: 'company',
            name: request.input.parties.company.name,
            nativeId: request.input.parties.company.nativeId,
            iata: null,
          });
        }
        await recordSenderHistoryAfterRead(db, run, selectedParties, null);
      }
      return 'succeeded';
    } catch (error) {
      if (systemPreparedQuote && preparedQuoteYielded(error)) {
        await markAiRunDeadLetter(
          {
            ...mark,
            lastError: 'prepared_quote_yielded_to_staff_quote',
            failureClass: 'STAFF_QUOTE_ACTIVE',
          },
          db,
        );
        return 'dead_letter';
      }
      if (
        input.signal?.aborted &&
        input.signal.reason &&
        typeof input.signal.reason === 'object' &&
        'name' in input.signal.reason &&
        input.signal.reason.name === 'AbortError' &&
        staffQuoteAbortError(error)
      ) {
        return requeueRun(db, mark, {
          attempts: run.attempts,
          delayMs: 0,
          failureClass: 'WORKER_SHUTDOWN',
          lastError: preparedQuoteYieldLastError(run, 'worker shutdown'),
        });
      }
      if (isPropertyReadLockDeadline(error)) {
        // A prepared quote waits out a busy lock for a while, then gives up so staff never stay pinned to it.
        if (systemPreparedQuote && Date.now() - run.createdAt.getTime() >= PREPARED_QUOTE_LOCK_WAIT_MS) {
          await markAiRunDeadLetter(
            { ...mark, lastError: 'prepared_quote_lock_busy', failureClass: 'HMS_LOCK_BUSY' },
            db,
          );
          return 'dead_letter';
        }
        if (systemPreparedQuote) {
          return requeueRun(db, mark, {
            attempts: run.attempts,
            delayMs: JOB_YIELD_MS,
            failureClass: 'HMS_LOCK_BUSY',
            lastError: preparedQuoteYieldLastError(run, 'property lock busy'),
          });
        }
        return retryOrFail(db, run, mark, 'HMS_LOCK_BUSY', 'property lock busy');
      }
      if (staffQuoteLockBusy(error)) {
        return retryOrFail(
          db,
          run,
          mark,
          'HMS_LOCK_BUSY',
          'party verification lock busy',
          systemPreparedQuote ? 1 : JOB_MAX_ATTEMPTS,
        );
      }
      if (staffQuoteTransientFailure(error)) {
        const attachFailed = staffQuoteFailurePhase(error) === 'attach';
        return retryOrFail(
          db,
          run,
          mark,
          'TRANSIENT_NETWORK',
          attachFailed ? PREPARED_QUOTE_ATTACH_FAILED : 'staff quote execution failed',
          systemPreparedQuote ? (attachFailed ? 2 : 1) : JOB_MAX_ATTEMPTS,
        );
      }
      const refusal = staffQuoteRefusal(error, request.input);
      return storeStaffQuoteResult({
        db,
        mark,
        result: { ok: false, ...refusal },
        outcome: 'refused',
      });
    }
  }
  const ownerKey = metrics.owner ?? `hms-job-prefetch:${run.transportId}`;
  const screenshotDir: { value: string | null } = { value: null };
  const deps = {
    lock: () =>
      paneStayLookupLoaders.lock ?? paneStayPropertyLock(davinciReadTarget?.propertyCode),
    acquisition: background ? { tryOnce: true } : acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    onRun: ({ runId, dir }: { runId: string; dir: string }) => {
      screenshotDir.value = dir;
      registerPaneRun({ runId, dir, owner: ownerKey, now: Date.now() });
    },
    target: davinciReadTarget,
  };
  const audit = {
    transportId: run.transportId,
    messageId: null,
    userId: metrics.userId ?? null,
    inputDigest: toolInputDigest(request as Record<string, unknown>),
  };
  const result = await (request.kind === 'availability'
    ? probeAvailability(request, { lock: deps.lock, acquisition: deps.acquisition })
    : request.kind === 'find'
      ? recordedToolRun(
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
      : request.kind === 'party' &&
          background &&
          request.matchVersion === 2 &&
          partyMatchV2Enabled()
        ? executePartyMatchV2({
            run,
            db,
            signal: input.signal,
            deadlineAt: fence.deadlineAt.getTime(),
            acquisition: deps.acquisition,
          })
        : request.kind === 'party'
        ? findParty(
            { name: request.name, ...(request.partyKind ? { kind: request.partyKind } : {}) },
            { acquisition: deps.acquisition, target: davinciReadTarget },
          )
        : recordedToolRun(
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
          ));

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
    if (outcome === 'refused_input_invalid') {
      await markAiRunDeadLetter(
        { ...mark, lastError: outcome, failureClass: 'SCHEMA_DRIFT' },
        db,
      );
      return 'dead_letter';
    }
    await markAiRunPolicyRefused({ ...mark, lastError: outcome }, db);
    return 'dead_letter';
  }

  // Found, not found, ambiguous, or a completed guest search. Stored as a dated snapshot.
  const marked = await markAiRunSucceeded(
    {
      ...mark,
      readResult: { ...result, kind: request.kind, asOf: new Date().toISOString() },
      metrics: {
        hmsJob: true,
        kind: request.kind,
        outcome,
        screenshotDir: screenshotDir.value,
        ...(davinciReadTarget ? { hmsReadTarget: davinciReadTarget } : {}),
      },
    },
    db,
  );
  if (marked && request.kind === 'find') {
    await recordSenderHistoryAfterRead(
      db,
      run,
      senderPartiesFromFindResult(result),
      davinciReadTarget,
    );
  }
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

const PARTY_JOB_OUTCOMES = new Set([
  'resolved',
  'ambiguous',
  'no_match',
  'input_gap',
  'execution_failure',
  'external_system_unavailable',
  'refused_flag_off',
  'refused_input_invalid',
  'refused_origin_mismatch',
  'refused_lock_unavailable',
  'refused_lock_busy',
]);

function safePartyJobOutcome(
  run: AiWorkflowRun,
  request: HmsJobRequest | null,
  result: Record<string, unknown> | null,
): string | null {
  if (request?.kind !== 'party') return null;
  const resultOutcome = result?.outcome;
  if (typeof resultOutcome === 'string' && PARTY_JOB_OUTCOMES.has(resultOutcome))
    return resultOutcome;
  if (run.lastError && PARTY_JOB_OUTCOMES.has(run.lastError)) return run.lastError;
  if (run.failureClass === 'HMS_LOCK_BUSY') return 'refused_lock_busy';
  if (run.failureClass === 'TRANSIENT_NETWORK') return 'execution_failure';
  return null;
}

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
          and(eq(aiWorkflowRun.priority, run.priority), lt(aiWorkflowRun.createdAt, run.createdAt)),
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
    sourceMessageId: run.triggerMessageId,
    request: request.success ? request.data : null,
    prefetch: isSystemPreparedPriority(run.priority),
    status,
    position:
      status === 'queued' && options.includePosition !== false
        ? await queuePosition(db, run)
        : null,
    attempts: run.attempts,
    failureClass: run.failureClass,
    asOf: typeof result?.asOf === 'string' ? result.asOf : null,
    createdAt: run.createdAt.toISOString(),
    outcome: safePartyJobOutcome(run, request.success ? request.data : null, result),
    result,
  };
}

/** The newest staff quote job on this message whose stay inputs match, ignoring the pane's selection counters. */
async function latestStaffQuoteRunFor(
  db: DB,
  scope: ReturnType<typeof and>,
  messageId: string,
  quoteInput: StaffQuoteInput,
  userId: string,
  includeDevEval = false,
): Promise<AiWorkflowRun[]> {
  const now = new Date();
  const ownerScope = quotePreparationEnabled()
    ? or(
        sql`${aiWorkflowRun.metrics}->>'userId' = ${userId}`,
        and(
          lte(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
          sql`${aiWorkflowRun.metrics}->>'userId' IS NULL`,
          sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
        ),
      )
    : sql`${aiWorkflowRun.metrics}->>'userId' = ${userId}`;
  const rows = await db
    .select()
    .from(aiWorkflowRun)
    .where(
      and(
        scope,
        ownerScope,
        eq(aiWorkflowRun.triggerMessageId, messageId),
        sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
        sql`${aiWorkflowRun.readRequest}->'input'->>'messageId' = ${messageId}`,
        // Every success counts when picking the newest: an expired price must not let an older refusal answer.
        or(eq(aiWorkflowRun.state, 'succeeded'), staffQuoteRunFreshness(now)),
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id));
  const reusable = (run: AiWorkflowRun) => {
    if (run.state !== 'succeeded') return true;
    if (!staffQuoteResultReusable(run.readResult, now)) return false;
    const stored = run.readResult as { status?: unknown } | null;
    if (stored?.status === 'ready') return true;
    return Boolean(run.readResultExpiresAt && run.readResultExpiresAt > now);
  };
  // User quotes are independent per stay. Match the newest run whose stay terms equal this request.
  for (const userRun of rows) {
    const userMetrics = objectRecord(userRun.metrics);
    if (userMetrics.userId !== userId || (userMetrics.devEval === true && !includeDevEval) || !reusable(userRun)) continue;
    const parsed = hmsJobRequestSchema.safeParse(userRun.readRequest);
    if (
      parsed.success &&
      parsed.data.kind === 'staff_quote' &&
      staffQuoteInputsPriceEquivalent(parsed.data.input, quoteInput)
    ) {
      return [userRun];
    }
  }

  // System-prepared quotes are independent per stay. Look for the newest prepared price for these terms rather than
  // letting a different stay's more recently enqueued job hide a valid match.
  for (const preparedRun of rows) {
    const metrics = objectRecord(preparedRun.metrics);
    if (
      !isSystemPreparedPriority(preparedRun.priority) ||
      metrics.userId != null ||
      metrics.quotePrepared !== true ||
      preparedRun.state === 'dead_letter' ||
      preparedRun.state === 'superseded'
    ) {
      continue;
    }
    const parsed = hmsJobRequestSchema.safeParse(preparedRun.readRequest);
    if (
      !parsed.success ||
      parsed.data.kind !== 'staff_quote' ||
      parsed.data.input.sourceHash !== quoteInput.sourceHash ||
      !staffQuoteInputsPriceEquivalent(parsed.data.input, quoteInput)
    ) {
      continue;
    }
    if (!preparedRun.threadId) return [];
    const [latestApproval] = await db
      .select({ createdAt: aiDraftGeneration.createdAt })
      .from(aiDraftGeneration)
      .where(
        and(
          eq(aiDraftGeneration.transportId, preparedRun.transportId),
          eq(aiDraftGeneration.threadId, preparedRun.threadId),
          eq(aiDraftGeneration.requestedByUserId, userId),
          eq(aiDraftGeneration.model, 'staff-approved-native'),
          sql`${aiDraftGeneration.contextMessageIds} @> ${JSON.stringify([messageId])}::jsonb`,
        ),
      )
      .orderBy(desc(aiDraftGeneration.createdAt))
      .limit(1);
    if (latestApproval && latestApproval.createdAt >= preparedRun.createdAt) return [];
    return reusable(preparedRun) ? [preparedRun] : [];
  }
  return [];
}

function staffQuoteRunFreshness(now: Date) {
  const asOfFloor = new Date(now.getTime() - PRICED_QUOTE_REUSE_MS).toISOString();
  return or(
    inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']),
    and(
      eq(aiWorkflowRun.state, 'succeeded'),
      or(
        gt(aiWorkflowRun.readResultExpiresAt, now),
        and(
          sql`${aiWorkflowRun.readResult}->>'status' = 'ready'`,
          sql`(${aiWorkflowRun.readResult}->>'asOf')::timestamptz > ${asOfFloor}::timestamptz`,
          sql`(${aiWorkflowRun.readResult}->>'asOf')::timestamptz <= ${now.toISOString()}::timestamptz`,
        ),
      ),
    ),
    and(
      inArray(aiWorkflowRun.state, ['dead_letter', 'superseded']),
      sql`coalesce(${aiWorkflowRun.finishedAt}, ${aiWorkflowRun.updatedAt}, ${aiWorkflowRun.createdAt}) > ${new Date(now.getTime() - STAFF_QUOTE_RESULT_TTL_MS).toISOString()}::timestamp`,
    ),
  );
}

/**
 * The job's status and snapshot from the database. By run id for polling, or
 * the latest matching request to resume after the pane remounts. Null when nothing matches.
 */
export async function readHmsJobView(
  input:
    | { transportId: string; runId: string; userId?: string; staffQuoteOwnerId?: string }
    | {
        transportId: string;
        userId: string;
        messageId: string;
        kind: 'staff_quote';
        input: StaffQuoteInput;
      }
    | {
        transportId: string;
        threadId: string;
        kind: 'find' | 'search_guest' | 'party' | 'availability';
        confirmation?: string;
        /** A guest search's surname, compared case- and space-insensitively: one thread can carry two guests' searches. */
        lastName?: string;
        /** A party search's name, compared case- and space-insensitively.
         * One thread can search multiple parties.
         */
        name?: string;
        /** Narrows a party search to the company or agency field that is resuming it. */
        partyKind?: PanePartyKind;
        /** A stay's dates pick its availability snapshot; its rooms tell apart two stays on the same dates. */
        arrival?: string;
        /** Null explicitly matches a guest-search request with no departure constraint. */
        departure?: string | null;
        rooms?: AvailabilityRequest['rooms'];
      },
  db: DB = getDb(),
): Promise<HmsJobView | null> {
  const staffQuoteByInput = 'kind' in input && input.kind === 'staff_quote';
  const staffQuoteByOwner = 'staffQuoteOwnerId' in input && Boolean(input.staffQuoteOwnerId);
  const scope = and(
    eq(aiWorkflowRun.transportId, input.transportId),
    eq(aiWorkflowRun.runKind, 'read_tool'),
    eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
    ...('userId' in input && input.userId && !staffQuoteByInput && !staffQuoteByOwner
      ? [sql`${aiWorkflowRun.metrics}->>'userId' = ${input.userId}`]
      : []),
  );
  const [run] =
    'runId' in input
      ? await db
          .select()
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.id, input.runId),
              scope,
              ...(input.staffQuoteOwnerId
                ? [
                    or(
                      sql`${aiWorkflowRun.readRequest}->>'kind' IS DISTINCT FROM 'staff_quote'`,
                      and(
                        sql`${aiWorkflowRun.readRequest}->>'kind' = 'staff_quote'`,
                        or(
                          sql`${aiWorkflowRun.metrics}->>'userId' = ${input.staffQuoteOwnerId}`,
                          ...(quotePreparationEnabled()
                            ? [
                                and(
                                  lte(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
                                  sql`${aiWorkflowRun.metrics}->>'userId' IS NULL`,
                                  sql`${aiWorkflowRun.metrics}->>'quotePrepared' = 'true'`,
                                ),
                              ]
                            : []),
                        ),
                        staffQuoteRunFreshness(new Date()),
                      ),
                    ),
                  ]
                : [sql`${aiWorkflowRun.readRequest}->>'kind' IS DISTINCT FROM 'staff_quote'`]),
            ),
          )
          .limit(1)
      : input.kind === 'staff_quote'
        ? await latestStaffQuoteRunFor(db, scope, input.messageId, input.input, input.userId)
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
              ...(input.kind === 'party'
                ? [gte(aiWorkflowRun.createdAt, new Date(Date.now() - PARTY_READBACK_FRESH_MS))]
                : []),
              ...(input.confirmation
                ? [sql`${aiWorkflowRun.readRequest}->>'confirmation' = ${input.confirmation}`]
                : []),
              ...(input.lastName
                ? [
                    sql`lower(btrim(regexp_replace(${aiWorkflowRun.readRequest}->>'lastName', '[[:space:]]+', ' ', 'g'))) = ${input.lastName.trim().replace(/\s+/g, ' ').toLowerCase()}`,
                  ]
                : []),
              ...(input.name
                ? [
                    sql`lower(
                      btrim(
                        regexp_replace(
                          ${aiWorkflowRun.readRequest}->>'name',
                          '[[:space:]]+',
                          ' ',
                          'g'
                        )
                      )
                    ) = ${input.name.trim().replace(/\s+/g, ' ').toLowerCase()}`,
                  ]
                : []),
              ...(input.partyKind
                ? [
                    or(
                      sql`${aiWorkflowRun.readRequest}->>'partyKind' = ${input.partyKind}`,
                      and(
                        lte(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
                        sql`${aiWorkflowRun.readRequest}->>'partyKind' IS NULL`,
                      ),
                    ),
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
                ? [
                    sql`${aiWorkflowRun.readRequest}->'rooms' = ${JSON.stringify(input.rooms)}::jsonb`,
                  ]
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
    const started = items.some(
      (item) =>
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
export async function readHmsBatchView(
  input: HmsBatchScope,
  db: DB = getDb(),
): Promise<HmsBatchView | null> {
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
          reason:
            metrics.batchItemReason === 'insufficient_data' ||
            metrics.batchItemReason === 'spam' ||
            metrics.batchItemReason === 'davinci_origin'
              ? metrics.batchItemReason
              : null,
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
export async function cancelHmsBatch(
  input: HmsBatchScope,
  db: DB = getDb(),
): Promise<HmsBatchView | null> {
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
      const hasOtherBatchConsumers = batchLinks.some(
        (value) => objectRecord(value).status === 'reused',
      );
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

/** Postgres deadlock_detected (40P01) or serialization_failure (40001), also when drizzle wraps the driver error. */
function isLockConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (code === '40P01' || code === '40001') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const RESTART_SWEEP_ATTEMPTS = 4;
const RESTART_SWEEP_BACKOFF_MS = 100;

/**
 * Runs at worker start. Read runs that a dead hms worker still held go back to
 * retry_wait now, not after the stale-claim timeout. A claim with a fresh
 * heartbeat belongs to a live worker and is left alone. A lock conflict rolls
 * back and retries with backoff. If every attempt conflicts, it rethrows, and
 * createHmsRecoveryGate keeps HMS reads unclaimed until a later sweep succeeds.
 */
export async function requeueHmsReadsAfterRestart(
  input: { ownerId: string },
  db: DB = getDb(),
): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await requeueStaleHmsReads(input, db);
    } catch (error) {
      if (!isLockConflict(error) || attempt >= RESTART_SWEEP_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, RESTART_SWEEP_BACKOFF_MS * 2 ** (attempt - 1)),
      );
    }
  }
}

async function requeueStaleHmsReads(input: { ownerId: string }, db: DB): Promise<number> {
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
      .orderBy(aiWorkflowRun.id)
      // Plain FOR UPDATE, not SKIP LOCKED: this sweep runs once at startup, so a skipped row keeps its dead worker's
      // deadline and can fail with RUN_DEADLINE. Waiting in id order matches the batch paths' lock order.
      .for('update');

    for (const run of staleRuns) {
      const metrics = objectRecord(run.metrics);
      const previousCrashes = Number(metrics.crashCount);
      const crashCount =
        (Number.isInteger(previousCrashes) && previousCrashes >= 0 ? previousCrashes : 0) + 1;
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

export type HmsRecoveryGate = { mayClaim(): Promise<boolean> };

const HMS_RECOVERY_RETRY_MIN_MS = 1_000;
const HMS_RECOVERY_RETRY_MAX_MS = 30_000;

/**
 * Keeps HMS read claims closed until a restart sweep succeeds. Without it, a stale job whose deadline has passed is
 * claimed and dead-lettered as RUN_DEADLINE. A failed sweep keeps the gate closed and retries on a later tick, with
 * exponential backoff. The worker stays up meanwhile.
 */
export function createHmsRecoveryGate(
  input: { ownerId: string },
  deps: { sweep?: (sweepInput: { ownerId: string }) => Promise<number>; now?: () => number } = {},
): HmsRecoveryGate {
  const sweep =
    deps.sweep ?? ((sweepInput: { ownerId: string }) => requeueHmsReadsAfterRestart(sweepInput));
  const now = deps.now ?? Date.now;
  let pending = true;
  let nextAttemptAt = 0;
  let backoffMs = HMS_RECOVERY_RETRY_MIN_MS;
  return {
    async mayClaim() {
      if (!pending) return true;
      const at = now();
      if (at < nextAttemptAt) return false;
      try {
        const requeued = await sweep(input);
        pending = false;
        if (requeued > 0) console.log(JSON.stringify({ ok: true, hmsReadsRequeued: requeued }));
        return true;
      } catch (error) {
        console.warn('hms_recovery_pending', {
          retryInMs: backoffMs,
          message: error instanceof Error ? error.message : String(error),
        });
        nextAttemptAt = at + backoffMs;
        backoffMs = Math.min(backoffMs * 2, HMS_RECOVERY_RETRY_MAX_MS);
        return false;
      }
    },
  };
}

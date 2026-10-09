/**
 * Pane HMS lookups as persisted jobs.
 *
 * A job is a read_tool run on the hms lane with promptVersion hms-job/1. The
 * pane enqueues it, polls by run id, and reads the dated snapshot from the
 * database, so a lookup keeps running while the pane is unmounted.
 *
 * User jobs (priority 10) take the property lock and wait for it. Prefetch
 * jobs (priority 0) try the lock once, yield to a staff quote in flight, and
 * requeue on contention.
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { and, desc, eq, gt, inArray, like, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { parseEnv } from '../env.js';
import { staffQuoteInFlight } from '../hms/property-queue-state.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
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

async function latestWorkItemId(db: DB, transportId: string, threadId: string): Promise<string | null> {
  const [item] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(and(eq(workItem.transportId, transportId), eq(workItem.threadId, threadId)))
    .orderBy(desc(workItem.updatedAt))
    .limit(1);
  return item?.id ?? null;
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

export async function enqueueHmsJob(
  input: {
    transportId: string;
    threadId: string;
    triggerMessageId: string;
    workItemId: string | null;
    userId: string | null;
    request: HmsJobRequest;
    priority: number;
    idempotencyKey: string;
  },
  db: DB = getDb(),
): Promise<{ run: AiWorkflowRun; created: boolean }> {
  const now = new Date();
  const [inserted] = await db
    .insert(aiWorkflowRun)
    .values({
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
      nextRunAt: now,
      metrics: {
        hmsJob: true,
        prefetch: input.priority === HMS_JOB_PRIORITY_PREFETCH,
        userId: input.userId,
        owner: input.userId ? `${input.userId}:${input.transportId}` : null,
      },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: aiWorkflowRun.idempotencyKey })
    .returning();
  if (inserted) return { run: inserted, created: true };
  const [existing] = await db
    .select()
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!existing) throw new Error(`failed to enqueue or load HMS job for ${input.idempotencyKey}`);
  return { run: existing, created: false };
}

/** A pane lookup from the signed-in user. Null when the thread has no inbound mail to anchor the run to. */
export async function queueUserHmsJob(
  input: { transportId: string; userId: string; threadId: string; request: HmsJobRequest },
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
      idempotencyKey: `hms-job:user:${randomUUID()}`,
    },
    db,
  );
  return run;
}

async function countRecentPrefetches(db: DB, transportId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, transportId),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.priority, HMS_JOB_PRIORITY_PREFETCH),
        gt(aiWorkflowRun.createdAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Prefetch after a live inbound triage succeeds. Validated confirmation
 * numbers become low-priority jobs, capped per transport per hour. Backfill
 * and sent-copy triage never prefetch. Returns how many jobs were created.
 */
export async function prefetchHmsConfirmations(
  run: AiWorkflowRun,
  db: DB = getDb(),
  env = parseEnv(process.env as Record<string, string | undefined>),
): Promise<number> {
  if (!env.HMS_PREFETCH_ENABLED) return 0;
  // Live admission stamps an admission snapshot; backfill and imports do not.
  if (
    run.runKind !== 'inbound_triage' ||
    !run.admissionSnapshotId ||
    !run.idempotencyKey.startsWith('inbound-triage:')
  ) {
    return 0;
  }
  const [mail] = await db
    .select({ subject: message.subject, textBody: message.textBody })
    .from(message)
    .where(eq(message.id, run.triggerMessageId))
    .limit(1);
  if (!mail) return 0;
  const numbers = extractHmsConfirmations(`${mail.subject ?? ''}\n${mail.textBody ?? ''}`);
  if (numbers.length === 0) return 0;
  const workItemId = await latestWorkItemId(db, run.transportId, run.threadId);
  let created = 0;
  for (const confirmation of numbers) {
    const used = await countRecentPrefetches(
      db,
      run.transportId,
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
        // Same number again is a no-op, whichever mail carried it.
        idempotencyKey: `hms-job:prefetch:${run.transportId}:${confirmation}`,
      },
      db,
    );
    if (result.created) created += 1;
  }
  return created;
}

/** Fire-and-forget from the worker after a triage commit. Off unless HMS_PREFETCH_ENABLED=1. */
export function schedulePrefetchForInbound(run: AiWorkflowRun): void {
  void prefetchHmsConfirmations(run).catch(() => undefined);
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
    request.kind === 'find'
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

async function toView(db: DB, run: AiWorkflowRun): Promise<HmsJobView> {
  const request = hmsJobRequestSchema.safeParse(run.readRequest);
  const status = STATUS_BY_STATE[run.state];
  const result = run.state === 'succeeded' && run.readResult ? run.readResult : null;
  return {
    runId: run.id,
    request: request.success ? request.data : null,
    prefetch: run.priority === HMS_JOB_PRIORITY_PREFETCH,
    status,
    position: status === 'queued' ? await queuePosition(db, run) : null,
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
        kind: 'find' | 'search_guest';
        confirmation?: string;
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
              eq(aiWorkflowRun.threadId, input.threadId),
              scope,
              sql`${aiWorkflowRun.readRequest}->>'kind' = ${input.kind}`,
              ...(input.confirmation
                ? [sql`${aiWorkflowRun.readRequest}->>'confirmation' = ${input.confirmation}`]
                : []),
            ),
          )
          .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
          .limit(1);
  return run ? toView(db, run) : null;
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

/**
 * Runs at worker start. Read runs this lane's previous process still held go
 * back to retry_wait now, not after the stale-claim timeout. Other processes'
 * claims are left alone.
 */
export async function requeueHmsReadsAfterRestart(
  input: { ownerId: string },
  db: DB = getDb(),
): Promise<number> {
  const now = new Date();
  const rows = await db
    .update(aiWorkflowRun)
    .set({
      state: 'retry_wait',
      claimOwner: null,
      claimToken: null,
      nextRunAt: now,
      lastError: 'hms worker restarted',
      failureClass: 'LEASE_LOST',
      updatedAt: now,
    })
    .where(
      and(
        eq(aiWorkflowRun.executorLane, 'hms'),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        inArray(aiWorkflowRun.state, ['claimed', 'running']),
        like(aiWorkflowRun.claimOwner, 'hms-ai-worker-%'),
        ne(aiWorkflowRun.claimOwner, input.ownerId),
      ),
    )
    .returning({ id: aiWorkflowRun.id });
  return rows.length;
}

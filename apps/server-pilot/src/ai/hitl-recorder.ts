import {
  aiAgentRun,
  AGENT_RUN_CACHE_STATUSES,
  AGENT_RUN_SOURCES,
  AGENT_RUN_TRIGGERS,
  hitlEpisode,
} from '../db/schema/hitl.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isHitlLedgerEnabled, type EnvInput } from '../env.js';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';

/**
 * HITL decision ledger, recording side. Server only. With HITL_LEDGER off nothing
 * here touches the database: resolveAgentRunRecorder returns null before any DB
 * access. Recording is best effort and never fails the analyse it observes.
 */

/** Ledger rows expire after this window; the purge job deletes anything past it. */
export const HITL_RETENTION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** Longest an analyse waits on the ledger before it returns without analysisRunId. */
export const AGENT_RUN_RECORD_CAP_MS = 300;
/**
 * Per-statement limits for ledger writes. A write that waits on a locked row aborts within these and frees its
 * pooled connection. A write abandoned at the cap above therefore cannot hold a connection for long.
 */
export const LEDGER_LOCK_TIMEOUT_MS = 250;
export const LEDGER_STATEMENT_TIMEOUT_MS = 250;
/**
 * Cache entries written before their run was recorded name no producing run. For those, the origin is the
 * latest model run for the input recorded no later than the cache write plus one record cap.
 */
export const CACHE_ORIGIN_SKEW_MS = AGENT_RUN_RECORD_CAP_MS;

export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];
export type AgentRunCacheStatus = (typeof AGENT_RUN_CACHE_STATUSES)[number];
export type AgentRunSource = (typeof AGENT_RUN_SOURCES)[number];

/** Facts one analyse produced. Field values are stored, never logged. */
export type AgentRunDraft = {
  trigger: AgentRunTrigger;
  cacheStatus: AgentRunCacheStatus;
  transportId: string;
  threadId: string;
  messageId: string;
  /** Session user for pane runs. Null for warmer runs, which open no episode. */
  userId: string | null;
  inputHash: string;
  inputKey: string;
  promptVersion: string;
  treatAs: string | null;
  staffNotePresent: boolean;
  source: AgentRunSource;
  fallbackReason: string | null;
  workflow: string | null;
  provider: string | null;
  modelId: string | null;
  modelRoute: string | null;
  latencyMs: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    usageSource: string | null;
  } | null;
  /** The model output as parsed (JSON). Null on cache hits and fallbacks. */
  output: unknown;
  /** The mapped suggestion the pane pre-fills. */
  suggestedFields: unknown;
  /**
   * Cache hits only. The run that produced the cached answer, as the cache entry names it. Null when the
   * entry names none (written before recording succeeded).
   */
  producingRunId?: string | null;
  /** Cache hits only. When the cache entry was written. Bounds the origin lookup for entries that name no run. */
  cacheWrittenAt?: Date | null;
};

export type AgentRunRecord = AgentRunDraft & { cachedFromRunId: string | null };

/** What a cache hit links to. Read from the cache entry, never from the newest run for the input. */
export type OriginLookup = {
  inputKey: string;
  producingRunId: string | null;
  cacheWrittenAt: Date | null;
};

/** Recorder seam. Tests inject an in-memory sink; production uses createAgentRunRecorder. */
export type AgentRunRecorder = {
  /**
   * The run a cache hit links to. The producing run wins when it is still a model run for this input. Otherwise
   * it is the latest model run for the input recorded no later than the cache write (see CACHE_ORIGIN_SKEW_MS).
   */
  findOriginRunId(lookup: OriginLookup): Promise<string | null>;
  /** Persists one run and resolves to its id. Rejects on failure; callers cap and swallow. */
  record(run: AgentRunRecord): Promise<string>;
};

/**
 * Cache identity for one analyse. Same transport, message, selection text, staff note,
 * prompt and treat-as means the same key, so a cache hit can find its origin run.
 */
export function analyseInputKey(input: {
  transportId: string;
  messageId: string;
  sourceHash: string;
  promptVersion: string;
  treatAs: string | null;
}): string {
  return createHash('sha256')
    .update(
      [
        'hitl-input/1',
        input.transportId,
        input.messageId,
        input.sourceHash,
        input.promptVersion,
        input.treatAs ?? 'auto',
      ].join('\0'),
    )
    .digest('hex');
}

export type EpisodeState = {
  firstRunId: string | null;
  latestRunId: string | null;
  firstSeenAt: Date;
  displayedFields: unknown;
  retentionExpiresAt: Date;
};

export type EpisodeRun = {
  runId: string;
  seenAt: Date;
  displayedFields: unknown;
  retentionExpiresAt: Date;
};

/**
 * Episode upsert rule for one new analyse. The first run keeps first_run_id,
 * first_seen_at and displayed_fields. The latest run moves latest_run_id. Retention only
 * grows. The database write mirrors this under a row lock.
 */
export function mergeEpisodeOnRun(current: EpisodeState | null, run: EpisodeRun): EpisodeState {
  if (!current) {
    return {
      firstRunId: run.runId,
      latestRunId: run.runId,
      firstSeenAt: run.seenAt,
      displayedFields: run.displayedFields ?? null,
      retentionExpiresAt: run.retentionExpiresAt,
    };
  }
  return {
    firstRunId: current.firstRunId ?? run.runId,
    latestRunId: run.runId,
    firstSeenAt: current.firstSeenAt,
    displayedFields: current.displayedFields ?? run.displayedFields ?? null,
    retentionExpiresAt:
      current.retentionExpiresAt.getTime() >= run.retentionExpiresAt.getTime()
        ? current.retentionExpiresAt
        : run.retentionExpiresAt,
  };
}

type RecordOutcome = { id: string | null; code: 'ok' | 'error' | 'timeout' };

type LedgerTx = Parameters<Parameters<DB['transaction']>[0]>[0];

/** Runs a ledger write in one transaction whose statements are bounded by the limits above. */
export function ledgerTransaction<T>(db: DB, work: (tx: LedgerTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LEDGER_LOCK_TIMEOUT_MS}ms'`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${LEDGER_STATEMENT_TIMEOUT_MS}ms'`));
    return work(tx);
  });
}

/**
 * Records one run within AGENT_RUN_RECORD_CAP_MS. Never rejects. Resolves to the run id,
 * or null on error or timeout. Logs carry a code only, never field values.
 */
export async function recordAgentRunCapped(
  recorder: AgentRunRecorder,
  draft: AgentRunDraft,
  capMs: number = AGENT_RUN_RECORD_CAP_MS,
): Promise<string | null> {
  const settled = (async (): Promise<RecordOutcome> => {
    try {
      const cachedFromRunId =
        draft.cacheStatus === 'hit'
          ? await recorder.findOriginRunId({
              inputKey: draft.inputKey,
              producingRunId: draft.producingRunId ?? null,
              cacheWrittenAt: draft.cacheWrittenAt ?? null,
            })
          : null;
      return { id: await recorder.record({ ...draft, cachedFromRunId }), code: 'ok' };
    } catch {
      return { id: null, code: 'error' };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<RecordOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ id: null, code: 'timeout' }), capMs);
  });
  try {
    const outcome = await Promise.race([settled, capped]);
    if (outcome.code !== 'ok') console.warn('hitl_record_skipped', { code: outcome.code });
    return outcome.id;
  } finally {
    clearTimeout(timer);
  }
}

function episodeColumns(state: EpisodeState) {
  return {
    firstRunId: state.firstRunId,
    latestRunId: state.latestRunId,
    firstSeenAt: state.firstSeenAt,
    displayedFields: state.displayedFields as Record<string, unknown> | null,
    retentionExpiresAt: state.retentionExpiresAt,
  };
}

/**
 * Database recorder. Returns null when disabled, so a disabled caller never reaches the
 * database handle. A pane run writes its run row and upserts the (transport, message,
 * user) episode in one transaction. A warmer run writes its row only.
 */
export function createAgentRunRecorder(
  db: DB,
  options: { enabled: boolean; now?: () => Date },
): AgentRunRecorder | null {
  if (!options.enabled) return null;
  const clock = options.now ?? (() => new Date());
  return {
    async findOriginRunId({ inputKey, producingRunId, cacheWrittenAt }) {
      const modelRunForInput = and(
        eq(aiAgentRun.inputKey, inputKey),
        eq(aiAgentRun.source, 'luna'),
        inArray(aiAgentRun.cacheStatus, ['miss', 'backfill']),
      );
      if (producingRunId) {
        // Verified, not trusted: the id must still name a model run for this input. Retention may have purged it.
        const [producing] = await db
          .select({ id: aiAgentRun.id })
          .from(aiAgentRun)
          .where(and(eq(aiAgentRun.id, producingRunId), modelRunForInput))
          .limit(1);
        if (producing) return producing.id;
      }
      const bounded = cacheWrittenAt
        ? and(
            modelRunForInput,
            lte(aiAgentRun.createdAt, new Date(cacheWrittenAt.getTime() + CACHE_ORIGIN_SKEW_MS)),
          )
        : modelRunForInput;
      const [origin] = await db
        .select({ id: aiAgentRun.id })
        .from(aiAgentRun)
        .where(bounded)
        .orderBy(desc(aiAgentRun.createdAt))
        .limit(1);
      return origin?.id ?? null;
    },
    async record(run) {
      const now = clock();
      const id = randomUUID();
      const row = {
        id,
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        transportId: run.transportId,
        threadId: run.threadId,
        messageId: run.messageId,
        userId: run.userId,
        cachedFromRunId: run.cachedFromRunId,
        trigger: run.trigger,
        cacheStatus: run.cacheStatus,
        provider: run.provider,
        modelId: run.modelId,
        modelRoute: run.modelRoute,
        promptVersion: run.promptVersion,
        inputHash: run.inputHash,
        inputKey: run.inputKey,
        treatAs: run.treatAs,
        staffNotePresent: run.staffNotePresent,
        source: run.source,
        fallbackReason: run.fallbackReason,
        workflow: run.workflow,
        latencyMs: run.latencyMs === null ? null : Math.round(run.latencyMs),
        inputTokens: run.usage ? Math.round(run.usage.inputTokens) : null,
        outputTokens: run.usage ? Math.round(run.usage.outputTokens) : null,
        costUsd:
          run.usage?.costUsd === null || run.usage?.costUsd === undefined
            ? null
            : run.usage.costUsd.toFixed(6),
        usageSource: run.usage?.usageSource ?? null,
        output: (run.output ?? null) as Record<string, unknown> | null,
        suggestedFields: (run.suggestedFields ?? null) as Record<string, unknown> | null,
        createdAt: now,
        retentionExpiresAt: new Date(now.getTime() + HITL_RETENTION_WINDOW_MS),
      };
      if (run.trigger !== 'pane' || run.userId === null) {
        await ledgerTransaction(db, async (tx) => {
          await tx.insert(aiAgentRun).values(row);
        });
        return id;
      }
      const userId = run.userId;
      const seen: EpisodeRun = {
        runId: id,
        seenAt: now,
        displayedFields: run.suggestedFields,
        retentionExpiresAt: row.retentionExpiresAt,
      };
      const episodeKey = and(
        eq(hitlEpisode.transportId, run.transportId),
        eq(hitlEpisode.messageId, run.messageId),
        eq(hitlEpisode.userId, userId),
      );
      await ledgerTransaction(db, async (tx) => {
        await tx.insert(aiAgentRun).values(row);
        const created = await tx
          .insert(hitlEpisode)
          .values({
            transportId: run.transportId,
            messageId: run.messageId,
            userId,
            ...episodeColumns(mergeEpisodeOnRun(null, seen)),
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [hitlEpisode.transportId, hitlEpisode.messageId, hitlEpisode.userId],
          })
          .returning({ id: hitlEpisode.id });
        let episodeId = created[0]?.id;
        if (!episodeId) {
          const [current] = await tx
            .select()
            .from(hitlEpisode)
            .where(episodeKey)
            .limit(1)
            .for('update');
          if (!current) throw new Error('hitl_episode_missing');
          await tx
            .update(hitlEpisode)
            .set({ ...episodeColumns(mergeEpisodeOnRun(current, seen)), updatedAt: now })
            .where(eq(hitlEpisode.id, current.id));
          episodeId = current.id;
        }
        await tx.update(aiAgentRun).set({ episodeId }).where(eq(aiAgentRun.id, id));
      });
      return id;
    },
  };
}

/**
 * Production wiring. Flag off returns null without touching the database. An explicit
 * override (tests, or a caller-supplied sink) wins over the default DB recorder.
 */
export function resolveAgentRunRecorder(
  env: EnvInput,
  override?: AgentRunRecorder | null,
): AgentRunRecorder | null {
  if (!isHitlLedgerEnabled(env)) return null;
  if (override) return override;
  try {
    return createAgentRunRecorder(getDb(), { enabled: true });
  } catch {
    console.warn('hitl_recorder_unavailable', { code: 'db_unavailable' });
    return null;
  }
}

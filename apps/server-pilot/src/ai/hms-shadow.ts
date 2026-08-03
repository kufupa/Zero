/**
 * Strict HMS shadow terminal writer.
 * Persists workflow lifecycle + fixed aggregate counters only.
 * Must not import the AI draft persistence module.
 */
import { z } from 'zod';
import type { DB } from '../db/client.js';
import {
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
  remainingRunBudgetMs,
  shouldRetryAiFailure,
  CLEANUP_RESERVE_MS,
  type AiFailureClass,
  type AiRunFence,
} from './run-ledger.js';
import {
  buildThreadContext,
  filterExactReservationCandidates,
  requireExactlyOneExactCandidate,
  type BuildThreadContextInput,
  type ExactLookupCandidate,
  type ThreadContext,
  type ThreadContextMessage,
} from './thread-context.js';

export const HMS_MANUAL_OPS_REQUIRED = 'HMS_MANUAL_OPS_REQUIRED' as const;

const AI_FAILURE_CLASSES = [
  'RUN_DEADLINE',
  'LEASE_LOST',
  'POLICY_BLOCK',
  'AUTH',
  'PROPERTY_MISMATCH',
  'SCHEMA_DRIFT',
  'TRANSIENT_NETWORK',
  'BEDROCK_TRANSIENT',
  'ARTIFACT_TRANSIENT',
  'UNKNOWN',
] as const satisfies readonly AiFailureClass[];

export const hmsShadowMetricsSchema = z
  .object({
    outcome: z.enum([
      'candidate',
      'needs_clarification',
      'insufficient_evidence',
      'stale_thread',
    ]),
    toolCalls: z.number().int().nonnegative(),
    toolBudgetUsed: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
    failureClass: z.enum(AI_FAILURE_CLASSES).optional(),
  })
  .strict();

export type HmsShadowMetrics = z.infer<typeof hmsShadowMetricsSchema>;

export type HmsShadowPreBrowserDeps = {
  loadLatestDraftRevisionId: () => Promise<string | null>;
  loadMessages: () => Promise<readonly ThreadContextMessage[]>;
  buildThreadContext?: (
    input: BuildThreadContextInput,
  ) => Promise<ThreadContext>;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
};

export type HmsShadowPreBrowserResult =
  | { kind: 'stale_thread' }
  | { kind: 'insufficient_evidence'; exactCount: number }
  | {
      kind: 'ready';
      context: ThreadContext;
      exact: ExactLookupCandidate;
    };

function exactIdentityKey(exact: readonly ExactLookupCandidate[]): string {
  return [...exact]
    .map((c) => `${c.kind}:${c.id}`)
    .sort()
    .join('|');
}

/**
 * Double freshness before browser: each pass reloads messages + draft revision
 * id. Revision / exact-candidate drift → stale_thread. Not exactly one exact →
 * insufficient_evidence (never open session).
 */
export async function resolveHmsShadowPreBrowser(
  deps: HmsShadowPreBrowserDeps,
  options: { signal?: AbortSignal } = {},
): Promise<HmsShadowPreBrowserResult> {
  const build = deps.buildThreadContext ?? buildThreadContext;

  const rev1 = await deps.loadLatestDraftRevisionId();
  const messages1 = await deps.loadMessages();
  const contextFirst = await build({
    transportId: deps.transportId,
    threadId: deps.threadId,
    triggerMessageId: deps.triggerMessageId,
    messages: messages1,
    latestDraftRevisionId: rev1,
  });

  if (options.signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }

  // Pass 2 — full recompute (must not reuse pass-1 latestDraftRevisionId).
  const rev2 = await deps.loadLatestDraftRevisionId();
  const messages2 = await deps.loadMessages();
  const context = await build({
    transportId: deps.transportId,
    threadId: deps.threadId,
    triggerMessageId: deps.triggerMessageId,
    messages: messages2,
    latestDraftRevisionId: rev2,
  });

  if (context.threadStateVersion !== contextFirst.threadStateVersion) {
    return { kind: 'stale_thread' };
  }

  const exactFirst = filterExactReservationCandidates(
    contextFirst.lookupCandidates,
  );
  const exact = filterExactReservationCandidates(context.lookupCandidates);
  if (exactIdentityKey(exactFirst) !== exactIdentityKey(exact)) {
    return { kind: 'stale_thread' };
  }

  const one = requireExactlyOneExactCandidate(context.lookupCandidates);
  if (!one) {
    return { kind: 'insufficient_evidence', exactCount: exact.length };
  }

  return { kind: 'ready', context, exact: one };
}

export function classifyHmsShadowFailure(error: unknown): AiFailureClass {
  if (error && typeof error === 'object' && 'failureClass' in error) {
    const cls = (error as { failureClass: string }).failureClass;
    if ((AI_FAILURE_CLASSES as readonly string[]).includes(cls)) {
      return cls as AiFailureClass;
    }
  }
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name: string }).name);
    if (name === 'RunDeadlineError') return 'RUN_DEADLINE';
    if (name === 'AbortError') return 'LEASE_LOST';
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: string }).code);
    if (/ROLE_PROOF|AUTH|login|credential/i.test(code)) return 'AUTH';
    if (/PROPERTY|wrong_property|wrong_tenant/i.test(code)) return 'PROPERTY_MISMATCH';
    if (/POLICY|WEBSOCKET|POPUP|DOWNLOAD/i.test(code)) return 'POLICY_BLOCK';
    if (/SCHEMA|malformed|correlation/i.test(code)) return 'SCHEMA_DRIFT';
    if (/TRANSIENT|network|chromium|ECONNRESET|ENOTFOUND/i.test(code)) {
      return 'TRANSIENT_NETWORK';
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|ECONNRESET|ENOTFOUND|network/i.test(message)) return 'TRANSIENT_NETWORK';
  if (/bedrock|throttl|TooManyRequests|ServiceUnavailable/i.test(message)) {
    return 'BEDROCK_TRANSIENT';
  }
  if (/policy|guardrail/i.test(message)) return 'POLICY_BLOCK';
  if (/auth|unauthorized|forbidden/i.test(message)) return 'AUTH';
  if (/deadline/i.test(message)) return 'RUN_DEADLINE';
  return 'UNKNOWN';
}

/**
 * Fenced success: fixed counters only. generationId stays null.
 * Rejects metrics that carry free-form / forbidden keys via .strict().
 */
export async function finishHmsShadowRun(
  fence: AiRunFence,
  metrics: HmsShadowMetrics,
  db?: DB,
): Promise<boolean> {
  const parsed = hmsShadowMetricsSchema.parse(metrics);
  const marked = await markAiRunSucceeded(
    {
      runId: fence.runId,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['running'],
      metrics: parsed,
    },
    db,
  );
  return Boolean(marked);
}

/**
 * HMS-only safe failure writer. Classifies once; persists enum as both
 * failureClass and lastError. Raw error.message stays memory-only.
 */
export async function failHmsShadowRun(
  fence: AiRunFence,
  error: unknown,
  options: { attempts?: number; db?: DB } = {},
): Promise<'dead_letter' | 'retry_wait'> {
  const failureClass = classifyHmsShadowFailure(error);
  // Fixed context only — never log guest/reservation tokens from error.message.
  console.error(
    JSON.stringify({
      hmsShadowFail: true,
      failureClass,
      runId: fence.runId,
    }),
  );

  const attempts = (options.attempts ?? 0) + 1;
  const canRetry = shouldRetryAiFailure({
    failureClass,
    fence,
    attempts: options.attempts ?? 0,
  });

  if (
    canRetry &&
    remainingRunBudgetMs(fence) >= CLEANUP_RESERVE_MS
  ) {
    const row = await markAiRunRetry(
      {
        runId: fence.runId,
        claimOwner: fence.claimOwner,
        claimToken: fence.claimToken,
        expectedStates: ['running'],
        attempts,
        nextRunAt: new Date(Date.now() + attempts * 60_000),
        lastError: failureClass,
        failureClass,
      },
      options.db,
    );
    return row ? 'retry_wait' : 'dead_letter';
  }

  await markAiRunDeadLetter(
    {
      runId: fence.runId,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['running'],
      lastError: failureClass,
      failureClass,
    },
    options.db,
  );
  return 'dead_letter';
}

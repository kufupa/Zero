import { and, eq } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import {
  HITL_LABEL_STRENGTHS,
  HITL_TOOL_RUN_KINDS,
  HITL_TOOL_RUN_STATUSES,
  hitlEpisode,
  hitlToolRun,
} from '../db/schema/hitl.js';
import { isHitlLedgerEnabled, type EnvInput } from '../env.js';
import { createHash, randomUUID } from 'node:crypto';
import { AGENT_RUN_RECORD_CAP_MS, HITL_RETENTION_WINDOW_MS, ledgerTransaction } from './hitl-recorder.js';
import type { StaffQuoteInput } from './staff-quote-workflow.js';
import type { PaneStayCancelResult } from './pane-stay-cancel.js';
import type { PaneStayFindResult, PaneStayGuestSearchResult } from './pane-stay-lookup.js';
import type { PaneStayResult } from './pane-stay-save.js';

/**
 * HITL tool-run ledger, recording side. Server only. With HITL_LEDGER off nothing here touches the database:
 * resolveToolRunRecorder returns null before any DB access. A run is recorded from the route that ran the tool,
 * never from inside the runner. Recording is best effort: it waits at most AGENT_RUN_RECORD_CAP_MS and never
 * fails the tool. Logs carry a code and the kind, never a value. Workstation procedures record from a tRPC
 * middleware (recordToolOutcome), so their bodies are unchanged.
 */

export type HitlToolRunKind = (typeof HITL_TOOL_RUN_KINDS)[number];
export type HitlToolRunStatus = (typeof HITL_TOOL_RUN_STATUSES)[number];
export type ToolEpisodeOutcome = 'quoted' | 'booked' | 'cancelled';

/** One tool run. Identifiers, digests and totals only. The quote input is the one exception; see ledgerQuoteInput. */
export type ToolRunDraft = {
  kind: HitlToolRunKind;
  status: HitlToolRunStatus;
  transportId: string;
  /** The mail the tool worked on. Null for stay, cancel and lookup tools, which carry none. */
  messageId: string | null;
  userId: string | null;
  workflowRunId: string | null;
  input: Record<string, unknown> | null;
  inputDigest: string | null;
  errorCode: string | null;
  result: Record<string, unknown> | null;
  confirmationNo: string | null;
  hmsRunId: string | null;
  startedAt: Date;
  durationMs: number;
  /** Episode effect of a successful run: quoted, booked or cancelled. Null otherwise. */
  episodeOutcome: ToolEpisodeOutcome | null;
};

export type ToolRunRecorder = { record(run: ToolRunDraft): Promise<void> };

/** The episode fields a tool run can move. Mirrors hitl_episode. */
export type EpisodeToolState = {
  firstToolAt: Date | null;
  outcome: string;
  bookedConfirmationNo: string | null;
  labelStrength: string;
};

/** Episode outcomes only move forward: quoted, then booked, then cancelled. A later quote never undoes them. */
const OUTCOME_RANK: Record<string, number> = { open: 0, quoted: 1, booked: 2, cancelled: 3 };
const LABEL_ORDER: readonly string[] = HITL_LABEL_STRENGTHS;

/**
 * The episode after one tool run. The first tool time is kept. The outcome moves forward only. The booked
 * confirmation is the latest one seen. The label is the stronger of the current label and this run's label:
 * booked when a confirmation exists, otherwise tool_input for a successful run.
 */
export function mergeEpisodeOnToolRun(current: EpisodeToolState | null, run: ToolRunDraft): EpisodeToolState {
  const base: EpisodeToolState = current ?? {
    firstToolAt: null,
    outcome: 'open',
    bookedConfirmationNo: null,
    labelStrength: 'none',
  };
  const succeeded = run.status === 'ok';
  const outcome =
    succeeded &&
    run.episodeOutcome &&
    (OUTCOME_RANK[run.episodeOutcome] ?? 0) > (OUTCOME_RANK[base.outcome] ?? 0)
      ? run.episodeOutcome
      : base.outcome;
  const proposed = succeeded ? (run.confirmationNo ? 'booked' : 'tool_input') : null;
  const labelStrength =
    proposed && LABEL_ORDER.indexOf(proposed) < LABEL_ORDER.indexOf(base.labelStrength)
      ? proposed
      : base.labelStrength;
  return {
    firstToolAt: base.firstToolAt ?? run.startedAt,
    outcome,
    bookedConfirmationNo:
      succeeded && run.confirmationNo ? run.confirmationNo : base.bookedConfirmationNo,
    labelStrength,
  };
}

/** Writes one tool run and, when the mail and the user are known, links its episode. */
export function createToolRunRecorder(
  db: DB,
  options: { enabled: boolean; now?: () => Date },
): ToolRunRecorder | null {
  if (!options.enabled) return null;
  const clock = options.now ?? (() => new Date());
  return {
    async record(run) {
      const now = clock();
      const id = randomUUID();
      const retentionExpiresAt = new Date(now.getTime() + HITL_RETENTION_WINDOW_MS);
      const row = {
        id,
        messageId: run.messageId,
        userId: run.userId,
        transportId: run.transportId,
        workflowRunId: run.workflowRunId,
        kind: run.kind,
        input: run.input,
        inputDigest: run.inputDigest,
        status: run.status,
        errorCode: run.errorCode,
        result: run.result,
        confirmationNo: run.confirmationNo,
        hmsRunId: run.hmsRunId,
        startedAt: run.startedAt,
        durationMs: Math.round(run.durationMs),
        retentionExpiresAt,
      };
      const { messageId, userId } = run;
      // Every write runs in the ledger transaction, so its lock and statement timeouts bound it. The caller's cap
      // bounds the wait on the request path.
      await ledgerTransaction(db, async (tx) => {
        if (!messageId || !userId) {
          await tx.insert(hitlToolRun).values({ ...row, episodeId: null });
          return;
        }
        const merged = mergeEpisodeOnToolRun(null, run);
        const created = await tx
          .insert(hitlEpisode)
          .values({
            transportId: run.transportId,
            messageId,
            userId,
            ...merged,
            firstSeenAt: now,
            retentionExpiresAt,
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
            .where(
              and(
                eq(hitlEpisode.transportId, run.transportId),
                eq(hitlEpisode.messageId, messageId),
                eq(hitlEpisode.userId, userId),
              ),
            )
            .limit(1)
            .for('update');
          if (!current) throw new Error('hitl_episode_missing');
          const next = mergeEpisodeOnToolRun(current, run);
          await tx
            .update(hitlEpisode)
            .set({
              ...next,
              retentionExpiresAt:
                current.retentionExpiresAt.getTime() >= retentionExpiresAt.getTime()
                  ? current.retentionExpiresAt
                  : retentionExpiresAt,
              updatedAt: now,
            })
            .where(eq(hitlEpisode.id, current.id));
          episodeId = current.id;
        }
        await tx.insert(hitlToolRun).values({ ...row, episodeId });
      });
    },
  };
}

/** Test seam for route recording. Production leaves it null and gets the database recorder. */
export const toolRunLoaders: { recorder: ToolRunRecorder | null } = { recorder: null };

/**
 * Flag off returns null before any database access, so a disabled route never reaches the database handle, even
 * when a sink is supplied. An explicit override wins over the database recorder when the flag is on.
 */
export function resolveToolRunRecorder(
  env: EnvInput,
  override?: ToolRunRecorder | null,
): ToolRunRecorder | null {
  if (!isHitlLedgerEnabled(env)) return null;
  if (override) return override;
  try {
    return createToolRunRecorder(getDb(), { enabled: true });
  } catch {
    console.warn('hitl_tool_recorder_unavailable', { code: 'db_unavailable' });
    return null;
  }
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,120}$/;
const REFUSAL_CODES = new Set(['PRECONDITION_FAILED', 'BAD_REQUEST', 'NOT_FOUND', 'FORBIDDEN']);

/** The identifier a thrown error carries, or "unknown". Never the message. */
export function toolErrorCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof raw === 'string' && IDENTIFIER.test(raw) ? raw : 'unknown';
}

/** A thrown tool error is a refusal when it is a request problem the staff can fix; otherwise a failure. */
export function toolErrorStatus(error: unknown): 'refused' | 'failed' {
  return REFUSAL_CODES.has(toolErrorCode(error)) ? 'refused' : 'failed';
}

/** A tool's own answer, reduced to what the ledger keeps. */
export type ToolRunFields = {
  status: HitlToolRunStatus;
  errorCode?: string | null;
  result?: Record<string, unknown> | null;
  confirmationNo?: string | null;
  hmsRunId?: string | null;
  workflowRunId?: string | null;
  inputDigest?: string | null;
  episodeOutcome?: ToolEpisodeOutcome | null;
};

export type ToolRunSpec = {
  kind: HitlToolRunKind;
  transportId: string;
  messageId: string | null;
  userId: string | null;
  workflowRunId?: string | null;
  input?: Record<string, unknown> | null;
  inputDigest?: string | null;
};

/** Sends one draft, waits at most capMs, and never throws. A slow write finishes in the background. */
export async function recordToolRunCapped(
  recorder: ToolRunRecorder,
  draft: ToolRunDraft,
  capMs: number = AGENT_RUN_RECORD_CAP_MS,
): Promise<boolean> {
  const settled = Promise.resolve()
    .then(() => recorder.record(draft))
    .then(
      () => 'ok' as const,
      () => 'error' as const,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), capMs);
  });
  try {
    const outcome = await Promise.race([settled, capped]);
    if (outcome !== 'ok') console.warn('hitl_tool_record_skipped', { code: outcome, kind: draft.kind });
    return outcome === 'ok';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one tool and records its outcome. With the flag off this is just the tool: nothing is built or written.
 * A thrown error is recorded as refused or failed and then rethrown unchanged.
 */
export async function recordedToolRun<T>(
  spec: ToolRunSpec,
  run: () => Promise<T>,
  classify: (value: T) => ToolRunFields,
  classifyError: (error: unknown) => ToolRunFields = (error) => ({
    status: toolErrorStatus(error),
    errorCode: toolErrorCode(error),
  }),
  options: { recorder?: ToolRunRecorder | null; now?: () => number; capMs?: number } = {},
): Promise<T> {
  // The flag gates every path, including an injected recorder: with it off the tool runs and nothing is written.
  if (!isHitlLedgerEnabled(process.env)) return run();
  const recorder =
    'recorder' in options
      ? options.recorder
      : resolveToolRunRecorder(process.env, toolRunLoaders.recorder);
  if (!recorder) return run();
  const now = options.now ?? Date.now;
  const started = now();
  const write = (fields: ToolRunFields) =>
    recordToolRunCapped(recorder, draftOf(spec, fields, started, now() - started), options.capMs);
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await write(safeClassifyError(classifyError, error));
    throw error;
  }
  let fields: ToolRunFields;
  try {
    fields = classify(value);
  } catch {
    fields = { status: 'failed', errorCode: 'classify_failed' };
  }
  await write(fields);
  return value;
}

/** The ledger row for one run: the spec's identity, the tool's own fields, and the timing. */
function draftOf(spec: ToolRunSpec, fields: ToolRunFields, started: number, durationMs: number): ToolRunDraft {
  return {
    kind: spec.kind,
    status: fields.status,
    transportId: spec.transportId,
    messageId: spec.messageId,
    userId: spec.userId,
    workflowRunId: fields.workflowRunId ?? spec.workflowRunId ?? null,
    input: spec.input ?? null,
    inputDigest: fields.inputDigest ?? spec.inputDigest ?? null,
    errorCode: fields.errorCode ?? null,
    result: fields.result ?? null,
    confirmationNo: fields.confirmationNo ?? null,
    hmsRunId: fields.hmsRunId ?? null,
    startedAt: new Date(started),
    durationMs,
    episodeOutcome: fields.episodeOutcome ?? null,
  };
}

/** A procedure's outcome as tRPC middleware sees it: the data it returned, or the error it threw. */
export type ProcedureOutcome = { ok: true; data: unknown } | { ok: false; error: unknown };

/** tRPC wraps an unexpected error in INTERNAL_SERVER_ERROR. The code that matters is the one the procedure threw. */
function thrownOf(error: unknown): unknown {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'INTERNAL_SERVER_ERROR' &&
    'cause' in error &&
    error.cause
  ) {
    return error.cause;
  }
  return error;
}

function failureFields(error: unknown): ToolRunFields {
  const thrown = thrownOf(error);
  return { status: toolErrorStatus(thrown), errorCode: toolErrorCode(thrown) };
}

function classifyOrFail<T>(classify: (value: T) => ToolRunFields, value: T): ToolRunFields {
  try {
    return classify(value);
  } catch {
    return { status: 'failed', errorCode: 'classify_failed' };
  }
}

/**
 * Records one procedure's outcome from its tRPC middleware. `next()` runs the procedure body, so the body keeps its
 * place. The spec is built only when the ledger is on. A ledger error never changes the outcome, and the outcome is
 * returned exactly as tRPC produced it.
 */
export async function recordToolOutcome<R extends ProcedureOutcome, T>(
  spec: () => ToolRunSpec,
  classify: (value: T) => ToolRunFields,
  next: () => Promise<R>,
): Promise<R> {
  const recorder = resolveToolRunRecorder(process.env, toolRunLoaders.recorder);
  if (!recorder) return next();
  const started = Date.now();
  const result = await next();
  const outcome: ProcedureOutcome = result;
  const fields = outcome.ok ? classifyOrFail(classify, outcome.data as T) : failureFields(outcome.error);
  try {
    await recordToolRunCapped(recorder, draftOf(spec(), fields, started, Date.now() - started));
  } catch {
    console.warn('hitl_tool_record_skipped', { code: 'draft_failed' });
  }
  return result;
}

function safeClassifyError(
  classifyError: (error: unknown) => ToolRunFields,
  error: unknown,
): ToolRunFields {
  try {
    return classifyError(error);
  } catch {
    return { status: 'failed', errorCode: 'classify_failed' };
  }
}

/** Digest of a small flat input (a lookup's request). Keys are sorted, so the same request gives the same digest. */
export function toolInputDigest(value: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key] ?? null]));
  return createHash('sha256').update(canonical).digest('hex');
}

/** The party the staff picked for the quote. Carried in the quote input once the party picker adds it. */
type QuotePartyInput = { party?: { kind: string; nativeId: string; name: string } };

/**
 * The approved quote input as the ledger keeps it. Business names (company, agency, party) stay: the party picker is
 * evaluated against them. Contact details, the attention line, notes and free-text labels stay out.
 */
export function ledgerQuoteInput(input: StaffQuoteInput & QuotePartyInput): Record<string, unknown> {
  return {
    messageId: input.messageId,
    sourceHash: input.sourceHash,
    selectionEpoch: input.selectionEpoch,
    inputRevision: input.inputRevision,
    salesStrategy: input.salesStrategy,
    company: input.company,
    agency: input.agency,
    party: input.party
      ? { kind: input.party.kind, nativeId: input.party.nativeId, name: input.party.name }
      : undefined,
    groups: input.groups,
    dinnerAllowanceMinor: input.dinnerAllowanceMinor,
    dinnerAllowanceGroupIds: input.dinnerAllowanceGroupIds,
    lunchAllowanceMinor: input.lunchAllowanceMinor,
    officeTransferMinor: input.officeTransferMinor,
    officeTransferDays: input.officeTransferDays,
    shuttleRequested: input.shuttleRequested,
    shuttleMinor: input.shuttleMinor,
    shuttleTrips: input.shuttleTrips,
    other: input.other ? { amountMinor: input.other.amountMinor, unit: input.other.unit } : undefined,
  };
}

const identifierOrNull = (value: unknown): string | null =>
  typeof value === 'string' && IDENTIFIER.test(value) ? value : null;

const identifierOr = (value: unknown, fallback: string): string => identifierOrNull(value) ?? fallback;

/** A stay preview: refused with its reason, or ok with the digest that a commit must send back. */
export function classifyStayPreview(value: PaneStayResult): ToolRunFields {
  if (value.status === 'ok') {
    return {
      status: 'ok',
      inputDigest: identifierOrNull(value.previewDigest),
      result: { outcome: identifierOrNull(value.outcome) },
    };
  }
  return { status: 'refused', errorCode: identifierOr(value.reason, 'refused') };
}

/**
 * A stay commit. A confirmation number means the booking exists (booked). A save that could not be confirmed is
 * unconfirmed, so staff check HMS before pressing Book again. Anything else refused.
 */
export function classifyStayCommit(value: PaneStayResult, previewDigest: string): ToolRunFields {
  if (value.reason === 'pane_save_unconfirmed') {
    return { status: 'unconfirmed', errorCode: 'pane_save_unconfirmed', inputDigest: previewDigest };
  }
  if (value.status === 'refused') {
    return { status: 'refused', errorCode: identifierOr(value.reason, 'refused'), inputDigest: previewDigest };
  }
  const confirmation = identifierOrNull(value.confirmationNumber);
  if (!confirmation) {
    return { status: 'unconfirmed', errorCode: 'pane_save_unconfirmed', inputDigest: previewDigest };
  }
  return {
    status: 'ok',
    confirmationNo: confirmation,
    episodeOutcome: 'booked',
    inputDigest: previewDigest,
    result: { outcome: identifierOrNull(value.outcome) },
  };
}

const CANCEL_REFUSALS = /^(refused_|cancel_preview_required$|cancel_digest_mismatch$|already_cancelled$)/;

/** A cancel preview: preview_ok grants a commit. cancel_unconfirmed is unconfirmed. Other refusals are refused. */
export function classifyCancelPreview(value: PaneStayCancelResult, digest: string): ToolRunFields {
  if (value.outcome === 'preview_ok') {
    return { status: 'ok', inputDigest: digest, result: { outcome: 'preview_ok' } };
  }
  if (value.outcome === 'cancel_unconfirmed') {
    return { status: 'unconfirmed', errorCode: 'cancel_unconfirmed', inputDigest: digest };
  }
  const refused = CANCEL_REFUSALS.test(value.outcome);
  return {
    status: refused ? 'refused' : 'failed',
    errorCode: identifierOr(value.outcome, 'unknown'),
    inputDigest: digest,
  };
}

/** A cancel commit: cancelled moves the episode to cancelled. The booking confirmation is the one cancelled. */
export function classifyCancelCommit(
  value: PaneStayCancelResult,
  confirmation: string,
  digest: string,
): ToolRunFields {
  const cancelled = value.outcome === 'cancelled' || value.statusAfter?.toLowerCase() === 'cancelled';
  if (cancelled) {
    return {
      status: 'ok',
      confirmationNo: identifierOrNull(confirmation),
      episodeOutcome: 'cancelled',
      inputDigest: digest,
      result: { outcome: 'cancelled' },
    };
  }
  if (value.outcome === 'cancel_unconfirmed') {
    return {
      status: 'unconfirmed',
      errorCode: 'cancel_unconfirmed',
      confirmationNo: identifierOrNull(confirmation),
      inputDigest: digest,
    };
  }
  const refused = CANCEL_REFUSALS.test(value.outcome);
  return {
    status: refused ? 'refused' : 'failed',
    errorCode: identifierOr(value.outcome, 'unknown'),
    confirmationNo: identifierOrNull(confirmation),
    inputDigest: digest,
  };
}

/** A stay find. found, not_found and ambiguous are completed reads. execution_failure failed. Refusals refused. */
export function classifyFind(value: PaneStayFindResult): ToolRunFields {
  if (value.outcome === 'found' || value.outcome === 'not_found' || value.outcome === 'ambiguous') {
    return { status: 'ok', result: { outcome: value.outcome } };
  }
  if (value.outcome === 'execution_failure') {
    return { status: 'failed', errorCode: 'execution_failure' };
  }
  return { status: 'refused', errorCode: identifierOr(value.outcome, 'refused') };
}

/** A guest search. ok and ambiguous_capped are completed reads (rows counted, never stored). */
export function classifySearch(value: PaneStayGuestSearchResult): ToolRunFields {
  if (value.outcome === 'ok' || value.outcome === 'ambiguous_capped') {
    return { status: 'ok', result: { outcome: value.outcome, rowCount: value.rows.length } };
  }
  if (value.outcome === 'execution_failure') {
    return { status: 'failed', errorCode: 'execution_failure' };
  }
  return { status: 'refused', errorCode: identifierOr(value.outcome, 'refused') };
}

/** A staff quote run. Ready is ok and moves the episode to quoted. */
export function classifyStaffQuote(value: {
  status: string;
  workflowRunId?: string;
  revisionRef?: string;
  totalMinor?: number;
  currency?: string;
}): ToolRunFields {
  if (value.status !== 'ready') return { status: 'refused', errorCode: identifierOr(value.status, 'not_ready') };
  return {
    status: 'ok',
    workflowRunId: identifierOrNull(value.workflowRunId),
    result: {
      revisionRef: identifierOrNull(value.revisionRef),
      totalMinor: typeof value.totalMinor === 'number' ? value.totalMinor : null,
      currency: identifierOrNull(value.currency),
    },
    episodeOutcome: 'quoted',
  };
}

/** A quotation PDF or source PDF. Its hash and total are kept; the file is not. */
export function classifyPdf(value: { pdfHash?: string; totalMinor?: number; revisionId?: string }): ToolRunFields {
  return {
    status: 'ok',
    result: {
      pdfHash: /^[a-f0-9]{64}$/.test(value.pdfHash ?? '') ? value.pdfHash : null,
      totalMinor: typeof value.totalMinor === 'number' ? value.totalMinor : null,
      revisionId: identifierOrNull(value.revisionId),
    },
    episodeOutcome: 'quoted',
  };
}

/** A booking draft is ready (ok) or unavailable (refused, with its reason as the code). */
export function classifyBookingDraft(value: { status: string; reason?: string }): ToolRunFields {
  if (value.status === 'ready') return { status: 'ok' };
  return { status: 'refused', errorCode: identifierOr(value.reason, 'unavailable') };
}

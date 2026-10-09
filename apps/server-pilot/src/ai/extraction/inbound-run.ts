import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getDb, type DB } from '../../db/client.js';
import { mailThread, message } from '../../db/schema/mail.js';
import { mailExtraction } from '../../db/schema/work.js';
import type { ModelAdapter } from '../bedrock/adapter.js';
import { canonicalInternetMessageId, resolveAdapter } from '../quote-workflow-analyse-selection.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../quote-workflow-synced-selection.js';
import { CENTURION_HOTEL_RULES } from '../reservationist-decision.js';
import {
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
  type AiRunFence,
  type AiWorkflowRun,
} from '../run-ledger.js';
import {
  attachmentReads,
  EXTRACTION_DEADLINE_MS,
  EXTRACTION_MODEL_ID,
  EXTRACTION_RULES,
  extractInboundMail,
  UNTRUSTED_NOTE,
  type ModelUsage,
} from './extract.js';
import { mailExtractionSchema } from './schema.js';
import {
  TRANSLATE_DEADLINE_MS,
  TRANSLATE_RULES,
  translateInboundBody,
  translationSchema,
  type InboundTranslation,
} from './translate.js';

/**
 * Inbound mail extraction. Each admitted inbound mail gets one read per extractor version. The read is queued as an
 * `inbound_extraction` ai_workflow_run and stored in mail_extraction. Off unless INBOUND_EXTRACTION=on.
 */

/** Hash of the rules, the prompt text and both output schemas. A change here means a new read for every mail. */
export const EXTRACTION_VERSION = `extract-${createHash('sha256')
  .update(CENTURION_HOTEL_RULES)
  .update('\n')
  .update(EXTRACTION_RULES)
  .update('\n')
  .update(UNTRUSTED_NOTE)
  .update('\n')
  .update(TRANSLATE_RULES)
  .update('\n')
  .update(JSON.stringify(zodToJsonSchema(mailExtractionSchema, { $refStrategy: 'none' })))
  .update('\n')
  .update(JSON.stringify(zodToJsonSchema(translationSchema, { $refStrategy: 'none' })))
  .digest('hex')
  .slice(0, 12)}`;

const DEFAULT_MAX_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;
/** A run held by the flag or the hourly cap goes back to the queue this long, without using an attempt. */
const DEFER_MS = 5 * 60 * 1000;

export function inboundExtractionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INBOUND_EXTRACTION === 'on';
}

/** Model calls per rolling hour, extraction and translation both counted. Unset or invalid means 60. */
export function inboundExtractionMaxPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INBOUND_EXTRACTION_MAX_PER_HOUR?.trim();
  if (!raw) return DEFAULT_MAX_PER_HOUR;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_PER_HOUR;
}

/** Model-call starts in the last hour, per process. Same scope as the Luna warmer's cap. */
let modelCallStarts: number[] = [];

function callsInLastHour(nowMs: number): number {
  modelCallStarts = modelCallStarts.filter((started) => nowMs - started < HOUR_MS);
  return modelCallStarts.length;
}

function takeCallSlot(max: number, nowMs: number): boolean {
  if (callsInLastHour(nowMs) >= max) return false;
  modelCallStarts.push(nowMs);
  return true;
}

export function __resetInboundExtractionCapForTests(): void {
  modelCallStarts = [];
}

/** Queues the read for one admitted inbound mail. Called inside the admission transaction. */
export async function enqueueInboundExtraction(
  input: { transportId: string; threadId: string; messageId: string },
  db: DB = getDb(),
) {
  return enqueueAiRun(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.messageId,
      runKind: 'inbound_extraction',
      idempotencyKey: `inbound-extraction:${input.messageId}:${EXTRACTION_VERSION}`,
      modelId: EXTRACTION_MODEL_ID,
      promptVersion: EXTRACTION_VERSION,
    },
    db,
  );
}

type ExtractionRowInput = Omit<typeof mailExtraction.$inferInsert, 'extractorVersion'>;

/** Insert-once per (message, version). A second write for the same read is a no-op. */
async function storeRead(db: DB, row: ExtractionRowInput): Promise<void> {
  await db
    .insert(mailExtraction)
    .values({ ...row, extractorVersion: EXTRACTION_VERSION })
    .onConflictDoNothing({ target: [mailExtraction.messageId, mailExtraction.extractorVersion] });
}

/**
 * What one run did. `stored` and `failed` both write a mail_extraction row. `capped` and `disabled` write nothing
 * and defer the run. `unconfigured` and `stale_version` dead-letter it.
 */
export type InboundExtractionOutcome =
  | 'stored'
  | 'failed'
  | 'exists'
  | 'skipped'
  | 'disabled'
  | 'unconfigured'
  | 'stale_version'
  | 'capped';

export type InboundExtractionDeps = {
  db?: DB;
  env?: NodeJS.ProcessEnv;
  /** Model seam. Absent means the Azure quote route; null means no model is configured. */
  adapter?: ModelAdapter | null;
  loadSelection?: typeof loadSyncedQuoteSelectionFromMailbox;
  signal?: AbortSignal;
  now?: () => number;
  extractionDeadlineMs?: number;
  translationDeadlineMs?: number;
};

/**
 * Reads one inbound mail. A model timeout or error is stored as a failed read and does not throw. A run cancelled by
 * its lease or deadline throws instead, so the worker's failure path decides and nothing is stored for it.
 */
export async function runInboundExtraction(
  run: Pick<AiWorkflowRun, 'transportId' | 'triggerMessageId' | 'promptVersion'>,
  deps: InboundExtractionDeps = {},
): Promise<InboundExtractionOutcome> {
  const env = deps.env ?? process.env;
  if (!inboundExtractionEnabled(env)) return 'disabled';
  if (run.promptVersion !== EXTRACTION_VERSION) return 'stale_version';
  const db = deps.db ?? getDb();
  const [trigger] = await db
    .select({
      threadId: message.threadId,
      direction: message.direction,
      messageIdHeader: message.messageIdHeader,
    })
    .from(message)
    .where(and(eq(message.id, run.triggerMessageId), eq(message.transportId, run.transportId)))
    .limit(1);
  if (!trigger || trigger.direction !== 'inbound') return 'skipped';
  const [existing] = await db
    .select({ id: mailExtraction.id })
    .from(mailExtraction)
    .where(
      and(
        eq(mailExtraction.messageId, run.triggerMessageId),
        eq(mailExtraction.extractorVersion, EXTRACTION_VERSION),
      ),
    )
    .limit(1);
  if (existing) return 'exists';
  const adapter = deps.adapter === undefined ? resolveAdapter(true, null).adapter : deps.adapter;
  if (!adapter) return 'unconfigured';
  const max = inboundExtractionMaxPerHour(env);
  const clock = deps.now ?? Date.now;
  // Checked before any mail is loaded, so a spent hour costs no S3 or PDF work.
  if (callsInLastHour(clock()) >= max) return 'capped';
  const internetMessageId = canonicalInternetMessageId(trigger.messageIdHeader);
  if (!internetMessageId) {
    await storeRead(db, {
      messageId: run.triggerMessageId,
      status: 'failed',
      usage: { failureReason: 'no_message_id' },
    });
    return 'failed';
  }
  const selection = await (deps.loadSelection ?? loadSyncedQuoteSelectionFromMailbox)({
    transportId: run.transportId,
    internetMessageId,
    signal: deps.signal,
  });
  if (!selection) {
    await storeRead(db, {
      messageId: run.triggerMessageId,
      status: 'failed',
      usage: { failureReason: 'not_found' },
    });
    return 'failed';
  }
  if (!takeCallSlot(max, clock())) return 'capped';
  const extraction = await extractInboundMail({
    adapter,
    selection,
    messageId: run.triggerMessageId,
    signal: deps.signal,
    deadlineMs: deps.extractionDeadlineMs ?? EXTRACTION_DEADLINE_MS,
  });
  const attachments = attachmentReads(selection.attachments);
  if (!extraction.ok) {
    await storeRead(db, {
      messageId: run.triggerMessageId,
      status: 'failed',
      attachments,
      usage: { ...extraction.usage, failureReason: extraction.reason },
    });
    return 'failed';
  }
  let translation: InboundTranslation | null = null;
  let translationUsage: ModelUsage | undefined;
  const { sourceLanguage } = extraction;
  // Translation runs only for a known non-English body. Its call takes a slot too. With no slot left the whole read
  // is deferred, so a non-English mail is never stored with a translation that was only capped. The retry repeats
  // the extraction call, and the cap counts that call.
  if (sourceLanguage && sourceLanguage !== 'en') {
    if (!takeCallSlot(max, clock())) return 'capped';
    const done = await translateInboundBody({
      adapter,
      bodyText: selection.bodyText,
      sourceLanguage,
      signal: deps.signal,
      deadlineMs: deps.translationDeadlineMs ?? TRANSLATE_DEADLINE_MS,
    });
    translation = done?.translation ?? null;
    translationUsage = done?.usage;
  }
  await storeRead(db, {
    messageId: run.triggerMessageId,
    status: 'succeeded',
    kind: extraction.kind,
    language: sourceLanguage,
    payload: extraction.payload,
    translation,
    attachments,
    usage: {
      extraction: extraction.usage,
      ...(translationUsage ? { translation: translationUsage } : {}),
    },
  });
  // Same effect as the triage spam write. A person's spam lock, either way, wins over the model.
  if (extraction.kind === 'spam' && env.AI_WRITE_GATE_ENABLED === 'true') {
    const now = new Date();
    await db
      .update(mailThread)
      .set({ spamAt: now, updatedAt: now })
      .where(
        and(
          eq(mailThread.id, trigger.threadId),
          eq(mailThread.transportId, run.transportId),
          isNull(mailThread.spamAt),
          isNull(mailThread.spamUserLockedAt),
        ),
      );
  }
  return 'stored';
}

/** Worker entry for an `inbound_extraction` run. Maps the outcome onto the run's state. */
export async function executeInboundExtractionRun(input: {
  run: AiWorkflowRun;
  fence: AiRunFence;
  signal: AbortSignal;
  adapter?: ModelAdapter | null;
  db?: DB;
  env?: NodeJS.ProcessEnv;
  loadSelection?: InboundExtractionDeps['loadSelection'];
}): Promise<{ runId: string; state: 'succeeded' | 'retry_wait' | 'dead_letter' }> {
  const { run, fence } = input;
  const db = input.db ?? getDb();
  const claim = {
    runId: run.id,
    claimOwner: fence.claimOwner,
    claimToken: fence.claimToken,
    expectedStates: ['running' as const],
  };
  const outcome = await runInboundExtraction(run, {
    db,
    env: input.env,
    adapter: input.adapter,
    loadSelection: input.loadSelection,
    signal: input.signal,
  });
  if (outcome === 'capped' || outcome === 'disabled') {
    await markAiRunRetry(
      {
        ...claim,
        attempts: run.attempts,
        nextRunAt: new Date(Date.now() + DEFER_MS),
        lastError:
          outcome === 'capped'
            ? 'inbound extraction hourly cap reached'
            : 'inbound extraction is off (INBOUND_EXTRACTION)',
        failureClass: 'POLICY_BLOCK',
      },
      db,
    );
    return { runId: run.id, state: 'retry_wait' };
  }
  if (outcome === 'stale_version' || outcome === 'unconfigured') {
    await markAiRunDeadLetter(
      {
        ...claim,
        lastError:
          outcome === 'stale_version'
            ? `inbound extraction version ${run.promptVersion} is not deployed (deployed ${EXTRACTION_VERSION})`
            : 'inbound extraction model is not configured',
      },
      db,
    );
    return { runId: run.id, state: 'dead_letter' };
  }
  const marked = await markAiRunSucceeded(
    { ...claim, metrics: { inboundExtraction: { outcome } } },
    db,
  );
  return { runId: run.id, state: marked ? 'succeeded' : 'retry_wait' };
}

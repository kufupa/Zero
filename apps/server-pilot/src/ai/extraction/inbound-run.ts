import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getDb, type DB } from '../../db/client.js';
import {
  aiWorkflowRun,
  mailboxTransport,
  mailCategory,
  mailThread,
  mailThreadCategory,
  message,
} from '../../db/schema/mail.js';
import { mailExtraction, workItem } from '../../db/schema/work.js';
import { getSenderPreference } from '../../mail/sender-preference.js';
import { isInboundTriageClassifierEnabled } from '../../env.js';
import { MAIL_BASELINE_INTERPRETATION_VERSION } from '../../metrics/mail-baseline.js';
import { persistMailBaselineProjection } from '../../metrics/mail-baseline-projection.js';
import { parseMailboxMeasurementConfig } from '../../metrics/mail-measurement-config.js';
import type { ModelAdapter } from '../bedrock/adapter.js';
import { AI_DURABLE_PRIMARY_CATEGORY_SLUGS } from '../categories.js';
import { isAutoTriageNeverSpam } from '../never-spam.js';
import {
  extractMailBaselineWithApprovedRoute,
  resolveMailBaselineExtractionRoute,
  type MailBaselineExtractionRoute,
} from '../mail-baseline-extraction.js';
import { lunaCallBudget } from '../bedrock/luna.js';
import { resolveAdapter } from '../quote-workflow-analyse-selection.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../quote-workflow-synced-selection.js';
import { CENTURION_HOTEL_RULES } from '../reservationist-decision.js';
import {
  extractionPromptMaxChars,
  extractionReasoningEffort,
  extractionVisionEnabled,
} from './config.js';
import { resolveTriageEventClock } from '../triage-input.js';
import { TRIAGE_REVIEWER_VERSION } from '../triage.js';
import { ensureWorkItemForMessage, MESSAGE_ARRIVED_AT } from '../work-items.js';
import {
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunPolicyRefused,
  markAiRunRetry,
  markAiRunSucceeded,
  mailBaselineGenerationKey,
  type AiRunFence,
  type AiWorkflowRun,
} from '../run-ledger.js';
import {
  ACTION_CLASSIFICATION_RULES,
  attachmentReads,
  EXTRACTION_MAX_IMAGES,
  EXTRACTION_MAX_PDF_PAGES,
  EXTRACTION_MIN_IMAGE_BYTES,
  EXTRACTION_MODEL_ID,
  EXTRACTION_RULES,
  EXTRACTION_THREAD_MESSAGE_MAX_CHARS,
  EXTRACTION_THREAD_TOTAL_MAX_CHARS,
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
  .update(ACTION_CLASSIFICATION_RULES)
  .update('\n')
  .update(String(extractionPromptMaxChars()))
  .update('\n')
  .update(extractionReasoningEffort())
  .update('\n')
  .update(
    `vision/${extractionVisionEnabled()}/${EXTRACTION_MAX_IMAGES}/${EXTRACTION_MAX_PDF_PAGES}/${EXTRACTION_MIN_IMAGE_BYTES}/thread/${EXTRACTION_THREAD_TOTAL_MAX_CHARS}/${EXTRACTION_THREAD_MESSAGE_MAX_CHARS}`,
  )
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

/**
 * Queues the read for one inbound mail. Called inside the admission transaction (live, with its snapshot) or by the
 * backfill (no snapshot, staggered by nextRunAt). The key is the same for both, so a repeat is a no-op.
 */
export async function enqueueInboundExtraction(
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    admissionSnapshotId?: string;
    admissionSnapshotHash?: string;
    nextRunAt?: Date;
    metrics?: Record<string, unknown>;
  },
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
      admissionSnapshotId: input.admissionSnapshotId,
      admissionSnapshotHash: input.admissionSnapshotHash,
      nextRunAt: input.nextRunAt,
      metrics: input.metrics,
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

/** The worker lost its claim on the run while the read was made. Nothing the read wrote is kept. */
class InboundClaimLostError extends Error {}

type RunClaim = { runId: string; claimOwner: string; claimToken: string };

/**
 * Commits a read and what it decides (work item, spam) in one transaction. With the worker's claim the run row is
 * locked and checked first, so a worker that lost its claim writes nothing, and a crash never leaves a stored read
 * whose spam change is missing (a rerun of a stored read returns `exists`).
 */
async function commitRead(
  db: DB,
  claim: RunClaim | undefined,
  write: (tx: DB) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (claim) {
      const [owned] = await tx
        .select({ id: aiWorkflowRun.id })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.id, claim.runId),
            eq(aiWorkflowRun.claimOwner, claim.claimOwner),
            eq(aiWorkflowRun.claimToken, claim.claimToken),
            eq(aiWorkflowRun.state, 'running'),
          ),
        )
        .limit(1)
        .for('update');
      if (!owned) throw new InboundClaimLostError();
    }
    await write(tx as unknown as DB);
  });
}

/**
 * What one run did. `stored` and `failed` both write a mail_extraction row. `capped` and `disabled` write nothing
 * and defer the run. `unconfigured` dead-letters it. `stale_version` is an expected rollover refusal (superseded).
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
  /** The worker's claim. Present, the read's writes commit only while the run is still this worker's. */
  claim?: RunClaim;
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
      fromAddress: message.fromAddress,
      mailbox: mailboxTransport.email,
    })
    .from(message)
    .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
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
  if (existing) {
    await ensureWorkItemForMessage(db, { transportId: run.transportId, messageId: run.triggerMessageId });
    return 'exists';
  }
  const adapter = deps.adapter === undefined ? resolveAdapter(true, null).adapter : deps.adapter;
  if (!adapter) return 'unconfigured';
  const max = inboundExtractionMaxPerHour(env);
  const clock = deps.now ?? Date.now;
  // Checked before any mail is loaded, so a spent hour costs no S3 or PDF work.
  if (callsInLastHour(clock()) >= max) return 'capped';
  // Loaded by its row id: a header can be missing or shared by two rows ingest kept apart.
  const selection = await (deps.loadSelection ?? loadSyncedQuoteSelectionFromMailbox)({
    transportId: run.transportId,
    messageId: run.triggerMessageId,
    includeThreadState: true,
    includeVisionImages: extractionVisionEnabled(env),
    trackVisionImages: true,
    signal: deps.signal,
  });
  if (!selection) {
    await commitRead(db, deps.claim, (tx) =>
      storeRead(tx, {
        messageId: run.triggerMessageId,
        status: 'failed',
        usage: { failureReason: 'not_found' },
      }),
    );
    return 'failed';
  }
  if (!takeCallSlot(max, clock())) return 'capped';
  const extraction = await extractInboundMail({
    adapter,
    selection,
    messageId: run.triggerMessageId,
    from: trigger.fromAddress,
    mailbox: trigger.mailbox,
    signal: deps.signal,
    deadlineMs:
      deps.extractionDeadlineMs ?? lunaCallBudget(extractionReasoningEffort(env)).deadlineMs,
    env,
  });
  const attachments = extraction.attachments ?? attachmentReads(selection.attachments);
  if (!extraction.ok) {
    await commitRead(db, deps.claim, (tx) =>
      storeRead(tx, {
        messageId: run.triggerMessageId,
        status: 'failed',
        attachments,
        usage: { ...extraction.usage, failureReason: extraction.reason },
      }),
    );
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
  const spamWrites = env.AI_WRITE_GATE_ENABLED === 'true' && !isInboundTriageClassifierEnabled(env);
  await commitRead(db, deps.claim, async (tx) => {
    await storeRead(tx, {
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
    // Spam has one writer. While the classifier is on it owns spamAt and this read only records its kind, so the two
    // never race (the read could otherwise spam a thread before the classifier files it). Once it is retired, this
    // read writes spam with the classifier's guards.
    if (spamWrites) await writeSpamDecision(tx, run, trigger, extraction.kind);
    // The work item points at this read. Its person-set values stay in its state (see work-items.ts).
    await ensureWorkItemForMessage(tx, { transportId: run.transportId, messageId: run.triggerMessageId });
  });
  return 'stored';
}

/**
 * Spam for the thread comes from the read of its latest-arrived inbound only: a blocked sender sets the mark, and a spam
 * read that passes the guards sets it too. Any other read lifts the mark, except an `other` read: a later mail the model
 * calls other does not clear a spam mark. An older mail's read (the backfill runs newest first) never moves a thread a
 * newer mail decided. A person's lock keeps the thread as it is.
 */
async function writeSpamDecision(
  db: DB,
  run: Pick<AiWorkflowRun, 'transportId' | 'triggerMessageId'>,
  trigger: { threadId: string; fromAddress: string },
  kind: string,
): Promise<void> {
  // Reply import takes the thread lock before its work-item locks. Take the same
  // order and re-read the spam guards after any concurrent import commits. A
  // non-key lock still allows an approval holding an item to insert its run.
  const [thread] = await db.select({ id: mailThread.id }).from(mailThread)
    .where(and(eq(mailThread.id, trigger.threadId), eq(mailThread.transportId, run.transportId)))
    .limit(1).for('no key update');
  if (!thread) return;
  const [latest] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.threadId, trigger.threadId),
        eq(message.transportId, run.transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    // Arrival order (see messageArrivedAt), not import order or a sender's Date header. Ties: later stored, then id.
    .orderBy(desc(MESSAGE_ARRIVED_AT), desc(message.createdAt), desc(message.id))
    .limit(1);
  if (latest?.id !== run.triggerMessageId) return;
  const blocked =
    (await getSenderPreference({ db, transportId: run.transportId, emailRaw: trigger.fromAddress })) ===
    'block';
  const markSpam =
    blocked ||
    (kind === 'spam' &&
      (await spamWriteAllowed(db, run.transportId, trigger.threadId, trigger.fromAddress)));
  if (!markSpam && kind === 'other') return;
  const now = new Date();
  await db
    .update(mailThread)
    .set({ spamAt: markSpam ? now : null, updatedAt: now })
    .where(
      and(
        eq(mailThread.id, trigger.threadId),
        eq(mailThread.transportId, run.transportId),
        markSpam ? isNull(mailThread.spamAt) : isNotNull(mailThread.spamAt),
        isNull(mailThread.spamUserLockedAt),
      ),
    );
}

/**
 * The triage spam guards, so the model never moves mail that triage would keep. A person's lock (checked in the
 * update), a settled primary folder, an allowed or never-spam sender, and a thread with a staff reply all win.
 */
async function spamWriteAllowed(
  db: DB,
  transportId: string,
  threadId: string,
  fromAddress: string,
): Promise<boolean> {
  if (isAutoTriageNeverSpam(fromAddress)) return false;
  if ((await getSenderPreference({ db, transportId, emailRaw: fromAddress })) === 'allow') {
    return false;
  }
  const [settled] = await db
    .select({ threadId: mailThreadCategory.threadId })
    .from(mailThreadCategory)
    .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
    .where(
      and(
        eq(mailThreadCategory.threadId, threadId),
        eq(mailThreadCategory.transportId, transportId),
        inArray(mailCategory.slug, [...AI_DURABLE_PRIMARY_CATEGORY_SLUGS]),
      ),
    )
    .limit(1);
  if (settled) return false;
  const [staffReply] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.threadId, threadId),
        eq(message.transportId, transportId),
        eq(message.direction, 'outbound'),
      ),
    )
    .limit(1);
  return !staffReply;
}

/**
 * Worker entry for an `inbound_extraction` run. Maps the outcome onto the run's state. Once the classifier is retired,
 * the mail baseline is projected here too, after the read outcome.
 */
export async function executeInboundExtractionRun(input: {
  run: AiWorkflowRun;
  fence: AiRunFence;
  signal: AbortSignal;
  adapter?: ModelAdapter | null;
  db?: DB;
  env?: NodeJS.ProcessEnv;
  loadSelection?: InboundExtractionDeps['loadSelection'];
  /** The worker's approved local baseline route. Absent means source observations only. */
  mailBaselineRoute?: MailBaselineExtractionRoute;
}): Promise<{ runId: string; state: 'succeeded' | 'retry_wait' | 'dead_letter' }> {
  const { run, fence } = input;
  const db = input.db ?? getDb();
  const claim = {
    runId: run.id,
    claimOwner: fence.claimOwner,
    claimToken: fence.claimToken,
    expectedStates: ['running' as const],
  };
  let outcome: InboundExtractionOutcome;
  try {
    outcome = await runInboundExtraction(run, {
      db,
      env: input.env,
      adapter: input.adapter,
      loadSelection: input.loadSelection,
      signal: input.signal,
      claim,
    });
  } catch (error) {
    // Another worker owns the run now; it makes the read.
    if (error instanceof InboundClaimLostError) return { runId: run.id, state: 'retry_wait' };
    throw error;
  }
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
        // The run waits longer than its deadline, so the next claim gets a fresh one instead of dead-lettering it.
        resetDeadline: true,
      },
      db,
    );
    return { runId: run.id, state: 'retry_wait' };
  }
  // Once the classifier is retired, the inbound baseline is projected here instead of by its run. It reads the message
  // and the approved route, not the extraction model, so it runs for every outcome that is not deferred. With the
  // classifier on, its run still projects the baseline and this one stays out, so a message never gets two.
  const mailBaseline = isInboundTriageClassifierEnabled(input.env ?? process.env)
    ? null
    : await projectInboundMailBaseline(
        db,
        run,
        input.mailBaselineRoute ?? resolveMailBaselineExtractionRoute({ approvedRoute: null }),
        input.signal,
      );
  if (outcome === 'stale_version') {
    await markAiRunPolicyRefused(
      {
        ...claim,
        lastError: `inbound extraction version ${run.promptVersion} is not deployed (deployed ${EXTRACTION_VERSION})`,
      },
      db,
    );
    return { runId: run.id, state: 'dead_letter' };
  }
  if (outcome === 'unconfigured') {
    await markAiRunDeadLetter(
      {
        ...claim,
        lastError: 'inbound extraction model is not configured',
      },
      db,
    );
    return { runId: run.id, state: 'dead_letter' };
  }
  const marked = await markAiRunSucceeded(
    {
      ...claim,
      metrics: {
        inboundExtraction: { outcome },
        ...(mailBaseline ? { mailBaseline } : {}),
      },
    },
    db,
  );
  return { runId: run.id, state: marked ? 'succeeded' : 'retry_wait' };
}

export type TranslationRetry =
  | { status: 'done'; translation: InboundTranslation | null }
  | { status: 'not_found' | 'not_needed' | 'disabled' | 'unconfigured' | 'capped' };

/**
 * Translates a stored non-English read again (U16 Retry). The stored read is updated in place, so this makes one model
 * call now rather than queuing a run. It takes a slot on the same hourly cap as the extraction run, and it runs only
 * when the extraction flag is on. The translation is read from the message's text, as the extraction read it.
 */
export async function retryInboundTranslation(
  input: { transportId: string; workItemId: string },
  deps: InboundExtractionDeps = {},
): Promise<TranslationRetry> {
  const env = deps.env ?? process.env;
  const db = deps.db ?? getDb();
  const [item] = await db
    .select({ extractionId: workItem.extractionId })
    .from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1);
  if (!item?.extractionId) return { status: 'not_found' };
  if (!inboundExtractionEnabled(env)) return { status: 'disabled' };
  const [read] = await db
    .select({
      id: mailExtraction.id,
      messageId: mailExtraction.messageId,
      language: mailExtraction.language,
      usage: mailExtraction.usage,
    })
    .from(mailExtraction)
    .where(and(eq(mailExtraction.id, item.extractionId), eq(mailExtraction.status, 'succeeded')))
    .limit(1);
  if (!read) return { status: 'not_found' };
  if (!read.language || read.language === 'en') return { status: 'not_needed' };
  const [source] = await db
    .select({ textBody: message.textBody })
    .from(message)
    .where(and(eq(message.id, read.messageId), eq(message.transportId, input.transportId)))
    .limit(1);
  if (!source) return { status: 'not_found' };
  const adapter = deps.adapter === undefined ? resolveAdapter(true, null).adapter : deps.adapter;
  if (!adapter) return { status: 'unconfigured' };
  const clock = deps.now ?? Date.now;
  if (!takeCallSlot(inboundExtractionMaxPerHour(env), clock())) return { status: 'capped' };
  const done = await translateInboundBody({
    adapter,
    bodyText: source.textBody ?? '',
    sourceLanguage: read.language,
    signal: deps.signal,
    deadlineMs: deps.translationDeadlineMs ?? TRANSLATE_DEADLINE_MS,
  });
  const translation = done?.translation ?? null;
  // Two retries can overlap. One that did not succeed never replaces a translation another retry saved meanwhile.
  const [saved] = await db
    .update(mailExtraction)
    .set({
      translation,
      usage: { ...read.usage, ...(done ? { translation: done.usage } : {}) },
    })
    .where(
      and(
        eq(mailExtraction.id, read.id),
        translation?.status === 'succeeded'
          ? undefined
          : sql`coalesce(${mailExtraction.translation}->>'status', '') <> 'succeeded'`,
      ),
    )
    .returning({ id: mailExtraction.id });
  if (saved) return { status: 'done', translation };
  const [kept] = await db
    .select({ translation: mailExtraction.translation })
    .from(mailExtraction)
    .where(eq(mailExtraction.id, read.id))
    .limit(1);
  return { status: 'done', translation: (kept?.translation as InboundTranslation | null | undefined) ?? null };
}

/**
 * Mail baseline for one inbound message. It reads the message and the approved local route, never the classifier, so
 * it runs the same with INBOUND_TRIAGE_CLASSIFIER on or off. Insert-only per generation, so a retry is a no-op.
 * Returns the metrics, or null when the message is not inbound.
 */
async function projectInboundMailBaseline(
  db: DB,
  run: Pick<AiWorkflowRun, 'transportId' | 'threadId' | 'triggerMessageId' | 'createdAt'>,
  route: MailBaselineExtractionRoute,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({
      id: message.id,
      direction: message.direction,
      fromAddress: message.fromAddress,
      toAddresses: message.toAddresses,
      ccAddresses: message.ccAddresses,
      bccAddresses: message.bccAddresses,
      subject: message.subject,
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      createdAt: message.createdAt,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
      messageIdHeader: message.messageIdHeader,
      inReplyTo: message.inReplyTo,
      references: message.references,
    })
    .from(message)
    .where(and(eq(message.id, run.triggerMessageId), eq(message.transportId, run.transportId)))
    .limit(1);
  if (!row || row.direction !== 'inbound') return null;
  const clock = resolveTriageEventClock({
    id: row.id,
    from: row.fromAddress,
    subject: row.subject ?? undefined,
    body: row.textBody ?? row.htmlBody ?? '',
    direction: 'inbound',
    createdAt: row.createdAt,
    receivedAt: row.receivedAt,
    sentAt: row.sentAt,
    to: row.toAddresses ?? [],
    cc: row.ccAddresses ?? [],
    bcc: row.bccAddresses ?? [],
    messageIdHeader: row.messageIdHeader,
    inReplyTo: row.inReplyTo,
    references: row.references,
  });
  const routed = await extractMailBaselineWithApprovedRoute(
    {
      sourceVintage: run.createdAt.toISOString(),
      observationCutoff: run.createdAt,
      interpretationVersion: MAIL_BASELINE_INTERPRETATION_VERSION,
      classifierVersion: route.available
        ? 'mail-baseline-semantic-v1'
        : 'mail-baseline-observation-v1',
      reviewerVersion: TRIAGE_REVIEWER_VERSION,
      message: {
        id: row.id,
        transportId: run.transportId,
        threadId: run.threadId,
        direction: 'inbound',
        fromAddress: row.fromAddress,
        toAddresses: row.toAddresses ?? [],
        ccAddresses: row.ccAddresses ?? [],
        bccAddresses: row.bccAddresses ?? [],
        subject: row.subject ?? null,
        textBody: row.textBody ?? row.htmlBody ?? '',
        receivedAt: row.receivedAt,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
        messageIdHeader: row.messageIdHeader,
        inReplyTo: row.inReplyTo,
        references: row.references,
        source: 'mail_event',
        sourceBasis: clock.basis,
      },
    },
    route,
    { signal },
  );
  const { extraction } = routed;
  const configured = parseMailboxMeasurementConfig(process.env.MAIL_MEASUREMENT_CONFIG_JSON);
  const producerMeasurement = configured?.transportId === run.transportId ? configured : null;
  const generationId = mailBaselineGenerationKey({
    transportId: run.transportId,
    threadId: run.threadId,
    sourceMessageId: row.id,
    sourceVintage: run.createdAt.toISOString(),
    interpretationVersion: extraction.interpretationVersion,
  });
  const persisted = await persistMailBaselineProjection(db, {
    transportId: run.transportId,
    threadId: run.threadId,
    generationId,
    sourceVintage: extraction.sourceVintage,
    interpretationVersion: extraction.interpretationVersion,
    reviewerVersion: TRIAGE_REVIEWER_VERSION,
    observationCutoff: run.createdAt,
    measurementStartAt: producerMeasurement?.measurementStartAt ?? null,
    coverage: {
      configVersion: producerMeasurement ? String(producerMeasurement.version) : null,
      startAt: producerMeasurement?.measurementStartAt ?? null,
      endAt: run.createdAt.toISOString(),
      basis: producerMeasurement?.captureAssumptionBasis ?? 'coverage_unconfigured',
      complete: producerMeasurement !== null && producerMeasurement.measurementStartAt !== null,
      confirmedGapIntervals: producerMeasurement?.confirmedGapIntervals ?? [],
    },
    evidence: extraction.evidence,
  });
  return {
    status:
      routed.semanticRoute === 'approved_local_extraction'
        ? 'persisted_semantic_projection'
        : 'persisted_source_observation',
    routeStatus: route.available ? 'available' : 'unavailable',
    routeId: route.route,
    ...(route.reason ? { reason: route.reason } : {}),
    extraction: routed.semanticRoute,
    generationId,
    inserted: persisted.inserted,
    evidenceCount: extraction.evidence.length,
    ...(routed.modelUsage ? { modelUsage: routed.modelUsage } : {}),
  };
}

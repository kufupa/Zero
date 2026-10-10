import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getDb, type DB } from '../../db/client.js';
import { mailCategory, mailThread, mailThreadCategory, message } from '../../db/schema/mail.js';
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
import { canonicalInternetMessageId, resolveAdapter } from '../quote-workflow-analyse-selection.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../quote-workflow-synced-selection.js';
import { CENTURION_HOTEL_RULES } from '../reservationist-decision.js';
import { resolveTriageEventClock } from '../triage-input.js';
import { TRIAGE_REVIEWER_VERSION } from '../triage.js';
import { ensureWorkItemForMessage } from '../work-items.js';
import {
  enqueueAiRun,
  markAiRunDeadLetter,
  markAiRunRetry,
  markAiRunSucceeded,
  mailBaselineGenerationKey,
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
      fromAddress: message.fromAddress,
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
    from: trigger.fromAddress,
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
  // The work item points at this read. Its person-set values stay in its state (see work-items.ts).
  await ensureWorkItemForMessage(db, { transportId: run.transportId, messageId: run.triggerMessageId });
  // Spam has one writer. While the classifier is on it owns spamAt and this read only records its kind, so the two
  // never race (the read could otherwise spam a thread before the classifier files it). Once it is retired, this read
  // writes spam with the classifier's guards: a blocked sender goes to spam, and any other read lifts the mark.
  if (env.AI_WRITE_GATE_ENABLED === 'true' && !isInboundTriageClassifierEnabled(env)) {
    const blocked =
      (await getSenderPreference({ db, transportId: run.transportId, emailRaw: trigger.fromAddress })) ===
      'block';
    const markSpam =
      blocked ||
      (extraction.kind === 'spam' &&
        (await spamWriteAllowed(db, run.transportId, trigger.threadId, trigger.fromAddress)));
    if (markSpam) {
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
    } else {
      // Like the classifier, any read that is not spam lifts the mark ('other' covers events, venue hire and
      // invoices), and so does a spam read the guards keep out (allowed or never-spam sender, staff reply).
      await liftSpamOnLatestInbound(db, run, trigger);
    }
  }
  return 'stored';
}

/**
 * Un-spam, which the retired classifier used to do on the next mail. The thread's latest inbound read decides. A
 * person's lock keeps the mark. The caller never lifts for a blocked sender.
 */
async function liftSpamOnLatestInbound(
  db: DB,
  run: Pick<AiWorkflowRun, 'transportId' | 'triggerMessageId'>,
  trigger: { threadId: string },
): Promise<void> {
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
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1);
  if (latest?.id !== run.triggerMessageId) return;
  await db
    .update(mailThread)
    .set({ spamAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailThread.id, trigger.threadId),
        eq(mailThread.transportId, run.transportId),
        isNotNull(mailThread.spamAt),
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
  await db
    .update(mailExtraction)
    .set({
      translation,
      usage: { ...read.usage, ...(done ? { translation: done.usage } : {}) },
    })
    .where(eq(mailExtraction.id, read.id));
  return { status: 'done', translation };
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

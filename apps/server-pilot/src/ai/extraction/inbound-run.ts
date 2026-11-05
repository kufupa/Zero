import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getDb, type DB } from '../../db/client.js';
import {
  aiWorkflowRun,
  attachment,
  mailboxTransport,
  mailboxAccess,
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
import { isSelfSentPreStaySubject, preStaySourceText } from '../existing-stay-information.js';
import {
  extractMailBaselineWithApprovedRoute,
  resolveMailBaselineExtractionRoute,
  type MailBaselineExtractionRoute,
} from '../mail-baseline-extraction.js';
import { lunaCallBudget } from '../bedrock/luna.js';
import { hashSyncedQuoteSelection, resolveAdapter } from '../quote-workflow-analyse-selection.js';
import { loadSyncedQuoteSelectionFromMailbox, type SyncedQuoteSelection } from '../quote-workflow-synced-selection.js';
import { lockCanonicalMailbox } from '../../mail/ingest/canonical-identity.js';
import { hotelRulesForProperty } from '../reservationist-decision.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import {
  extractionPromptMaxChars,
  extractionReasoningEffort,
  extractionVisionEnabled,
} from './config.js';
import { resolveTriageEventClock } from '../triage-input.js';
import { TRIAGE_REVIEWER_VERSION } from '../triage.js';
import { ensureWorkItemForMessage, messageFor, MESSAGE_ARRIVED_AT } from '../work-items.js';
import type { PaneSourceSelection } from '../../mail/pane-source-selection.js';
import { failedReadFingerprint, failedReadRetryOf, type FailedReadRetry } from './retry-binding.js';
import { staffQuoteSourceHash } from '../staff-quote-workflow.js';
import {
  enqueueAiRun,
  NONTERMINAL_AI_RUN_STATES,
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
  .update(
    [hotelRulesForProperty('HRCEN'), hotelRulesForProperty('HRDAV'), hotelRulesForProperty(null)].join('\n'),
  )
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

export function inboundPropertyCodeForTransport(transportId: string): string | null {
  const resolved = resolvePropertyTransport(transportId);
  return resolved.kind === 'property' ? resolved.property.propertyCode : null;
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

export type SelectedExtractionResult =
  | { status: 'current'; extractionId: string }
  | { status: 'queued'; runId: string }
  | { status: 'blocked'; reason: 'source_changed' | 'not_amendment' | 'disabled' | 'read_failed' |
      'classification_changed' | 'relink_required' | 'run_failed' | 'deferred' };

/** Queue only the selected inbound Amendment. Reuse the normal version key and worker relink safeguards. */
export async function refreshSelectedAmendExtraction(
  db: DB,
  input: { transportId: string; workItemId: string; source: { threadId: string; messageId: string; sourceHash: string } },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SelectedExtractionResult> {
  return db.transaction(async (tx) => {
    // Match the thread -> message -> work-item lock order used by ingestion.
    const [thread] = await tx.select({ id: mailThread.id }).from(mailThread)
      .where(and(eq(mailThread.id, input.source.threadId), eq(mailThread.transportId, input.transportId),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('no key update');
    if (!thread) return { status: 'blocked', reason: 'source_changed' };
    const [mail] = await tx.select({ id: message.id, subject: message.subject, textBody: message.textBody,
      htmlBody: message.htmlBody }).from(message)
      .where(and(eq(message.id, input.source.messageId), eq(message.threadId, thread.id),
        eq(message.transportId, input.transportId), eq(message.direction, 'inbound')))
      .limit(1).for('no key update');
    if (!mail || staffQuoteSourceHash(mail) !== input.source.sourceHash) {
      return { status: 'blocked', reason: 'source_changed' };
    }
    const [item] = await tx.select({ kind: workItem.kind, extractionId: workItem.extractionId }).from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, thread.id), eq(workItem.sourceMessageId, mail.id)))
      .limit(1).for('no key update');
    if (!item) return { status: 'blocked', reason: 'source_changed' };
    if (item.kind !== 'amendment' || !item.extractionId) return { status: 'blocked', reason: 'not_amendment' };
    const [linked] = await tx.select({ id: mailExtraction.id }).from(mailExtraction)
      .where(and(eq(mailExtraction.id, item.extractionId), eq(mailExtraction.messageId, mail.id),
        eq(mailExtraction.status, 'succeeded'), eq(mailExtraction.kind, 'amendment'))).limit(1);
    if (!linked) return { status: 'blocked', reason: 'not_amendment' };
    const [current] = await tx.select({ id: mailExtraction.id, status: mailExtraction.status, kind: mailExtraction.kind })
      .from(mailExtraction).where(and(eq(mailExtraction.messageId, mail.id),
        eq(mailExtraction.extractorVersion, EXTRACTION_VERSION))).limit(1);
    if (current) {
      if (current.status !== 'succeeded') return { status: 'blocked', reason: 'read_failed' };
      if (current.kind !== 'amendment') return { status: 'blocked', reason: 'classification_changed' };
      if (current.id !== item.extractionId) return { status: 'blocked', reason: 'relink_required' };
      return { status: 'current', extractionId: current.id };
    }
    if (!inboundExtractionEnabled(env)) return { status: 'blocked', reason: 'disabled' };
    const run = await enqueueInboundExtraction({ transportId: input.transportId, threadId: thread.id, messageId: mail.id },
      tx as unknown as DB);
    if (run.state === 'retry_wait' && run.failureClass === 'POLICY_BLOCK') {
      return { status: 'blocked', reason: 'deferred' };
    }
    if (!['queued', 'claimed', 'running', 'retry_wait'].includes(run.state)) {
      return { status: 'blocked', reason: 'run_failed' };
    }
    return { status: 'queued', runId: run.id };
  });
}

const MAX_FAILED_READ_HISTORY = 10;

function retrySelectionHash(selection: SyncedQuoteSelection, mailboxAddress: string | null): string {
  return createHash('sha256').update(hashSyncedQuoteSelection(selection))
    .update(JSON.stringify([selection.fromAddress ?? null, mailboxAddress, selection.threadReferenceAt ?? null,
      selection.threadMessages ?? []])).digest('hex');
}

async function retryAttachmentHash(db: DB, messageId: string): Promise<string> {
  const files = await db.select({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, s3Key: attachment.s3Key, isInline: attachment.isInline })
    .from(attachment).where(eq(attachment.messageId, messageId)).orderBy(attachment.id);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

/** Queue an explicit, source-bound retry. The selected mail and failed observation are rechecked under locks. */
export async function retrySelectedFailedRead(db: DB, input: {
  transportId: string; actorId: string; internetMessageId: string; selection: PaneSourceSelection;
  extractionId: string; extractorVersion: string; fingerprint: string;
  source: { threadId: string; messageId: string; sourceHash: string };
}) {
  if (!inboundExtractionEnabled()) return { status: 'blocked' as const };
  const selected = await messageFor(db, { ...input, expectedMessageId: input.source.messageId });
  if (!selected || selected.threadId !== input.source.threadId || staffQuoteSourceHash(selected) !== input.source.sourceHash) {
    return { status: 'blocked' as const };
  }
  const source = await loadSyncedQuoteSelectionFromMailbox({ transportId: input.transportId, messageId: selected.id,
    includeThreadState: true, includeVisionImages: extractionVisionEnabled(), trackVisionImages: true });
  if (!source) return { status: 'blocked' as const };
  const selectionHash = retrySelectionHash(source, selected.mailboxAddress);
  const attachmentHash = await retryAttachmentHash(db, selected.id);
  return db.transaction(async (tx) => {
    await lockCanonicalMailbox(tx as unknown as DB, input.transportId);
    const [thread] = await tx.select({ id: mailThread.id }).from(mailThread).where(and(
      eq(mailThread.id, selected.threadId), eq(mailThread.transportId, input.transportId), eq(mailThread.historyOnly, false),
      isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('no key update');
    if (!thread) return { status: 'blocked' as const };
    const selectedAgain = await messageFor(tx as unknown as DB, { ...input, expectedMessageId: selected.id });
    if (!selectedAgain || selectedAgain.threadId !== thread.id || selectedAgain.fromAddress !== selected.fromAddress ||
        selectedAgain.mailboxAddress !== selected.mailboxAddress) return { status: 'blocked' as const };
    const [mail] = await tx.select({ id: message.id, subject: message.subject, textBody: message.textBody,
      htmlBody: message.htmlBody }).from(message).where(and(eq(message.id, selected.id),
      eq(message.threadId, thread.id), eq(message.transportId, input.transportId), eq(message.historyOnly, false), eq(message.direction, 'inbound')))
      .limit(1).for('no key update');
    if (!mail || staffQuoteSourceHash(mail) !== input.source.sourceHash ||
        await retryAttachmentHash(tx as unknown as DB, mail.id) !== attachmentHash) return { status: 'blocked' as const };
    const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
      eq(mailboxAccess.userId, input.actorId), eq(mailboxAccess.transportId, input.transportId))).limit(1).for('share');
    if (!access) return { status: 'blocked' as const };
    const [read] = await tx.select().from(mailExtraction).where(and(eq(mailExtraction.id, input.extractionId),
      eq(mailExtraction.messageId, mail.id), eq(mailExtraction.extractorVersion, input.extractorVersion)))
      .limit(1).for('update');
    if (!read || read.status !== 'failed' || failedReadFingerprint(read) !== input.fingerprint) return { status: 'blocked' as const };
    const history = read.usage?.retryHistory;
    if (history !== undefined && !Array.isArray(history)) return { status: 'blocked' as const };
    if (Array.isArray(history) && history.length >= MAX_FAILED_READ_HISTORY) return { status: 'blocked' as const };
    // Existing drafts or another succeeded read require review; do not relink staff work to a new model result.
    const [item] = await tx.select({ id: workItem.id }).from(workItem).where(and(
      eq(workItem.transportId, input.transportId), eq(workItem.sourceMessageId, mail.id))).limit(1);
    const [success] = await tx.select({ id: mailExtraction.id }).from(mailExtraction).where(and(
      eq(mailExtraction.messageId, mail.id), eq(mailExtraction.status, 'succeeded'))).limit(1);
    if (item || success) return { status: 'blocked' as const };
    if (input.extractorVersion !== EXTRACTION_VERSION) {
      const [current] = await tx.select({ id: mailExtraction.id }).from(mailExtraction).where(and(
        eq(mailExtraction.messageId, mail.id), eq(mailExtraction.extractorVersion, EXTRACTION_VERSION))).limit(1);
      if (current) return { status: 'blocked' as const };
    }
    const [active] = await tx.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun).where(and(
      eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.triggerMessageId, mail.id),
      eq(aiWorkflowRun.runKind, 'inbound_extraction'), inArray(aiWorkflowRun.state, NONTERMINAL_AI_RUN_STATES),
      sql`${aiWorkflowRun.metrics}->'failedReadRetry'->>'failedId' = ${read.id}`,
      sql`${aiWorkflowRun.metrics}->'failedReadRetry'->>'fingerprint' = ${input.fingerprint}`)).limit(1);
    if (active) return { status: 'queued' as const, runId: active.id };
    const [otherActive] = await tx.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun).where(and(
      eq(aiWorkflowRun.transportId, input.transportId), eq(aiWorkflowRun.triggerMessageId, mail.id),
      eq(aiWorkflowRun.runKind, 'inbound_extraction'), eq(aiWorkflowRun.promptVersion, EXTRACTION_VERSION),
      inArray(aiWorkflowRun.state, NONTERMINAL_AI_RUN_STATES))).limit(1);
    if (otherActive) return { status: 'blocked' as const };
    const binding: FailedReadRetry = { failedId: read.id, extractorVersion: read.extractorVersion, fingerprint: input.fingerprint,
      sourceHash: input.source.sourceHash, selectionHash, attachmentHash, actorId: input.actorId,
      internetMessageId: input.internetMessageId, selection: input.selection };
    const run = await enqueueAiRun({ transportId: input.transportId, threadId: thread.id, triggerMessageId: mail.id,
      runKind: 'inbound_extraction', idempotencyKey: `inbound-extraction-retry:${read.id}:${randomUUID()}`,
      modelId: EXTRACTION_MODEL_ID, promptVersion: EXTRACTION_VERSION, metrics: { failedReadRetry: binding } }, tx as unknown as DB);
    return { status: 'queued' as const, runId: run.id };
  });
}

export async function failedReadRetryStatus(db: DB, input: {
  transportId: string; internetMessageId: string; selection: PaneSourceSelection; runId: string; extractionId: string;
}) {
  const selected = await messageFor(db, input);
  if (!selected) return { status: 'blocked' as const };
  const [run] = await db.select({ state: aiWorkflowRun.state, metrics: aiWorkflowRun.metrics }).from(aiWorkflowRun)
    .where(and(eq(aiWorkflowRun.id, input.runId), eq(aiWorkflowRun.transportId, input.transportId),
      eq(aiWorkflowRun.triggerMessageId, selected.id), eq(aiWorkflowRun.runKind, 'inbound_extraction'))).limit(1);
  const binding = failedReadRetryOf(run?.metrics);
  if (!run || binding?.failedId !== input.extractionId) return { status: 'blocked' as const };
  return { status: NONTERMINAL_AI_RUN_STATES.includes(run.state as typeof NONTERMINAL_AI_RUN_STATES[number])
    ? 'reading' as const : 'finished' as const };
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
  | 'capped'
  | 'stale_source';

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
  run: Pick<AiWorkflowRun, 'transportId' | 'triggerMessageId' | 'promptVersion'> & Partial<Pick<AiWorkflowRun, 'metrics'>>,
  deps: InboundExtractionDeps = {},
): Promise<InboundExtractionOutcome> {
  const env = deps.env ?? process.env;
  if (!inboundExtractionEnabled(env)) return 'disabled';
  if (run.promptVersion !== EXTRACTION_VERSION) return 'stale_version';
  const db = deps.db ?? getDb();
  const [trigger] = await db
    .select({
      id: message.id,
      threadId: message.threadId,
      textBody: message.textBody,
      direction: message.direction,
      fromAddress: message.fromAddress,
      subject: message.subject,
      htmlBody: message.htmlBody,
      mailbox: mailboxTransport.email,
    })
    .from(message)
    .leftJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(and(eq(message.id, run.triggerMessageId), eq(message.transportId, run.transportId)))
    .limit(1);
  if (!trigger || trigger.direction !== 'inbound') return 'skipped';
  const retry = failedReadRetryOf(run.metrics);
  const retryRequested = Boolean(run.metrics && Object.hasOwn(run.metrics, 'failedReadRetry'));
  if ((retryRequested && !retry) || (retry && !deps.claim)) return 'stale_source';
  if (retry) {
    const [access] = await db.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
      eq(mailboxAccess.userId, retry.actorId), eq(mailboxAccess.transportId, run.transportId))).limit(1);
    const selected = await messageFor(db, { transportId: run.transportId, internetMessageId: retry.internetMessageId,
      selection: retry.selection, expectedMessageId: run.triggerMessageId });
    if (!access || !selected || selected.threadId !== trigger.threadId || staffQuoteSourceHash(trigger) !== retry.sourceHash) return 'stale_source';
  }
  const [existing] = await db
    .select()
    .from(mailExtraction)
    .where(
      and(
        eq(mailExtraction.messageId, run.triggerMessageId),
        eq(mailExtraction.extractorVersion, EXTRACTION_VERSION),
      ),
    )
    .limit(1);
  if (retry) {
    const [failed] = retry.extractorVersion === EXTRACTION_VERSION ? [existing] : await db.select().from(mailExtraction)
      .where(and(eq(mailExtraction.id, retry.failedId), eq(mailExtraction.messageId, run.triggerMessageId),
        eq(mailExtraction.extractorVersion, retry.extractorVersion))).limit(1);
    if (!failed || failed.id !== retry.failedId || failed.status !== 'failed' ||
        failedReadFingerprint(failed) !== retry.fingerprint ||
        (retry.extractorVersion !== EXTRACTION_VERSION && existing)) return 'stale_source';
  }
  if (existing && !retry) {
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
  const loadedSelection = await (deps.loadSelection ?? loadSyncedQuoteSelectionFromMailbox)({
    transportId: run.transportId,
    messageId: run.triggerMessageId,
    includeThreadState: true,
    includeVisionImages: extractionVisionEnabled(env),
    trackVisionImages: true,
    signal: deps.signal,
  });
  if (retry && (!loadedSelection || retrySelectionHash(loadedSelection, trigger.mailbox) !== retry.selectionHash ||
      await retryAttachmentHash(db, run.triggerMessageId) !== retry.attachmentHash)) return 'stale_source';
  if (!loadedSelection) {
    await commitRead(db, deps.claim, (tx) =>
      storeRead(tx, {
        messageId: run.triggerMessageId,
        status: 'failed',
        usage: { failureReason: 'not_found' },
      }),
    );
    return 'failed';
  }
  const selection = isSelfSentPreStaySubject({
    fromAddress: trigger.fromAddress, mailboxAddress: trigger.mailbox, subject: trigger.subject,
  })
    ? { ...loadedSelection, bodyText: loadedSelection.currentBodyText ?? preStaySourceText(loadedSelection.bodyText, trigger.htmlBody) }
    : loadedSelection;
  if (!takeCallSlot(max, clock())) return 'capped';
  const extraction = await extractInboundMail({
    adapter,
    selection,
    messageId: run.triggerMessageId,
    from: trigger.fromAddress,
    mailbox: trigger.mailbox,
    propertyCode: inboundPropertyCodeForTransport(run.transportId),
    signal: deps.signal,
    deadlineMs:
      deps.extractionDeadlineMs ?? lunaCallBudget(extractionReasoningEffort(env)).deadlineMs,
    env,
  });
  const attachments = extraction.attachments ?? attachmentReads(selection.attachments);
  // Retry results can only replace the exact failed observation while the source still matches.
  const commit = async (row: ExtractionRowInput, after?: (tx: DB) => Promise<void>): Promise<boolean> => {
    if (!retry) {
      await commitRead(db, deps.claim, async (tx) => {
        // Successful normal reads also move the thread and work items. Lock the thread before the
        // insert, as retries do, so a concurrent current-version insert cannot invert this order.
        if (row.status === 'succeeded') {
          await lockCanonicalMailbox(tx, run.transportId);
          await tx.select({ id: mailThread.id }).from(mailThread).where(and(
            eq(mailThread.id, trigger.threadId), eq(mailThread.transportId, run.transportId)))
            .limit(1).for('no key update');
        }
        await storeRead(tx, row);
        await after?.(tx);
      });
      return true;
    }
    let written = false;
    await commitRead(db, deps.claim, async (tx) => {
      await lockCanonicalMailbox(tx, run.transportId);
      const [thread] = await tx.select({ id: mailThread.id }).from(mailThread).where(and(
        eq(mailThread.id, trigger.threadId), eq(mailThread.transportId, run.transportId), eq(mailThread.historyOnly, false),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1).for('no key update');
      if (!thread) return;
      const selected = await messageFor(tx, { transportId: run.transportId, internetMessageId: retry.internetMessageId,
        selection: retry.selection, expectedMessageId: run.triggerMessageId });
      if (!selected || selected.threadId !== thread.id) return;
      const [mailbox] = await tx.select({ email: mailboxTransport.email }).from(mailboxTransport)
        .where(eq(mailboxTransport.id, run.transportId)).limit(1).for('share');
      if (!mailbox) return;
      // Canonical ingest holds the same mailbox lock. Reload the bounded source while it is held,
      // so attachment or thread changes cannot race the final comparison and update.
      const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
      const currentSelection = await (deps.loadSelection ?? loadSyncedQuoteSelectionFromMailbox)({
        transportId: run.transportId, messageId: run.triggerMessageId, includeThreadState: true,
        includeVisionImages: extractionVisionEnabled(env), trackVisionImages: true, signal, db: tx,
      });
      if (!currentSelection || retrySelectionHash(currentSelection, mailbox.email) !== retry.selectionHash) return;
      const [mail] = await tx.select({ id: message.id, subject: message.subject, textBody: message.textBody,
        htmlBody: message.htmlBody }).from(message).where(and(eq(message.id, run.triggerMessageId),
        eq(message.threadId, thread.id), eq(message.transportId, run.transportId), eq(message.historyOnly, false), eq(message.direction, 'inbound')))
        .limit(1).for('no key update');
      if (!mail || staffQuoteSourceHash(mail) !== retry.sourceHash ||
          await retryAttachmentHash(tx, mail.id) !== retry.attachmentHash) return;
      const [read] = await tx.select().from(mailExtraction).where(and(eq(mailExtraction.id, retry.failedId),
        eq(mailExtraction.messageId, mail.id), eq(mailExtraction.extractorVersion, retry.extractorVersion)))
        .limit(1).for('update');
      if (!read || read.status !== 'failed' || failedReadFingerprint(read) !== retry.fingerprint) return;
      const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
        eq(mailboxAccess.userId, retry.actorId), eq(mailboxAccess.transportId, run.transportId))).limit(1).for('share');
      const [item] = await tx.select({ id: workItem.id }).from(workItem).where(and(
        eq(workItem.transportId, run.transportId), eq(workItem.sourceMessageId, mail.id))).limit(1);
      const [success] = await tx.select({ id: mailExtraction.id }).from(mailExtraction).where(and(
        eq(mailExtraction.messageId, mail.id), eq(mailExtraction.status, 'succeeded'))).limit(1);
      const rawHistory = read.usage?.retryHistory;
      if (rawHistory !== undefined && !Array.isArray(rawHistory)) return;
      const history = Array.isArray(rawHistory) ? rawHistory : [];
      if (!access || item || success || history.length >= MAX_FAILED_READ_HISTORY) return;
      const { retryHistory: _previous, ...priorUsage } = read.usage ?? {};
      const prior = { extractionId: read.id, extractorVersion: read.extractorVersion, retryRunId: deps.claim!.runId,
        actorId: retry.actorId, usage: priorUsage, attachments: read.attachments, observedAt: new Date().toISOString() };
      const value = { ...row, usage: { ...row.usage, retryHistory: [...history, prior] } };
      if (retry.extractorVersion === EXTRACTION_VERSION) {
        await tx.update(mailExtraction).set(value).where(and(eq(mailExtraction.id, read.id), eq(mailExtraction.status, 'failed')));
      } else {
        // A different deployed extractor gets its own genuine result; the old failure stays intact.
        const [inserted] = await tx.insert(mailExtraction).values({ ...value, extractorVersion: EXTRACTION_VERSION })
          .onConflictDoNothing({ target: [mailExtraction.messageId, mailExtraction.extractorVersion] }).returning({ id: mailExtraction.id });
        if (!inserted) return;
      }
      await after?.(tx);
      written = true;
    });
    return written;
  };
  if (!extraction.ok) {
    const saved = await commit({ messageId: run.triggerMessageId, status: 'failed', attachments,
      usage: { ...extraction.usage, failureReason: extraction.reason } });
    return saved ? 'failed' : 'stale_source';
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
  const saved = await commit({
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
    }, async (tx) => {
    // Spam has one writer. While the classifier is on it owns spamAt and this read only records its kind, so the two
    // never race (the read could otherwise spam a thread before the classifier files it). Once it is retired, this
    // read writes spam with the classifier's guards.
    if (spamWrites) await writeSpamDecision(tx, run, trigger, extraction.kind);
    // The work item points at this read. Its person-set values stay in its state (see work-items.ts).
    await ensureWorkItemForMessage(tx, { transportId: run.transportId, messageId: run.triggerMessageId });
  });
  return saved ? 'stored' : 'stale_source';
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
  const mailBaseline = failedReadRetryOf(run.metrics) || isInboundTriageClassifierEnabled(input.env ?? process.env)
    ? null
    : await projectInboundMailBaseline(
        db,
        run,
        input.mailBaselineRoute ?? resolveMailBaselineExtractionRoute({ approvedRoute: null }),
        input.signal,
      );
  if (outcome === 'stale_version') {
    if (run.metrics && Object.hasOwn(run.metrics, 'failedReadRetry')) {
      await markAiRunPolicyRefused({ ...claim, lastError: 'Retry no longer matches the deployed extractor.' }, db);
      return { runId: run.id, state: 'dead_letter' };
    }
    // A deploy can leave admitted mail queued against the previous prompt.
    // Queue the current version before retiring that run, preserving its source snapshot.
    // The extraction idempotency key makes concurrent rollovers harmless.
    await enqueueInboundExtraction({
      transportId: run.transportId,
      threadId: run.threadId,
      messageId: run.triggerMessageId,
      ...(run.admissionSnapshotId ? { admissionSnapshotId: run.admissionSnapshotId } : {}),
      ...(run.admissionSnapshotHash ? { admissionSnapshotHash: run.admissionSnapshotHash } : {}),
      ...(run.metrics ? { metrics: run.metrics } : {}),
    }, db);
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
        ...(failedReadRetryOf(run.metrics) ? { failedReadRetry: failedReadRetryOf(run.metrics) } : {}),
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

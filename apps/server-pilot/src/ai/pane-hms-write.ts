import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, attachment, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  readAuthorizedArtifactBytes,
  type AttachmentLocator,
} from '../mail/artifacts/read-artifact.js';
import { getS3Storage } from '../storage/s3.js';
import { canonicalJson } from './draft-approval.js';
import {
  assertHmsUnchangedBeforeSave,
  consumeHmsWriteApproval,
  endHmsWriteRun,
  HmsApprovalError,
  type HmsPreSaveOutcome,
  recordHmsWriteEvidence,
  storeHmsSnapshot,
} from './hms-approval.js';
import {
  checkCancelInput,
  paneStayCancelLoaders,
  spawnPaneStayCancel,
  type PaneStayCancelSpawnInput,
  type PaneStayCancelSpawnResult,
} from './pane-stay-cancel.js';
import { paneStayAmendMode } from './pane-stay-amend.js';
import {
  assertLabStayGuard,
  PANE_SCREENSHOT_NAME_PATTERN,
  paneStayClock,
  paneStayPropertyLock,
  paneStayTransportIdFromOwner,
  pruneExpiredPaneRuns,
  recordPanePreview,
  registerPaneRun,
  takePanePreview,
  type PaneStayLock,
} from './pane-stay-save.js';
import { classifyAmendPayment, findStay, type PaneStayFields } from './pane-stay-lookup.js';
import { paneStayHmsTargetForTransport, paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import {
  heartbeatAiRun,
  markAiRunRunning,
  markAiRunSucceeded,
  type AiFailureClass,
  type AiRunFence,
} from './run-ledger.js';

/**
 * Write runner for the pane's HMS actions on our own Labtest booking (U26): attach a document, cancel a stay, or amend it.
 * Every write goes through the U25 approval gate. Policy is checked before the grant is consumed.
 * The consume, the stay read, the identity check and the pre-Save check all run under the property lock. Only then
 * does a CLI run send anything to HMS.
 */

const execFileAsync = promisify(execFile);
const ATTACH_DOCUMENT = fileURLToPath(
  new URL('../../tooling/playwright-quote/attach-document.mjs', import.meta.url),
);
const AMEND_STAY = fileURLToPath(
  new URL('../../tooling/playwright-quote/amend-stay.mjs', import.meta.url),
);
const ATTACH_TIMEOUT_MS = 10 * 60_000;
const READ_ATTACHMENT_TIMEOUT_MS = 60_000;
/** Attach reads the bytes through the read path, so the cap is the read path's cap. A test pins the equality. */
export const PANE_ATTACH_MAX_BYTES = ARTIFACT_MAX_INPUT_BYTES;
const PDF_MAGIC = Buffer.from('%PDF-');
/** Keeps the claim fresh while a CLI run holds the lock. */
const HEARTBEAT_MS = 30_000;
const EVIDENCE_NAMES = ['before.png', 'after.png'] as const;
/** The caller already holds the property lock, so findStay's own acquisition is passed through. */
const HELD_LOCK: PaneStayLock = { withLock: (fn) => fn() };

/**
 * Attach stays on this existing Labtest-only gate. Create/amend/cancel flags never open it.
 * SAVE must be exactly lab; SAVE=on and PANE_WRITE_CREATE=on both leave attach off.
 */
export function paneHmsWriteMode(env: NodeJS.Dict<string> = process.env): 'off' | 'lab' {
  return env.RESERVATIONIST_PANE_SAVE === 'lab' ? 'lab' : 'off';
}

const CONFIRMATION = /^\d+-\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A .pdf name with no path separator and no control character. Matches attach-document.mjs. */
function isPdfDocumentName(name: string): boolean {
  if (name.length === 0 || name.length > 120 || /[\\/]/.test(name) || !/\.pdf$/i.test(name)) {
    return false;
  }
  return [...name].every((char) => char.charCodeAt(0) >= 0x20);
}

const attachFormSchema = z.object({
  action: z.literal('attach_document'),
  confirmation: z.string().regex(CONFIRMATION),
  arrival: z.string().regex(ISO_DATE),
  lastName: z.string().trim().min(1).max(100),
  attachmentId: z.string().min(1).max(200),
  documentName: z.string().max(120).refine(isPdfDocumentName),
});

const cancelFormSchema = z.object({
  action: z.literal('cancel'),
  confirmation: z.string().regex(CONFIRMATION),
  arrival: z.string().regex(ISO_DATE),
  lastName: z.string().trim().min(1).max(100),
  reason: z.string().max(200),
});

export const amendFieldsSchema = z.object({
  arrival: z.string().regex(ISO_DATE).optional(), departure: z.string().regex(ISO_DATE).optional(),
  adults: z.number().int().min(1).max(16).optional(), children: z.number().int().min(0).max(16).optional(),
  roomType: z.enum(['STQN', 'STWN', 'SKNG', 'EXKNG', 'LUXKNG', 'SUITE', 'DLXKNG', 'DLXQN', 'DLXTWN']).optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0)
  .refine((fields) => !fields.arrival || fields.arrival >= '2027-01-01')
  .refine((fields) => !fields.arrival || !fields.departure || fields.departure > fields.arrival);

const amendFormSchema = z.object({
  action: z.literal('amend'), confirmation: z.string().regex(CONFIRMATION), arrival: z.string().regex(ISO_DATE),
  lastName: z.string().trim().min(1).max(100), fields: amendFieldsSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const hmsWriteFormSchema = z.discriminatedUnion('action', [attachFormSchema, cancelFormSchema, amendFormSchema]);
export type AttachForm = z.infer<typeof attachFormSchema>;
export type CancelForm = z.infer<typeof cancelFormSchema>;
export type AmendForm = z.infer<typeof amendFormSchema>;
export type HmsWriteForm = AttachForm | CancelForm | AmendForm;

/** The approved form is the work item's state. The schema ignores the snapshot key the reader writes. */
export function parseHmsWriteForm(state: Record<string, unknown>): HmsWriteForm | null {
  const parsed = hmsWriteFormSchema.safeParse(state);
  return parsed.success ? parsed.data : null;
}

function squash(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Policy before any consume or HMS read: the input shape and arrival floor, Labtest, a reason for cancel. */
function formRefusal(form: HmsWriteForm): string | null {
  const shape = checkCancelInput({ confirmation: form.confirmation, arrival: form.arrival });
  if (shape) return shape;
  if (!/^labtest$/i.test(form.lastName)) return 'refused_not_lab';
  if (form.action === 'attach_document') return null;
  if (form.action === 'amend') return form.fields.arrival && form.fields.arrival < '2027-01-01' ? 'refused_not_lab' : null;
  const reason = squash(form.reason);
  return reason && !reason.startsWith('-') ? null : 'refused_reason_missing';
}

/** The stay HMS shows must be the one the form names, with the same arrival, and must pass the Labtest guard. */
function stayRefusal(stay: PaneStayFields, form: { confirmation: string; arrival: string }): string | null {
  if (stay.confirmation?.trim() !== form.confirmation) return 'identity_mismatch';
  if (stay.arrival !== form.arrival) return 'arrival_mismatch';
  try {
    assertLabStayGuard({ lastName: stay.lastName ?? '', arrival: stay.arrival ?? '' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'identity_refused';
  }
}

type AttachmentReadInput = { transportId: string; sourceMessageId: string; attachmentId: string };

/** The attachment the form names, when it belongs to the item's source message. Otherwise a refusal code. */
async function readApprovedAttachment(
  db: DB,
  input: AttachmentReadInput,
): Promise<Buffer | string> {
  const resolveLocator = async (attachmentId: string): Promise<AttachmentLocator | null> => {
    const [row] = await db
      .select({
        messageId: attachment.messageId,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        s3Key: attachment.s3Key,
      })
      .from(attachment)
      .innerJoin(message, eq(message.id, attachment.messageId))
      .where(and(eq(attachment.id, attachmentId), eq(message.transportId, input.transportId)))
      .limit(1);
    if (!row || row.messageId !== input.sourceMessageId) return null;
    return {
      s3Key: row.s3Key,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      messageId: row.messageId,
      sha256: row.sha256,
    };
  };
  const stored = await readAuthorizedArtifactBytes({
    attachmentId: input.attachmentId,
    authorizedAttachmentIds: new Set([input.attachmentId]),
    s3: getS3Storage(),
    signal: AbortSignal.timeout(READ_ATTACHMENT_TIMEOUT_MS),
    resolveLocator,
  });
  return stored ? stored.body : 'attachment_not_found';
}

/** Only %PDF- bytes within the read path's cap are uploaded, whichever reader supplied them. */
function pdfRefusal(body: Buffer): string | null {
  if (body.byteLength === 0 || body.byteLength > PANE_ATTACH_MAX_BYTES) return 'attachment_size_invalid';
  return body.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC) ? null : 'attachment_not_pdf';
}

export type PaneHmsPrepareResult =
  | { status: 'stored'; readAt: string; stay: PaneStayFields }
  | { status: 'refused'; reason: string };

/**
 * Prepare step. One short HMS read under the property lock, released before the snapshot is stored, then the U25
 * snapshot write. Approval never reads HMS, so the work-item row lock is not held during a read.
 */
export async function prepareHmsWriteSnapshot(input: {
  db?: DB;
  transportId: string;
  workItemId: string;
  confirmation: string;
  arrival: string;
  env?: NodeJS.Dict<string>;
}): Promise<PaneHmsPrepareResult> {
  if (paneHmsWriteMode(input.env) === 'off') return { status: 'refused', reason: 'refused_flag_off' };
  const shape = checkCancelInput({ confirmation: input.confirmation, arrival: input.arrival });
  if (shape) return { status: 'refused', reason: shape };
  const resolved = paneStayHmsTargetForTransport(input.transportId);
  if (!resolved.ok) return { status: 'refused', reason: 'refused_unknown_transport' };
  const target = resolved.target;
  const readAt = new Date();
  const lookupDirs: string[] = [];
  const found = await findStay(
    { confirmation: input.confirmation, arrival: input.arrival },
    {
      lock: () => paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target),
      onRun: ({ dir }) => lookupDirs.push(dir),
      target,
    },
  ).finally(() => removeDirs(lookupDirs));
  if (found.outcome !== 'found' || !found.stay) return { status: 'refused', reason: found.outcome };
  const refusal = stayRefusal(found.stay, input);
  if (refusal) return { status: 'refused', reason: refusal };
  const stay = found.stay;
  await storeHmsSnapshot({
    db: input.db,
    transportId: input.transportId,
    workItemId: input.workItemId,
    readHmsState: async () => stay,
    now: readAt,
  });
  return { status: 'stored', readAt: readAt.toISOString(), stay };
}

/** Fixed Labtest amend fields; selector writability and Save behavior remain TODO-LIVE-PROBE. */
export const AMEND_FIELDS = ['arrival', 'departure', 'roomType', 'adults', 'children'] as const;
export type AmendField = (typeof AMEND_FIELDS)[number];
export type AmendRequest = Partial<Record<AmendField, string | number>>;

export function paneAmendPreviewDigest(input: {
  confirmation: string;
  expectedLastName: string;
  current: PaneStayFields;
  fields: AmendRequest;
}): string {
  const current = Object.fromEntries((['confirmation', 'lastName', 'status', 'arrival', 'departure', 'adults', 'children', 'roomType'] as const)
    .map((key) => [key, input.current[key]]));
  return createHash('sha256').update(canonicalJson({ version: 1, action: 'amend', ...input, current })).digest('hex');
}

export type PaneAmendPrepareResult =
  | {
      status: 'stored';
      readAt: string;
      current: Record<AmendField, string | number | null>;
      expectedLastName: string;
      requested: AmendRequest;
      fields: AmendRequest;
      changes: AmendField[];
      previewDigest: string;
    }
  | { status: 'refused'; reason: string };

/** Amend prepare: the current record beside the requested values. Nothing is saved. The snapshot is stored for approval. */
export async function prepareAmend(
  input: Parameters<typeof prepareHmsWriteSnapshot>[0] & { requested: AmendRequest },
): Promise<PaneAmendPrepareResult> {
  const prepared = await prepareHmsWriteSnapshot(input);
  if (prepared.status === 'refused') return prepared;
  const current = Object.fromEntries(AMEND_FIELDS.map((field) => [field, prepared.stay[field]])) as Record<AmendField, string | number | null>;
  const changes = AMEND_FIELDS.filter((field) => input.requested[field] !== undefined && String(input.requested[field]) !== String(current[field] ?? ''));
  const fields = Object.fromEntries(changes.map((field) => [field, input.requested[field]])) as AmendRequest;
  const expectedLastName = prepared.stay.lastName ?? '';
  const previewDigest = paneAmendPreviewDigest({ confirmation: input.confirmation, expectedLastName, current: prepared.stay, fields });
  return { status: 'stored', readAt: prepared.readAt, current, expectedLastName, requested: input.requested, fields, changes, previewDigest };
}

export type PaneAttachSpawnInput = {
  confirmation: string;
  arrival: string;
  file: string;
  documentName: string;
  target?: HmsReadTarget;
};

export type PaneAttachSpawnResult = {
  outcome: string;
  /** True once the upload request left the browser. A failure after that leaves the upload unconfirmed. */
  uploadSent: boolean;
  /** PNG names or absolute paths, as the CLI reports them. */
  screenshots: string[];
  /** Absolute directory the CLI wrote result.json and the PNGs to. */
  runDir?: string;
};

export type PaneAmendSpawnInput = {
  confirmation: string;
  /** The stay's arrival in HMS now, so the find moves the calendar window to it. */
  currentArrival: string;
  expectedLastName: string;
  fields: AmendRequest;
  previewDigest?: string;
  mode?: 'preview' | 'commit';
  target?: HmsReadTarget;
};

export type PaneAmendSpawnResult = {
  outcome: string;
  saveAttempted: boolean;
  screenshots: string[];
  runDir?: string;
  previewDigest?: string | null;
  changedFieldsReadback?: Record<string, unknown> | null;
};

export const paneHmsWriteLoaders: {
  lock: PaneStayLock | null;
  spawnAttach: ((input: PaneAttachSpawnInput) => Promise<PaneAttachSpawnResult>) | null;
  spawnAmend: ((input: PaneAmendSpawnInput) => Promise<PaneAmendSpawnResult>) | null;
  /**
   * Replaces the attachment read. Only the ops entry for the U28-H2 live test sets it (src/ops/hms-attach-once.ts), to
   * upload a local test PDF. The PDF and size checks still run on what it returns.
   */
  readAttachment: ((input: AttachmentReadInput) => Promise<Buffer | string>) | null;
} = {
  lock: null,
  spawnAttach: null,
  spawnAmend: null,
  readAttachment: null,
};

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

function buildAttachDocumentArgs(input: PaneAttachSpawnInput, outDir: string): string[] {
  return [
    ATTACH_DOCUMENT,
    '--confirmation',
    input.confirmation,
    '--arrival',
    input.arrival,
    '--file',
    input.file,
    '--document-name',
    input.documentName,
    '--out',
    outDir,
  ];
}

/**
 * The pane CLI env, plus ATTACH_VERIFIED=true only when this process has it. The worker never sets it. The U28-H2 ops
 * run sets it for its own process, which arms the driver for that one run.
 */
function attachSpawnEnv(target: HmsReadTarget, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = paneStaySpawnEnv(env, undefined, target);
  if (env.ATTACH_VERIFIED === 'true') out.ATTACH_VERIFIED = 'true';
  return out;
}

/** Runs attach-document.mjs. A refusal or failure still writes result.json, and that is read first. */
export async function spawnAttachDocument(input: PaneAttachSpawnInput): Promise<PaneAttachSpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-attach-'));
  let runError: unknown = null;
  try {
    if (!input.target) throw new Error('pane_stay_target_required');
    await execFileAsync('node', buildAttachDocumentArgs(input, dir), {
      timeout: ATTACH_TIMEOUT_MS,
      env: attachSpawnEnv(input.target),
    });
  } catch (error) {
    runError = error;
  }
  let result: {
    outcome?: string;
    uploadSent?: boolean;
    screenshots?: string[];
    blocked?: { method: string; path: string; code: string }[];
  };
  try {
    result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as typeof result;
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw runError ?? new Error('pane_attach_no_result');
  }
  const outcome = result.outcome ?? 'execution_failure';
  if (outcome === 'execution_failure') {
    warnPaneStaySpawnFailed('attach', runError ?? new Error('pane_attach_execution_failure'));
  }
  // Method, path and guard code only, so H2 can see what the allowlist stopped.
  if (result.blocked?.length) console.warn('pane_attach_blocked_requests', { blocked: result.blocked });
  return {
    outcome,
    uploadSent: result.uploadSent === true,
    screenshots: result.screenshots ?? [],
    runDir: dir,
  };
}

const AMEND_TIMEOUT_MS = 10 * 60_000;

/** Runs amend-stay.mjs. Its result is read even after a nonzero exit so a post-Save uncertainty stays explicit. */
export async function spawnAmendStay(input: PaneAmendSpawnInput): Promise<PaneAmendSpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'pane-amend-'));
  const requestPath = join(dir, 'request.json');
  await writeFile(requestPath, `${JSON.stringify({ confirmation: input.confirmation, currentArrival: input.currentArrival, expectedLastName: input.expectedLastName, fields: input.fields })}\n`, { mode: 0o600 });
  const mode = input.mode ?? 'commit';
  const args =
    mode === 'commit'
      ? [AMEND_STAY, '--request', requestPath, '--mode', 'commit', '--digest', input.previewDigest ?? '', '--out', dir]
      : [AMEND_STAY, '--request', requestPath, '--mode', 'preview', '--out', dir];
  let runError: unknown = null;
  try {
    if (!input.target) throw new Error('pane_stay_target_required');
    await execFileAsync('node', args, { timeout: AMEND_TIMEOUT_MS, env: paneStaySpawnEnv(process.env, undefined, input.target) });
  } catch (error) { runError = error; }
  let result: { outcome?: string; saveAttempted?: boolean; screenshots?: string[]; previewDigest?: string | null; changedFieldsReadback?: Record<string, unknown> | null };
  try { result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as typeof result; }
  catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw runError ?? new Error('pane_amend_no_result');
  }
  const outcome = result.outcome ?? 'execution_failure';
  if (outcome === 'execution_failure') warnPaneStaySpawnFailed('amend', runError ?? new Error(outcome));
  return { outcome, saveAttempted: result.saveAttempted === true, screenshots: result.screenshots ?? [],
    previewDigest: result.previewDigest ?? null, changedFieldsReadback: result.changedFieldsReadback ?? null, runDir: dir };
}

export type PaneAmendPreviewInput = {
  confirmation: string; arrival: string; lastName: string; fields: AmendRequest;
};
export type PaneAmendResult = {
  outcome: string; screenshots: string[]; runId: string | null;
  previewDigest: string | null; changedFieldsReadback: Record<string, unknown> | null;
};
const refusedAmend = (outcome: string): PaneAmendResult =>
  ({ outcome, screenshots: [], runId: null, previewDigest: null, changedFieldsReadback: null });

export function checkAmendPaneInput(
  input: PaneAmendPreviewInput,
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): string | null {
  const shape = checkCancelInput(
    { confirmation: input.confirmation, arrival: input.arrival },
    { allowRealGuest },
  );
  if (shape) return shape;
  if (!allowRealGuest && !/^labtest$/i.test(input.lastName.trim())) return 'refused_not_lab';
  return amendFieldsSchema.safeParse(input.fields).success ? null : 'refused_input_invalid';
}

async function runPaneAmend(
  mode: 'preview' | 'commit',
  input: PaneAmendPreviewInput & { owner: string; previewDigest?: string; transportId?: string },
): Promise<PaneAmendResult> {
  const unpaidMode = paneStayAmendMode('unpaid');
  const paidMode = paneStayAmendMode('paid');
  if (unpaidMode === 'off' && paidMode === 'off') return refusedAmend('refused_flag_off');
  const allowRealGuest = unpaidMode === 'on';
  const inputRefusal = checkAmendPaneInput(input, { allowRealGuest });
  if (inputRefusal) return refusedAmend(inputRefusal);
  if (mode === 'commit' && !input.previewDigest) return refusedAmend('amend_preview_required');
  const resolved = paneStayHmsTargetForTransport(
    input.transportId ?? paneStayTransportIdFromOwner(input.owner),
  );
  if (!resolved.ok) return refusedAmend('refused_unknown_transport');
  const target = resolved.target;
  const lock = paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target);
  if (!lock) return refusedAmend('refused_lock_unavailable');
  const spawn = paneHmsWriteLoaders.spawnAmend ?? spawnAmendStay;
  try {
    await pruneExpiredPaneRuns(paneStayClock());
    let paymentRefusal: string | null = null;
    const spawned = await lock.withLock(async () => {
      const lookupDirs: string[] = [];
      const found = await findStay(
        { confirmation: input.confirmation, arrival: input.arrival },
        { lock: () => HELD_LOCK, onRun: ({ dir }) => lookupDirs.push(dir), target },
      ).finally(() => removeDirs(lookupDirs));
      if (found.outcome !== 'found' || !found.stay) {
        paymentRefusal = found.outcome === 'found' ? 'refused_payment_unknown' : `read_${found.outcome}`;
        return null;
      }
      const moneyState = classifyAmendPayment(found.stay) === 'unpaid' ? 'unpaid' : 'paid';
      if (paneStayAmendMode(moneyState) === 'off') {
        paymentRefusal = 'refused_flag_off';
        return null;
      }
      if (moneyState !== 'unpaid') {
        paymentRefusal = 'refused_payment_unknown';
        return null;
      }
      if (mode === 'commit' && !takePanePreview(input.owner, input.previewDigest ?? '', paneStayClock())) return null;
      return spawn({
        confirmation: input.confirmation,
        currentArrival: input.arrival,
        expectedLastName: input.lastName.trim(),
        fields: input.fields,
        mode,
        target,
        ...(mode === 'commit' ? { previewDigest: input.previewDigest } : {}),
      });
    }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    if (paymentRefusal) return refusedAmend(paymentRefusal);
    if (spawned === null) return refusedAmend('amend_digest_mismatch');
    const runId = spawned.runDir ? randomUUID() : null;
    if (runId && spawned.runDir) registerPaneRun({ runId, dir: spawned.runDir, owner: input.owner, now: paneStayClock() });
    const previewDigest = mode === 'preview' && spawned.outcome === 'previewed' ? spawned.previewDigest ?? null : null;
    if (previewDigest) recordPanePreview(input.owner, previewDigest, paneStayClock());
    return {
      outcome: spawned.outcome,
      screenshots: spawned.screenshots.map((path) => basename(path)).filter((name) => PANE_SCREENSHOT_NAME_PATTERN.test(name)),
      runId,
      previewDigest,
      changedFieldsReadback: spawned.changedFieldsReadback ?? null,
    };
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return refusedAmend('refused_lock_busy');
    warnPaneStaySpawnFailed('amend', error);
    return refusedAmend('execution_failure');
  }
}

export const previewAmend = (input: PaneAmendPreviewInput & { owner: string }) => runPaneAmend('preview', input);
export const commitAmend = (input: PaneAmendPreviewInput & { owner: string; previewDigest: string }) =>
  runPaneAmend('commit', input);

type SaveOutcome = {
  outcome: string;
  clickedOk: boolean;
  uploadSent: boolean;
  saveAttempted?: boolean;
  screenshots: string[];
  runDir?: string;
};

/**
 * Cancel CLI stayChanges compares every expected key. readStayFields only returns STAY_FIELDS
 * (cancel-stay-rules.mjs). Lookup may carry depositReceived for the amend classifier; cancel must not.
 */
export const CANCEL_EXPECT_STAY_KEYS = [
  'status',
  'confirmation',
  'lastName',
  'firstName',
  'arrival',
  'departure',
  'nights',
  'adults',
  'children',
  'roomType',
  'ratePlan',
  'mealPlan',
  'averageRate',
  'grandTotal',
  'balance',
  'sourceOfBusiness',
  'guaranteeType',
  'bookingAgency',
  'organization',
  'reservationNote',
] as const;

export function cancelExpectStay(stay: PaneStayFields): Record<string, unknown> {
  const source = stay as Record<string, unknown>;
  return Object.fromEntries(
    CANCEL_EXPECT_STAY_KEYS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

/** `approvedStay` is the read that matched the approval's HMS digest. The cancel CLI refuses if its own read differs. */
async function saveCancel(
  form: CancelForm,
  approvedStay: PaneStayFields,
  target: HmsReadTarget,
): Promise<SaveOutcome> {
  const spawn = paneStayCancelLoaders.spawn ?? spawnPaneStayCancel;
  const request: PaneStayCancelSpawnInput = {
    mode: 'commit',
    confirmation: form.confirmation,
    arrival: form.arrival,
    reason: squash(form.reason),
    allowRealGuest: false,
    expectStay: cancelExpectStay(approvedStay),
    target,
  };
  const result: PaneStayCancelSpawnResult = await spawn(request);
  return {
    outcome: result.outcome,
    clickedOk: result.clickedOk === true,
    uploadSent: false,
    screenshots: result.screenshots,
    runDir: result.runDir,
  };
}

const amendRefusal = (outcome: string): SaveOutcome => ({ outcome, clickedOk: false, uploadSent: false, saveAttempted: false, screenshots: [] });

async function saveAmend(form: AmendForm, stay: PaneStayFields, target: HmsReadTarget): Promise<SaveOutcome> {
  if (stay.status !== 'Reserved' && stay.status !== 'Confirmed') return amendRefusal('refused_status_unsupported');
  if (classifyAmendPayment(stay) !== 'unpaid') return amendRefusal('refused_payment_unknown');
  const fields = Object.fromEntries(AMEND_FIELDS.filter((field) => form.fields[field] !== undefined &&
    String(form.fields[field]) !== String(stay[field] ?? '')).map((field) => [field, form.fields[field]])) as AmendRequest;
  if (!Object.keys(fields).length) return amendRefusal('no_changes');
  const previewDigest = paneAmendPreviewDigest({ confirmation: form.confirmation, expectedLastName: form.lastName, current: stay, fields });
  if (previewDigest !== form.previewDigest) return amendRefusal('refused_digest_mismatch');
  const result = await (paneHmsWriteLoaders.spawnAmend ?? spawnAmendStay)({
    confirmation: form.confirmation, currentArrival: form.arrival, expectedLastName: form.lastName, fields, previewDigest,
    target,
  });
  return { outcome: result.outcome, clickedOk: false, uploadSent: false, saveAttempted: result.saveAttempted,
    screenshots: result.screenshots, runDir: result.runDir };
}

async function saveAttach(form: AttachForm, file: string | null, target: HmsReadTarget): Promise<SaveOutcome> {
  if (!file) throw new Error('attach_file_missing');
  const spawn = paneHmsWriteLoaders.spawnAttach ?? spawnAttachDocument;
  const result = await spawn({
    confirmation: form.confirmation,
    arrival: form.arrival,
    file,
    documentName: form.documentName,
    target,
  });
  return {
    outcome: result.outcome,
    clickedOk: false,
    uploadSent: result.uploadSent,
    screenshots: result.screenshots,
    runDir: result.runDir,
  };
}

/**
 * Maps the CLI outcome to the run's end. Nothing written is NEEDS_CHECK, and re-approval is allowed. A write that may have
 * happened is UNKNOWN, which blocks new approval until the booking is read back (KTD12).
 */
function classifySave(
  action: HmsWriteForm['action'],
  saved: SaveOutcome,
): { ok: true; outcome: string } | { ok: false; failureClass: AiFailureClass; reason: string } {
  const done = saved.outcome === (action === 'cancel' ? 'cancelled' : action === 'amend' ? 'amended' : 'attached');
  if (done) return { ok: true, outcome: saved.outcome };
  const mayHaveWritten = action === 'cancel' ? saved.clickedOk : action === 'amend' ? saved.saveAttempted === true : saved.uploadSent;
  return { ok: false, failureClass: mayHaveWritten ? 'UNKNOWN' : 'NEEDS_CHECK', reason: saved.outcome };
}

async function endRun(
  db: DB,
  fence: AiRunFence,
  failureClass: AiFailureClass,
  reason: string,
): Promise<PaneHmsWriteResult> {
  const ended = await endHmsWriteRun({ db, fence, failureClass, reason });
  return ended ? { status: 'ended', failureClass, reason } : { status: 'lease_lost' };
}

/** Records the run's PNGs as write evidence. Best effort: a failed PNG only logs, because the write has already happened. */
async function recordEvidence(
  db: DB,
  input: { transportId: string; workItemId: string; runId: string; saved: SaveOutcome },
): Promise<string[]> {
  const recorded: string[] = [];
  if (!input.saved.runDir) return recorded;
  const present = new Set(input.saved.screenshots.map((path) => basename(path)));
  for (const name of EVIDENCE_NAMES) {
    if (!present.has(name)) continue;
    try {
      const png = await readFile(join(input.saved.runDir, name));
      await recordHmsWriteEvidence({
        db,
        transportId: input.transportId,
        workItemId: input.workItemId,
        runId: input.runId,
        name,
        png,
      });
      recorded.push(name);
    } catch (error) {
      console.warn('pane_hms_write_evidence_failed', {
        name,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  return recorded;
}

export type PaneHmsWriteResult =
  | { status: 'succeeded'; action: HmsWriteForm['action']; outcome: string; evidence: string[] }
  | { status: 'ended'; failureClass: AiFailureClass; reason: string }
  | { status: 'lease_lost' };

type ExecuteInput = {
  db: DB;
  fence: AiRunFence;
  transportId: string;
  workItemId: string;
  form: HmsWriteForm;
  file: string | null;
  runDirs: string[];
};

/** The consume, the reads and the Save, all under the property lock the caller holds. */
async function executeUnderLock(input: ExecuteInput): Promise<PaneHmsWriteResult> {
  const { db, fence, form } = input;
  const resolved = paneStayHmsTargetForTransport(input.transportId);
  if (!resolved.ok) return endRun(db, fence, 'POLICY_BLOCK', 'refused_unknown_transport');
  const target = resolved.target;
  let consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>;
  try {
    consumed = await consumeHmsWriteApproval({ db, runId: fence.runId, fence });
  } catch (error) {
    if (!(error instanceof HmsApprovalError)) throw error;
    return error.refusal === 'lease_lost'
      ? { status: 'lease_lost' }
      : endRun(db, fence, 'NEEDS_CHECK', error.refusal);
  }
  // The grant binds the form digest. The approved form must equal the one the policy read, or the file to upload may differ.
  const approved = parseHmsWriteForm(consumed.form);
  if (!approved || canonicalJson(approved) !== canonicalJson(form)) {
    return endRun(db, fence, 'NEEDS_CHECK', 'form_changed');
  }
  const found = await findStay(
    { confirmation: approved.confirmation, arrival: approved.arrival },
    { lock: () => HELD_LOCK, onRun: ({ dir }) => input.runDirs.push(dir), target },
  );
  if (found.outcome !== 'found' || !found.stay) {
    return endRun(db, fence, 'NEEDS_CHECK', `read_${found.outcome}`);
  }
  const stay = found.stay;
  const identity = stayRefusal(stay, approved);
  if (identity) return endRun(db, fence, 'NEEDS_CHECK', identity);
  let pre: HmsPreSaveOutcome;
  try {
    pre = await assertHmsUnchangedBeforeSave({
      db,
      runId: fence.runId,
      fence,
      readHmsState: async () => stay,
    });
  } catch (error) {
    if (!(error instanceof HmsApprovalError)) throw error;
    return endRun(db, fence, 'NEEDS_CHECK', error.refusal);
  }
  if (pre.status === 'lease_lost') return { status: 'lease_lost' };
  // assertHmsUnchangedBeforeSave has already dead-lettered the run and recorded the needs-check.
  if (pre.status === 'needs_check') return { status: 'ended', failureClass: 'NEEDS_CHECK', reason: pre.reason };

  const beat = setInterval(() => {
    void heartbeatAiRun(fence, db).catch(() => false);
  }, HEARTBEAT_MS);
  let saved: SaveOutcome;
  try {
    saved = approved.action === 'cancel' ? await saveCancel(approved, stay, target)
      : approved.action === 'amend' ? await saveAmend(approved, stay, target) : await saveAttach(approved, input.file, target);
  } catch (error) {
    clearInterval(beat);
    // The CLI may have reached Save before it failed, so the outcome is unknown until the booking is read back.
    warnPaneStaySpawnFailed('pane_hms_write', error);
    return endRun(db, fence, 'UNKNOWN', 'save_failed');
  }
  clearInterval(beat);
  if (saved.runDir) input.runDirs.push(saved.runDir);
  const evidence = await recordEvidence(db, {
    transportId: input.transportId,
    workItemId: input.workItemId,
    runId: fence.runId,
    saved,
  });
  const verdict = classifySave(approved.action, saved);
  if (!verdict.ok) return endRun(db, fence, verdict.failureClass, verdict.reason);
  const marked = await markAiRunSucceeded(
    {
      runId: fence.runId,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['claimed', 'running'],
      metrics: { action: approved.action, outcome: verdict.outcome },
    },
    db,
  );
  if (!marked) return { status: 'lease_lost' };
  return { status: 'succeeded', action: approved.action, outcome: verdict.outcome, evidence };
}

async function runClaimed(
  db: DB,
  runId: string,
  fence: AiRunFence,
  env: NodeJS.Dict<string>,
  runDirs: string[],
): Promise<PaneHmsWriteResult> {
  if (runId !== fence.runId) return { status: 'lease_lost' };
  if (paneHmsWriteMode(env) === 'off') return endRun(db, fence, 'POLICY_BLOCK', 'refused_flag_off');
  const [run] = await db
    .select({ workItemId: aiWorkflowRun.workItemId, transportId: aiWorkflowRun.transportId })
    .from(aiWorkflowRun)
    .where(eq(aiWorkflowRun.id, fence.runId))
    .limit(1);
  if (!run?.workItemId) return endRun(db, fence, 'POLICY_BLOCK', 'no_work_item');
  const workItemId = run.workItemId;
  const transportId = run.transportId;
  if (!(await markAiRunRunning(fence, db))) return { status: 'lease_lost' };
  const [item] = await db
    .select({ state: workItem.state, sourceMessageId: workItem.sourceMessageId })
    .from(workItem)
    .where(eq(workItem.id, workItemId))
    .limit(1);
  const form = item ? parseHmsWriteForm(item.state) : null;
  const refusal = form ? formRefusal(form) : 'form_invalid';
  if (!form || refusal) return endRun(db, fence, 'POLICY_BLOCK', refusal ?? 'form_invalid');

  // Read before consume: a refused read ends the run with nothing consumed.
  let file: string | null = null;
  if (form.action === 'attach_document') {
    if (!item?.sourceMessageId) return endRun(db, fence, 'POLICY_BLOCK', 'source_mail_missing');
    const read = { transportId, sourceMessageId: item.sourceMessageId, attachmentId: form.attachmentId };
    const pdf = await (paneHmsWriteLoaders.readAttachment ?? ((at) => readApprovedAttachment(db, at)))(read);
    if (typeof pdf === 'string') return endRun(db, fence, 'POLICY_BLOCK', pdf);
    const notPdf = pdfRefusal(pdf);
    if (notPdf) return endRun(db, fence, 'POLICY_BLOCK', notPdf);
    const work = await mkdtemp(join(tmpdir(), 'pane-hms-write-'));
    runDirs.push(work);
    file = join(work, 'upload.pdf');
    await writeFile(file, pdf, { mode: 0o600 });
  }

  const resolved = paneStayHmsTargetForTransport(transportId);
  if (!resolved.ok) return endRun(db, fence, 'POLICY_BLOCK', 'refused_unknown_transport');
  const target = resolved.target;
  const lock = paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target);
  if (!lock) return endRun(db, fence, 'POLICY_BLOCK', 'refused_lock_unavailable');
  try {
    return await lock.withLock(
      () => executeUnderLock({ db, fence, transportId, workItemId, form, file, runDirs }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return endRun(db, fence, 'HMS_LOCK_BUSY', 'refused_lock_busy');
    throw error;
  }
}

/**
 * One claimed hms_write run (U26). Order: policy and the attachment read, both before consume. Then, under the property
 * lock, the consume, the stay read, the identity check and the pre-Save check. Only then does the CLI run send Save.
 * Each refusal before Save ends the run with nothing written. An unexpected error propagates, and the sweep turns the
 * stale claim into LEASE_LOST, which blocks approval.
 */
export async function runPaneHmsWriteOnce(input: {
  runId: string;
  fence: AiRunFence;
  db?: DB;
  env?: NodeJS.Dict<string>;
}): Promise<PaneHmsWriteResult> {
  const db = input.db ?? getDb();
  const runDirs: string[] = [];
  try {
    return await runClaimed(db, input.runId, input.fence, input.env ?? process.env, runDirs);
  } finally {
    await removeDirs(runDirs);
  }
}

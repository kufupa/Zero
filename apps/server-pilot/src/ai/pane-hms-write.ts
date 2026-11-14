import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { aiWorkflowRun, attachment, message } from '../db/schema/mail.js';
import { workEvent, workItem } from '../db/schema/work.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
  assertTargetAliasesHeld,
  type HeldTargetAliasLock,
} from '../hms/property-read-lock.js';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  readAuthorizedArtifactBytes,
  type AttachmentLocator,
} from '../mail/artifacts/read-artifact.js';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import { getS3Storage } from '../storage/s3.js';
import { bindHmsMailboxProperty, loadThreadMailboxHmsOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { propertyCodeSchema } from '../hms/property-registry.js';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import { effectiveWorkflowPolicy } from '../../tooling/hms-cloud/hms-workflow-policy.mjs';
import { cloudWriterCurrent } from '../../tooling/hms-cloud/cloud-session.mjs';
import { verifyStaffGoForRun, type VerifiedStaffGo } from '../hms/staff-go-authority.js';
import { canonicalJson } from './draft-approval.js';
import { assertNoCreateDispatchFence, CreateFenceError } from './pane-create-dispatch-fence.js';
import { currentFilingSourceThread } from './pane-filing-preview.js';
import { lockBoundFilingSource, readBoundFilingSource, readPaneFilingAttachment, type BoundFilingForm } from './pane-filing-source.js';
import {
  assertHmsUnchangedBeforeSave,
  assertNoOpenWrite,
  authorizeConsumedLabtestAttach,
  consumeHmsWriteApproval,
  endHmsWriteRun,
  formDigest,
  hmsStateDigest,
  HmsApprovalError,
  nativeFilingDocumentName,
  type HmsSelectedSource,
  type HmsPreSaveOutcome,
  recordHmsWriteEvidence,
  storeHmsSnapshot,
} from './hms-approval.js';
import { checkCancelInput } from './pane-stay-cancel.js';
import {
  assertLabStayGuard,
  PANE_WRITE_ATTACH,
  paneStayCloudTargetLock,
  paneStayPropertyLock,
  paneStayTransportIdFromOwner,
  paneWriteMode,
  parseLabOn,
  type PaneSaveMode,
  type PaneStayLock,
} from './pane-stay-save.js';
import { findStay, type PaneStayFields } from './pane-stay-lookup.js';
import type { HmsCloudNativePreimage } from './hms-cloud-saved-stay-find.js';
import type { CloudAmendChanges } from './pane-cloud-amend.js';
import { projectCloudStayFind, readCloudStayForPane, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { hmsDispatchTargetKey, hmsDispatchTargetKeys, type HmsDispatchTarget } from './hms-dispatch-target.js';
import { recordNeverDispatchedAttach } from './pane-cloud-attach-recovery.js';
import { recordConfirmedVoucherFile } from './voucher-pending.js';
import { cancelBusinessPreimage, cloudCancelDispatchSchema, executeCloudCancel, readCloudCancelPreimage } from './pane-cloud-cancel.js';
import { captureHmsLabtestDispatchEpoch, claimHmsLabtestDispatch, HmsLabtestDispatchError, resolveHmsLabtestDispatch,
  resolveNeverDispatchedAttach, type HmsLabtestWriteHandle } from './hms-labtest-dispatch.js';
import { paneStayHmsTargetForTransport, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';
import {
  heartbeatAiRun,
  HMS_WRITE_RUN_KIND,
  labtestAttachEnabled,
  markAiRunRunning,
  markAiRunSucceeded,
  mergeTerminalRunMetrics,
  type AiFailureClass,
  type AiRunFence,
} from './run-ledger.js';

/**
 * Write runner for the pane's HMS actions on our own Labtest booking (U26): attach a document, cancel a stay, or amend it.
 * Every write goes through the U25 approval gate. Policy is checked before the grant is consumed.
 * The consume, the stay read, the identity check and the pre-Save check all run under the property lock. Only then
 * does the paused native request continue.
 */

const READ_ATTACHMENT_TIMEOUT_MS = 60_000;
// 7m native upload, 5m fresh readback, and 2m for drain, closure, evidence and result.
const CLOUD_ATTACH_FINISH_RESERVE_MS = 14 * 60_000;
/** Attach reads the bytes through the read path, so the cap is the read path's cap. A test pins the equality. */
export const PANE_ATTACH_MAX_BYTES = ARTIFACT_MAX_INPUT_BYTES;
const PDF_MAGIC = Buffer.from('%PDF-');
/** Keeps the claimed run live across native staging and readback. */
const HEARTBEAT_MS = 30_000;
const EVIDENCE_NAMES = ['before.png', 'after.png'] as const;
/** The caller already holds the property lock, so findStay's own acquisition is passed through. */
const HELD_LOCK: PaneStayLock = { withLock: (fn) => fn() };

export type FilingSnapshot = { cmsSend: boolean };
export type CloudFilingRecord = { stay: PaneStayFields; nativeGuestId: string; nativeStayId: string; filingSnapshot: FilingSnapshot };
type FilingReadOptions = { allowRealGuest: boolean; cloudTargetKey?: string; transportId?: string; signal?: AbortSignal; credentialLease?: import('../../tooling/hms-cloud/cloud-session.mjs').CloudCredentialLease };

async function currentFilingSelection(db: DB, transportId: string, source: HmsSelectedSource): Promise<boolean> {
  const { isSelectedHmsInboundMessage } = await import('./hms-jobs.js');
  return isSelectedHmsInboundMessage({ transportId, ...source }, db);
}

/** Target identity and the preserved CMS state bind the approved Documents upload. */
function filingState(cloud: CloudFilingRecord) {
  const { confirmation, firstName, lastName, status, arrival, departure } = cloud.stay;
  return { confirmation, firstName, lastName, status, arrival, departure,
    nativeGuestId: cloud.nativeGuestId, nativeStayId: cloud.nativeStayId, cmsSend: cloud.filingSnapshot.cmsSend };
}

/** Independently re-read the exact booking and native IDs. */
async function readCloudFilingRecord(request: { confirmation: string; arrival: string }, target: HmsReadTarget,
  options: FilingReadOptions = { allowRealGuest: false }):
  Promise<CloudFilingRecord | null> {
  const property = getPropertyRegistration(target.propertyCode);
  if (!property || property.credentialSecretRef !== target.secretId || property.browserSlot !== target.browserSlot ||
      property.origin !== target.origin) return null;
  try {
    const timeout = AbortSignal.timeout(5 * 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const raw = options.cloudTargetKey || options.credentialLease
      ? await (async () => {
        const session = await import('../../tooling/hms-cloud/saved-stay-agent-session.mjs' as string) as {
          withSavedStayAgentSession: <T>(action: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<T>,
            options: Record<string, unknown>) => Promise<T>;
        };
        return session.withSavedStayAgentSession((owned) => readCloudStayForPane(owned, request, true, target.propertyCode), {
          propertyCode: target.propertyCode, signal, readOnly: true, readOnlyConfirmation: request.confirmation, cloudTargetKey: options.cloudTargetKey, credentialLease: options.credentialLease,
          ...(options.transportId !== undefined ? { transportId: options.transportId } : {}),
        });
      })()
      : await runCloudStayFind({ request, target, transportId: options.transportId, nativeIdentityOnly: true, signal });
    const result = projectCloudStayFind(request, raw, target.propertyCode);
    const record = raw && typeof raw === 'object' ? (raw as { record?: { nativePreimage?: unknown } }).record : null;
    const parsed = z.object({ source: z.literal('record_view_ext_model'), propertyCode: propertyCodeSchema,
      confirmation: z.string(), guestId: z.string().regex(/^\d{1,30}$/),
      reservationStayId: z.string().regex(/^\d{1,100}$/), status: z.string().trim().min(1).max(200),
      firstName: z.string().trim().min(1).max(200), lastName: z.string().trim().min(1).max(200),
      arrival: z.string(), departure: z.string() })
      .passthrough().safeParse(record?.nativePreimage);
    if (!parsed.success || result.outcome !== 'found' || !result.stay || result.arrivalMismatch) return null;
    const native = parsed.data;
    const labtestGuest = native.firstName === 'Proof' && native.lastName === 'Labtest';
    if (native.propertyCode !== target.propertyCode || native.confirmation !== request.confirmation || native.arrival !== request.arrival ||
        (!options.allowRealGuest && !labtestGuest) ||
        (labtestGuest && (native.arrival < '2027-01-01' || native.status !== 'Reserved')) ||
        native.arrival >= native.departure ||
        (['confirmation', 'firstName', 'lastName', 'status', 'arrival', 'departure'] as const)
          .some((key) => native[key] !== result.stay?.[key])) return null;
    const { filingSnapshot } = await import('../../tooling/hms-cloud/pane-attach-session.mjs' as string) as {
      filingSnapshot: (record: unknown) => FilingSnapshot | null;
    };
    const snapshot = filingSnapshot(record);
    return snapshot ? { stay: result.stay, nativeGuestId: native.guestId,
      nativeStayId: native.reservationStayId, filingSnapshot: snapshot } : null;
  } catch { return null; }
}

/** The v2 Filing adapter shares the same independently-read Cloud stay binding as pane approval. */
export async function readPaneCloudFilingRecord(input: {
  confirmation: string;
  arrival: string;
  target: HmsReadTarget;
  allowRealGuest: boolean;
  cloudTargetKey?: string;
  transportId?: string;
  signal?: AbortSignal;
  credentialLease?: import('../../tooling/hms-cloud/cloud-session.mjs').CloudCredentialLease;
}): Promise<CloudFilingRecord | null> {
  return readCloudFilingRecord({ confirmation: input.confirmation, arrival: input.arrival }, input.target,
    { allowRealGuest: input.allowRealGuest, signal: input.signal, credentialLease: input.credentialLease, ...(input.transportId !== undefined ? { transportId: input.transportId } : {}),
      ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}) });
}

/**
 * Attach go-live switch. PANE_WRITE_ATTACH is off|lab|on via parseLabOn.
 * Unset keeps the old SAVE=lab-only gate (SAVE=on and the other PANE_WRITE_* flags never open attach).
 */
export function paneHmsWriteMode(env: NodeJS.Dict<string> = process.env): PaneSaveMode {
  if (env[PANE_WRITE_ATTACH] !== undefined) return parseLabOn(env[PANE_WRITE_ATTACH]);
  return env.RESERVATIONIST_PANE_SAVE === 'lab' ? 'lab' : 'off';
}

const CONFIRMATION = /^\d+-\d+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Documents accepts a PDF filename without path separators or control characters. */
function isPdfDocumentName(name: string): boolean {
  if (name.length === 0 || name.length > 150 || /[\\/]/.test(name) || !/\.pdf$/i.test(name)) {
    return false;
  }
  return !/[\p{Cc}]/u.test(name);
}

const PDF_SHA256 = /^[a-f0-9]{64}$/;
const FILING_DOCUMENT_CODE = /^NAVA[A-Z2-7]{25}[AEIMQUY4]$/;

const attachFormSchema = z.object({
  action: z.literal('attach_document'),
  confirmation: z.string().regex(CONFIRMATION),
  arrival: z.string().regex(ISO_DATE),
  lastName: z.string().trim().min(1).max(200),
  attachmentId: z.string().min(1).max(200),
  documentName: z.string().max(150).refine(isPdfDocumentName),
  sourceDocumentName: z.string().max(150).refine(isPdfDocumentName).optional(),
  requestedDocumentName: z.string().max(150).refine(isPdfDocumentName).optional(),
  documentDescription: z.string().min(1).max(200).refine((value) => value === value.trim() && !/[\p{Cc}]/u.test(value)).optional(),
  /** Digest of the PDF staff approved. A later change of the stored bytes is refused before upload. */
  pdfSha256: z.string().regex(PDF_SHA256).optional(),
  sourceMessageId: z.string().min(1).max(512).optional(),
  sourceInternetMessageId: z.string().min(1).max(998).optional(),
  sourceSnapshotDigest: z.string().regex(PDF_SHA256).optional(),
  sourceThreadId: z.string().min(1).max(512).optional(),
  sourceHash: z.string().regex(PDF_SHA256).optional(),
  documentCode: z.string().regex(FILING_DOCUMENT_CODE).optional(),
  filingStateDigest: z.string().regex(PDF_SHA256).optional(),
});

export const boundFilingFormSchema = attachFormSchema.extend({
  pdfSha256: z.string().regex(PDF_SHA256), sourceMessageId: z.string().min(1).max(512),
  sourceInternetMessageId: z.string().min(1).max(998), sourceSnapshotDigest: z.string().regex(PDF_SHA256),
  sourceThreadId: z.string().min(1).max(512), sourceHash: z.string().regex(PDF_SHA256),
  documentCode: z.string().regex(FILING_DOCUMENT_CODE), filingStateDigest: z.string().regex(PDF_SHA256),
  sourceDocumentName: z.string().max(150).refine(isPdfDocumentName),
}).superRefine((form, context) => {
  let expected: string;
  try { expected = form.requestedDocumentName ?? nativeFilingDocumentName(form.sourceDocumentName, form.confirmation, form.pdfSha256); }
  catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['documentName'], message: 'native filing name is invalid' });
    return;
  }
  if (form.documentName !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['documentName'], message: 'native filing name does not match the source PDF' });
  }
});

const cancelFormSchema = z.object({
  action: z.literal('cancel'),
  confirmation: z.string().regex(CONFIRMATION),
  arrival: z.string().regex(ISO_DATE),
  lastName: z.string().trim().min(1).max(200),
  reason: z.string().max(200),
  cloudCancel: cloudCancelDispatchSchema.optional(),
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
function formRefusal(
  form: HmsWriteForm,
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): string | null {
  const shape = checkCancelInput(
    { confirmation: form.confirmation, arrival: form.arrival },
    { allowRealGuest },
  );
  if (shape) return shape;
  if (!allowRealGuest && !/^labtest$/i.test(form.lastName)) return 'refused_not_lab';
  if (form.action === 'attach_document') return null;
  if (form.action === 'amend') return form.fields.arrival && form.fields.arrival < '2027-01-01' ? 'refused_not_lab' : null;
  const reason = squash(form.reason);
  return reason && !reason.startsWith('-') ? null : 'refused_reason_missing';
}

/** The stay HMS shows must be the one the form names, with the same arrival, and must pass the Labtest guard. */
function stayRefusal(
  stay: PaneStayFields,
  form: { confirmation: string; arrival: string; lastName?: string },
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): string | null {
  if (stay.confirmation?.trim() !== form.confirmation) return 'identity_mismatch';
  if (stay.arrival !== form.arrival) return 'arrival_mismatch';
  if (form.lastName && squash(stay.lastName ?? '').toLocaleLowerCase() !== squash(form.lastName).toLocaleLowerCase()) return 'identity_mismatch';
  if (allowRealGuest) return null;
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

function pdfBytesHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export { nativeFilingDocumentName };

export type BindAttachDocumentResult =
  | { status: 'bound'; form: AttachForm; formDigest?: string }
  | { status: 'refused'; reason: string };

/**
 * Stores the existing attach form on the work item, bound to one stay and the PDF's sha256. Approval and the
 * hms-attach-once runner then use that form. Nothing is uploaded here.
 */
export async function bindAttachDocumentForm(input: {
  db?: DB;
  transportId: string;
  propertyCode?: string;
  workItemId: string;
  confirmation: string;
  arrival: string;
  lastName: string;
  attachmentId: string;
  sourceMessageId?: string;
  internetMessageId?: string;
  actorUserId?: string;
  selectedSource?: HmsSelectedSource;
  documentSource?: { sha256: string; snapshotDigest: string };
  requestedDocumentName?: string;
  documentDescription?: string;
  revisionSeq?: number;
  expectedStay?: { firstName: string; status: string; departure: string };
  env?: NodeJS.Dict<string>;
}): Promise<BindAttachDocumentResult> {
  const db = input.db ?? getDb();
  const writeKeys = [
    'action',
    'confirmation',
    'arrival',
    'lastName',
    'attachmentId',
    'documentName',
    'sourceDocumentName',
    'requestedDocumentName',
    'documentDescription',
    'pdfSha256',
    'sourceMessageId',
    'sourceInternetMessageId',
    'sourceSnapshotDigest',
    'sourceThreadId',
    'sourceHash',
    'documentCode',
    'filingStateDigest',
    'filingHistorySeq',
    'reason',
    'fields',
    'previewDigest',
    'cloudAmend',
    'cloudCancel',
    'cloudCancelPreview',
  ] as const;
  const target = paneStayHmsTargetForTransport(input.transportId, input.propertyCode);
  if (target.ok) {
    const policy = effectiveWorkflowPolicy(input.env ?? process.env, target.target.propertyCode, 'attach');
    const { nativeReadCapabilityAvailable } = await import('../hms/hms-service.js');
    if (!policy.readEnabled || policy.capability === 'unavailable' ||
        !await nativeReadCapabilityAvailable({ propertyCode: target.target.propertyCode, transportId: input.transportId }) ||
        !input.sourceMessageId || !input.internetMessageId ||
        !input.actorUserId || !input.selectedSource || input.selectedSource.messageId !== input.sourceMessageId ||
        !input.documentSource || !PDF_SHA256.test(input.documentSource.sha256) ||
        !PDF_SHA256.test(input.documentSource.snapshotDigest) || !Number.isSafeInteger(input.revisionSeq) || input.revisionSeq! < 0) {
      return { status: 'refused', reason: 'filing_unavailable' };
    }
    const selected = canonicalMessageId(input.internetMessageId.trim());
    const expectedStay = z.object({ firstName: z.string().trim().min(1).max(200), status: z.string().trim().min(1).max(200),
      departure: z.string().regex(ISO_DATE) }).strict().safeParse(input.expectedStay);
    if (!expectedStay.success) return { status: 'refused', reason: 'filing_unavailable' };
    if (!selected) return { status: 'refused', reason: 'source_mail_changed' };
    const sourceInput = { ...input, sourceMessageId: input.sourceMessageId, actorUserId: input.actorUserId };
    const threadId = await currentFilingSourceThread(db, sourceInput);
    if (!threadId || threadId !== input.selectedSource.threadId ||
        !await currentFilingSelection(db, input.transportId, input.selectedSource)) {
      return { status: 'refused', reason: 'source_mail_changed' };
    }
    const selectedSource = input.selectedSource;
    try {
      const origin = await loadThreadMailboxHmsOrigin({ transportId: input.transportId, threadId, messageId: input.sourceMessageId });
      const bound = origin && bindHmsMailboxProperty({ transportId: input.transportId, propertyCode: target.target.propertyCode,
        origin, toolId: 'documents_list_existing' });
      if (!bound || !bound.ok || bound.propertyCode !== target.target.propertyCode) {
        return { status: 'refused', reason: 'refused_unknown_transport' };
      }
    } catch { return { status: 'refused', reason: 'refused_unknown_transport' }; }
    const source = await readPaneFilingAttachment({ db, s3: getS3Storage(), transportId: input.transportId,
      messageId: input.sourceMessageId, attachmentId: input.attachmentId, signal: AbortSignal.timeout(READ_ATTACHMENT_TIMEOUT_MS),
      checkAuthority: async () => await currentFilingSourceThread(db, sourceInput) === threadId &&
        await currentFilingSelection(db, input.transportId, selectedSource) });
    if (!source) return { status: 'refused', reason: 'attachment_not_found' };
    if (source.source.sha256 !== input.documentSource.sha256 ||
        source.source.snapshotDigest !== input.documentSource.snapshotDigest) {
      return { status: 'refused', reason: 'source_changed' };
    }
    if (!await currentFilingSelection(db, input.transportId, selectedSource)) {
      return { status: 'refused', reason: 'source_mail_changed' };
    }
    // The Documents reader collapses whitespace. Refuse before Go if its
    // readback could not compare the exact approved filename.
    if (source.source.filename !== source.source.filename.replace(/\s+/g, ' ').trim()) {
      return { status: 'refused', reason: 'form_invalid' };
    }
    const nativeDocumentName = input.requestedDocumentName ?? nativeFilingDocumentName(source.source.filename, input.confirmation, source.source.sha256);
    const form: BoundFilingForm & { sourceThreadId: string; sourceHash: string } = {
      action: 'attach_document', confirmation: input.confirmation, arrival: input.arrival,
      lastName: squash(input.lastName), sourceMessageId: input.sourceMessageId, sourceInternetMessageId: selected,
      attachmentId: input.attachmentId, sourceDocumentName: source.source.filename,
      documentName: nativeDocumentName, ...(input.requestedDocumentName ? { requestedDocumentName: input.requestedDocumentName } : {}),
      ...(input.documentDescription ? { documentDescription: input.documentDescription } : {}), pdfSha256: source.source.sha256,
      sourceSnapshotDigest: source.source.snapshotDigest, sourceThreadId: selectedSource.threadId, sourceHash: selectedSource.sourceHash };
    if (!attachFormSchema.safeParse(form).success || formRefusal(form, { allowRealGuest: true }) || pdfRefusal(source.bytes)) {
      return { status: 'refused', reason: 'form_invalid' };
    }
    const lock = paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target.target);
    if (!lock) return { status: 'refused', reason: 'refused_lock_unavailable' };
    let prepared: { cloud: CloudFilingRecord; documentCode: string } | null;
    try {
      prepared = await lock.withLock(async () => {
        const cloud = await (paneHmsWriteLoaders.readCloudFiling ?? readCloudFilingRecord)(
          { confirmation: form.confirmation, arrival: form.arrival }, target.target, { allowRealGuest: true, transportId: input.transportId });
        if (!cloud || stayRefusal(cloud.stay, form, { allowRealGuest: true }) ||
            squash(cloud.stay.firstName ?? '').toLocaleLowerCase() !== squash(expectedStay.data.firstName).toLocaleLowerCase() ||
            squash(cloud.stay.status ?? '').toLocaleLowerCase() !== squash(expectedStay.data.status).toLocaleLowerCase() ||
            cloud.stay.departure !== expectedStay.data.departure) return null;
        const result = await (paneHmsWriteLoaders.prepareCloudAttach ?? prepareCloudAttach)({
          confirmation: form.confirmation, arrival: form.arrival, documentName: form.documentName,
          ...(form.documentDescription ? { documentDescription: form.documentDescription } : {}),
          bytes: source.bytes, pdfSha256: form.pdfSha256, target: target.target, transportId: input.transportId,
          guestName: `${cloud.stay.firstName} ${cloud.stay.lastName}`,
          approvedStay: { ...cloud.stay, propertyCode: target.target.propertyCode, nativeGuestId: cloud.nativeGuestId, nativeStayId: cloud.nativeStayId, allowRealGuest: true },
          approvedSnapshot: cloud.filingSnapshot, allowRealGuest: true,
          cloudTargetKey: hmsDispatchTargetKey({ propertyCode: propertyCodeSchema.parse(target.target.propertyCode), kind: 'saved',
            confirmation: form.confirmation, nativeStayId: cloud.nativeStayId }),
        });
        return result.outcome === 'prepared' && FILING_DOCUMENT_CODE.test(result.documentCode ?? '')
          ? { cloud, documentCode: result.documentCode! } : null;
      }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    } catch (error) {
      return { status: 'refused', reason: isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'execution_failure' };
    }
    if (!prepared) return { status: 'refused', reason: 'filing_prepare_unavailable' };
    const fresh = await readPaneFilingAttachment({ db, s3: getS3Storage(), transportId: input.transportId,
      messageId: input.sourceMessageId, attachmentId: input.attachmentId, expected: source.source,
      signal: AbortSignal.timeout(READ_ATTACHMENT_TIMEOUT_MS),
      checkAuthority: async () => await currentFilingSourceThread(db, sourceInput) === threadId &&
        await currentFilingSelection(db, input.transportId, selectedSource) });
    if (!fresh) return { status: 'refused', reason: 'source_changed' };
    form.documentCode = prepared.documentCode;
    form.filingStateDigest = hmsStateDigest(filingState(prepared.cloud));
    const parsed = boundFilingFormSchema.safeParse(form);
    if (!parsed.success) return { status: 'refused', reason: 'form_invalid' };
    return db.transaction(async (tx) => {
      const item = await lockBoundFilingSource(tx, { transportId: input.transportId, workItemId: input.workItemId,
        form, allowUnbound: true });
      if (!item || item.threadId !== selectedSource.threadId || item.revisionSeq !== input.revisionSeq ||
          !await currentFilingSelection(tx as DB, input.transportId, selectedSource)) {
        return { status: 'refused' as const, reason: 'source_mail_changed' };
      }
      try {
        await assertNoCreateDispatchFence(tx, { transportId: input.transportId, workItemId: item.id });
        await assertNoOpenWrite(tx as DB, item.id);
      } catch (error) {
        if (error instanceof CreateFenceError && error.reason === 'active') return { status: 'refused' as const, reason: 'write_in_flight' };
        if (error instanceof HmsApprovalError) return { status: 'refused' as const, reason: error.refusal };
        throw error;
      }
      const state: Record<string, unknown> = { ...item.state };
      for (const key of writeKeys) delete state[key];
      delete state.hmsSnapshot;
      Object.assign(state, parsed.data, { propertyCode: target.target.propertyCode });
      await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, item.id));
      return { status: 'bound' as const, form: parsed.data, formDigest: formDigest(state) };
    });
  }
  return { status: 'refused', reason: target.reason };
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
  propertyCode?: string;
  selectedInternetMessageId?: string;
  selectedSource?: HmsSelectedSource;
  expectedFormDigest?: string;
  confirmation: string;
  arrival: string;
  env?: NodeJS.Dict<string>;
}): Promise<PaneHmsPrepareResult> {
  const env = input.env ?? process.env;
  const resolved = paneStayHmsTargetForTransport(input.transportId, input.propertyCode);
  if (!resolved.ok) return { status: 'refused', reason: 'refused_unknown_transport' };
  const target = resolved.target;
  const propertyCode = propertyCodeSchema.parse(target.propertyCode);
  const attachMode = propertyCode === 'HRCEN' ? paneHmsWriteMode(env) : effectiveWorkflowPolicy(env, propertyCode, 'attach').mode;
  const shape = checkCancelInput(
    { confirmation: input.confirmation, arrival: input.arrival },
    { allowRealGuest: true },
  );
  if (shape) return { status: 'refused', reason: shape };
  const readAt = new Date();
  const db = input.db ?? getDb();
  const [item] = await db.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  if (!item) return { status: 'refused', reason: 'not_found' };
  const form = parseHmsWriteForm(item.state);
  const cloudAttach = form?.action === 'attach_document';
  if (!cloudAttach && attachMode === 'off' && !(propertyCode === 'HRCEN' && env.RESERVATIONIST_PANE_SAVE === 'lab')) {
    return { status: 'refused', reason: 'refused_flag_off' };
  }
  let stay: PaneStayFields, reviewed: unknown;
  if (cloudAttach) {
    const policy = effectiveWorkflowPolicy(env, propertyCode, 'attach');
    const { nativeReadCapabilityAvailable } = await import('../hms/hms-service.js');
    if (!policy.readEnabled || policy.capability === 'unavailable' ||
        !await nativeReadCapabilityAvailable({ propertyCode, transportId: input.transportId }) ||
        !boundFilingFormSchema.safeParse(form).success ||
        form.confirmation !== input.confirmation || form.arrival !== input.arrival || !input.selectedSource ||
        form.sourceMessageId !== input.selectedSource.messageId || form.sourceThreadId !== input.selectedSource.threadId ||
        form.sourceHash !== input.selectedSource.sourceHash ||
        !await currentFilingSelection(db, input.transportId, input.selectedSource)) {
      return { status: 'refused', reason: 'filing_unavailable' };
    }
    const lock = paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target);
    if (!lock) return { status: 'refused', reason: 'refused_lock_unavailable' };
    let cloud: CloudFilingRecord | null;
    try {
      cloud = await lock.withLock((signal) => (paneHmsWriteLoaders.readCloudFiling ?? readCloudFilingRecord)(
        { confirmation: input.confirmation, arrival: input.arrival }, target, { allowRealGuest: true, transportId: input.transportId, signal }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
    } catch (error) {
      return { status: 'refused', reason: isPropertyReadLockDeadline(error) ? 'refused_lock_busy' : 'execution_failure' };
    }
    if (!cloud) return { status: 'refused', reason: 'execution_failure' };
    if (hmsStateDigest(filingState(cloud)) !== form.filingStateDigest) {
      return { status: 'refused', reason: 'filing_target_changed' };
    }
    stay = cloud.stay;
    reviewed = filingState(cloud);
  } else {
    const lookupDirs: string[] = [];
    const found = await findStay(
      { confirmation: input.confirmation, arrival: input.arrival },
      {
        lock: () => paneHmsWriteLoaders.lock ?? paneStayPropertyLock(target),
        onRun: ({ dir }) => lookupDirs.push(dir), target, transportId: input.transportId,
      },
    ).finally(() => removeDirs(lookupDirs));
    if (found.outcome !== 'found' || !found.stay) return { status: 'refused', reason: found.outcome };
    stay = found.stay;
    reviewed = stay;
  }
  const refusal = stayRefusal(stay, form ?? input, { allowRealGuest: true });
  if (refusal) return { status: 'refused', reason: refusal };
  if (input.selectedSource && !await currentFilingSelection(db, input.transportId, input.selectedSource)) {
    return { status: 'refused', reason: 'source_mail_changed' };
  }
  await storeHmsSnapshot({
    db,
    transportId: input.transportId,
    workItemId: input.workItemId,
    selectedInternetMessageId: input.selectedInternetMessageId,
    selectedSource: input.selectedSource,
    expectedFormDigest: input.expectedFormDigest,
    readHmsState: async () => reviewed,
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
  documentDescription?: string;
  /** On-mode only. The CLI never reads this from the environment. */
  allowRealGuest?: boolean;
  target?: HmsReadTarget;
  staffGo?: VerifiedStaffGo;
  heldTargetLock?: HeldTargetAliasLock;
  worker?: { db: DB; fence: AiRunFence };
  pdfSha256?: string;
  documentCode?: string;
  guestName?: string;
  cloudTargetKey?: string;
  signal?: AbortSignal;
  transportId?: string;
  approvedStay?: PaneStayFields & { propertyCode: string; nativeGuestId: string; nativeStayId: string; allowRealGuest: boolean };
  approvedSnapshot?: FilingSnapshot;
  beforeDispatch?: () => Promise<boolean>;
  finalAuthority?: (code: string) => Promise<boolean>;
  continuationAllowed?: () => boolean;
  dispatchWithAuthority?: (code: string, nativeGuestId: string, nativeStayId: string, requestDigest: string,
    dispatch: NativeAttachContinuation, writer: unknown, beforeShot: string, interceptedRequest: unknown) => Promise<unknown>;
};

type PaneAttachPrepareInput = Omit<PaneAttachSpawnInput, 'file' | 'pdfSha256' | 'target' | 'guestName' | 'approvedStay' | 'approvedSnapshot'> & {
  bytes: Buffer; pdfSha256: string; target: HmsReadTarget; guestName: string;
  approvedStay: PaneStayFields & { propertyCode: string; nativeGuestId: string; nativeStayId: string; allowRealGuest: boolean };
  approvedSnapshot: FilingSnapshot;
};

type NativeAttachContinuation = (() => Promise<unknown>) & { proveNeverDispatched?: () => unknown };

export type PaneAttachSpawnResult = {
  outcome: string;
  /** True once the upload request left the browser. A failure after that leaves the upload unconfirmed. */
  uploadSent: boolean;
  /** True when the Documents tab listed the uploaded file. */
  listed?: boolean;
  /** PNG names or absolute paths, as the CLI reports them. */
  screenshots: string[];
  /** Absolute directory the CLI wrote result.json and the PNGs to. */
  runDir?: string;
  cleanupRoot?: string;
  documentCode?: string;
  nativeReadback?: Record<string, unknown>;
  dispatchCallbacksDrained?: boolean;
  writerSessionClosed?: boolean;
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
  transportId?: string;
  cloudPreparation?: { selected: HmsCloudNativePreimage; changes: CloudAmendChanges; allowRealGuest: boolean };
  approvedRun?: { runId: string; fence: AiRunFence; db?: DB };
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
  readCloudFiling: ((input: { confirmation: string; arrival: string }, target: HmsReadTarget, options?: FilingReadOptions) =>
    Promise<CloudFilingRecord | null>) | null;
  prepareCloudAttach: ((input: PaneAttachPrepareInput) => Promise<{ outcome: string; documentCode?: string }>) | null;
} = {
  lock: null,
  spawnAttach: null,
  spawnAmend: null,
  readAttachment: null,
  readCloudFiling: null,
  prepareCloudAttach: null,
};

async function prepareCloudAttach(input: PaneAttachPrepareInput): Promise<{ outcome: string; documentCode?: string }> {
  const { prepareCloudPaneAttach } = await import('../../tooling/hms-cloud/pane-attach-session.mjs' as string) as {
    prepareCloudPaneAttach: (args: PaneAttachPrepareInput) => Promise<{ outcome: string; documentCode?: string }>;
  };
  return prepareCloudPaneAttach(input);
}

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
}

/** The canonical native writer requires the worker's paused dispatch authorization. */
export async function spawnAttachDocument(input: PaneAttachSpawnInput): Promise<PaneAttachSpawnResult> {
  if (!input.target || !input.staffGo || !input.worker || !input.pdfSha256 || !input.approvedStay || !input.approvedSnapshot ||
      !input.beforeDispatch || !input.finalAuthority || !input.dispatchWithAuthority) {
    return { outcome: 'refused_cloud_upload_unavailable', uploadSent: false, screenshots: [] };
  }
  const worker = input.worker;
  const verified = await worker.db.transaction((tx) => verifyStaffGoForRun(tx, worker.fence));
  const reviewed = boundFilingFormSchema.parse(verified.preparation.businessFields);
  if (verified.grant.operation !== 'attach_document' || verified.grant.grantId !== input.staffGo.grant.grantId ||
      verified.grant.transportId !== input.transportId || verified.grant.propertyCode !== input.target.propertyCode || reviewed.confirmation !== input.confirmation ||
      reviewed.arrival !== input.arrival || reviewed.documentName !== input.documentName ||
      reviewed.documentCode !== input.documentCode || reviewed.documentDescription !== input.documentDescription ||
      reviewed.pdfSha256 !== input.pdfSha256) throw new HmsApprovalError('state_changed');
  assertTargetAliasesHeld(input.heldTargetLock, { tenantId: verified.grant.tenantId, propertyCode: verified.grant.propertyCode,
    targetAliases: [...verified.preparation.targetAliases, ...hmsDispatchTargetKeys({ propertyCode: verified.grant.propertyCode,
      kind: 'saved', confirmation: input.confirmation, nativeStayId: input.approvedStay.nativeStayId })] });
  const { runCloudPaneAttach } = await import('../../tooling/hms-cloud/pane-attach-session.mjs' as string) as {
    runCloudPaneAttach: (args: PaneAttachSpawnInput) => Promise<PaneAttachSpawnResult>;
  };
  return runCloudPaneAttach(input);
}

/** Native preview uses explicit HMS observations; Save requires a durable worker reference. */
export async function spawnAmendStay(input: PaneAmendSpawnInput): Promise<PaneAmendSpawnResult> {
  if ((input.mode ?? 'commit') === 'commit') {
    if (!input.approvedRun || input.approvedRun.runId !== input.approvedRun.fence.runId) {
      return { outcome: 'fresh_preparation_required', saveAttempted: false, screenshots: [] };
    }
    const worker = { db: input.approvedRun.db ?? getDb(), fence: input.approvedRun.fence };
    const go = await worker.db.transaction((tx) => verifyStaffGoForRun(tx, worker.fence));
    const target = z.object({ confirmation: z.string(), arrival: z.string() }).passthrough().parse(go.preparation.businessFields);
    if (go.grant.operation !== 'amend' || go.grant.transportId !== input.transportId ||
        go.grant.propertyCode !== input.target?.propertyCode || target.confirmation !== input.confirmation ||
        target.arrival !== input.currentArrival) throw new HmsApprovalError('state_changed');
    const { executeHmsWorkerRun } = await import('../hms/hms-service.js');
    const raw: unknown = await executeHmsWorkerRun(worker);
    const result = z.object({ status: z.string(), outcome: z.string().optional(), reason: z.string().optional(),
      failureClass: z.string().optional(), evidence: z.array(z.string()).optional() }).passthrough().parse(raw);
    return { outcome: result.status === 'succeeded' ? result.outcome ?? 'amended' : result.reason ?? 'save_unconfirmed',
      saveAttempted: result.status === 'succeeded' || result.failureClass === 'UNKNOWN', screenshots: [] };
  }
  const prepared = input.cloudPreparation;
  if (!input.target || !prepared || !input.transportId || prepared.selected.propertyCode !== input.target.propertyCode ||
      prepared.selected.confirmation !== input.confirmation || prepared.selected.arrival !== input.currentArrival ||
      squash(prepared.selected.lastName) !== squash(input.expectedLastName)) {
    return { outcome: 'fresh_preparation_required', saveAttempted: false, screenshots: [] };
  }
  const dispatchTarget: HmsDispatchTarget = { propertyCode: propertyCodeSchema.parse(input.target.propertyCode),
    kind: 'saved', confirmation: prepared.selected.confirmation, nativeStayId: prepared.selected.reservationStayId };
  const lock = paneStayCloudTargetLock(input.target, dispatchTarget, { kind: 'independent_cloud' });
  if (!lock) return { outcome: 'refused_lock_unavailable', saveAttempted: false, screenshots: [] };
  const native = await import('../../tooling/hms-cloud/pane-amend-session.mjs' as string) as {
    prepareCloudPaneAmend: (args: { target: HmsReadTarget; transportId: string; selected: HmsCloudNativePreimage;
      changes: CloudAmendChanges; confirmation: string; arrival: string; allowRealGuest: boolean;
      cloudTargetKey: string; signal?: AbortSignal }) => Promise<unknown>;
  };
  const target = input.target, transportId = input.transportId;
  return lock.withLock(async (signal) => {
    const result = z.object({ outcome: z.string(), issue: z.string().optional(),
      nativeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), screenshots: z.array(z.string()).optional() })
      .passthrough().parse(await native.prepareCloudPaneAmend({ target, transportId, ...prepared,
        confirmation: input.confirmation, arrival: input.currentArrival, cloudTargetKey: hmsDispatchTargetKey(dispatchTarget), signal }));
    return { outcome: result.outcome === 'prepared' ? 'previewed' : result.issue ?? result.outcome,
      saveAttempted: false, screenshots: result.screenshots ?? [], previewDigest: result.nativeDigest ?? null };
  }, acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
}

export type PaneAmendPreviewInput = {
  confirmation: string; arrival: string; lastName: string; fields: AmendRequest;
  propertyCode?: string; transportId?: string;
  cloudPreparation?: PaneAmendSpawnInput['cloudPreparation'];
  approvedRun?: PaneAmendSpawnInput['approvedRun'];
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

async function runPaneAmend(mode: 'preview' | 'commit',
  input: PaneAmendPreviewInput & { owner: string; previewDigest?: string }): Promise<PaneAmendResult> {
  const transportId = input.transportId ?? paneStayTransportIdFromOwner(input.owner);
  const resolved = paneStayHmsTargetForTransport(transportId, input.propertyCode);
  if (!resolved.ok) return refusedAmend('refused_unknown_transport');
  const result = await spawnAmendStay({ mode, target: resolved.target, transportId,
    confirmation: input.confirmation, currentArrival: input.arrival, expectedLastName: input.lastName,
    fields: input.fields, previewDigest: input.previewDigest, cloudPreparation: input.cloudPreparation,
    approvedRun: input.approvedRun });
  return { outcome: result.outcome, screenshots: result.screenshots, runId: null,
    previewDigest: result.previewDigest ?? null, changedFieldsReadback: result.changedFieldsReadback ?? null };
}

export const previewAmend = (input: PaneAmendPreviewInput & { owner: string }) => runPaneAmend('preview', input);
export const commitAmend = (input: PaneAmendPreviewInput & { owner: string; previewDigest: string }) =>
  runPaneAmend('commit', input);

type SaveOutcome = {
  outcome: string;
  clickedOk: boolean;
  uploadSent: boolean;
  saveAttempted?: boolean;
  listed?: boolean;
  screenshots: string[];
  runDir?: string;
  cleanupRoot?: string;
  documentCode?: string;
  nativeReadback?: Record<string, unknown>;
  dispatchCallbacksDrained?: boolean;
  writerSessionClosed?: boolean;
};

/**
 * Cancel CLI stayChanges compares every expected key. readStayFields only returns STAY_FIELDS
 * (cancel-stay-rules.mjs). Lookup may carry depositReceived for the amend classifier; cancel must not.
 */
export async function saveAttach(
  form: AttachForm,
  file: string | null,
  target: HmsReadTarget,
  allowRealGuest: boolean,
  cloud?: Pick<PaneAttachSpawnInput, 'approvedStay' | 'approvedSnapshot' | 'guestName' | 'cloudTargetKey' | 'signal' | 'transportId' |
    'beforeDispatch' | 'finalAuthority' | 'continuationAllowed' | 'dispatchWithAuthority' | 'staffGo' | 'heldTargetLock' | 'worker'>,
): Promise<SaveOutcome> {
  if (!cloud || !form.pdfSha256) {
    return { outcome: 'refused_cloud_upload_unavailable', clickedOk: false, uploadSent: false, screenshots: [] };
  }
  if (!file) throw new Error('attach_file_missing');
  const spawn = paneHmsWriteLoaders.spawnAttach ?? spawnAttachDocument;
  const result = await spawn({
    confirmation: form.confirmation,
    arrival: form.arrival,
    file,
    documentName: form.documentName,
    ...(form.documentDescription ? { documentDescription: form.documentDescription } : {}),
    documentCode: form.documentCode,
    allowRealGuest,
    target,
    ...(cloud ? { ...cloud, pdfSha256: form.pdfSha256 } : {}),
  });
  return {
    outcome: result.outcome,
    clickedOk: false,
    uploadSent: result.uploadSent,
    listed: result.listed === true,
    screenshots: result.screenshots,
    runDir: result.runDir,
    cleanupRoot: result.cleanupRoot,
    documentCode: result.documentCode,
    nativeReadback: result.nativeReadback,
    dispatchCallbacksDrained: result.dispatchCallbacksDrained,
    writerSessionClosed: result.writerSessionClosed,
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
  const done = action === 'attach_document' ? saved.outcome === 'attached' ||
    (saved.outcome === 'confirmed' && saved.listed === true)
    : saved.outcome === (action === 'cancel' ? 'cancelled' : 'amended');
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
  input: { transportId: string; workItemId: string; runId: string; saved: SaveOutcome;
    receipts?: Record<string, { eventId: string; sha256: string }> },
): Promise<string[]> {
  const recorded: string[] = [];
  if (!input.saved.runDir) return recorded;
  const present = new Set(input.saved.screenshots.map((path) => basename(path)));
  for (const name of EVIDENCE_NAMES) {
    if (!present.has(name)) continue;
    if (input.receipts?.[name]) { recorded.push(name); continue; }
    try {
      const png = await readFile(join(input.saved.runDir, name));
      const sealed = await recordHmsWriteEvidence({
        db,
        transportId: input.transportId,
        workItemId: input.workItemId,
        runId: input.runId,
        name,
        png,
      });
      recorded.push(name);
      if (input.receipts) input.receipts[name] = { eventId: sealed.eventId, sha256: sealed.sha256 };
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
  | { status: 'succeeded'; action: HmsWriteForm['action']; outcome: string; evidence: string[];
      observationRef?: string; nativeReadbackDigest?: string }
  | { status: 'ended'; failureClass: AiFailureClass; reason: string; outcome?: 'confirmed'; listed?: true }
  | { status: 'lease_lost' };

async function endConfirmedWithHold(db: DB, fence: AiRunFence): Promise<PaneHmsWriteResult> {
  const ended = await endRun(db, fence, 'UNKNOWN', 'confirmed_hold_unsettled');
  return ended.status === 'ended' ? { ...ended, outcome: 'confirmed', listed: true } : ended;
}

type ExecuteInput = {
  go: VerifiedStaffGo;
  target: HmsReadTarget;
  heldTargetLock?: HeldTargetAliasLock;
  dispatchTarget?: HmsDispatchTarget;
  db: DB;
  fence: AiRunFence;
  transportId: string;
  workItemId: string;
  form: HmsWriteForm;
  file: string | null;
  runDirs: string[];
  pendingCloudEvidence: Map<string, boolean>;
  signal?: AbortSignal;
  allowRealGuest: boolean;
  env: NodeJS.Dict<string>;
};

/** Re-stage and dispatch while the worker owns every target alias. */
async function executeUnderLock(input: ExecuteInput): Promise<PaneHmsWriteResult> {
  const { db, fence, form } = input;
  const target = input.target;
  const property = getPropertyRegistration(target.propertyCode);
  if (!property || !input.dispatchTarget) return endRun(db, fence, 'POLICY_BLOCK', 'target_unavailable');
  assertTargetAliasesHeld(input.heldTargetLock, { tenantId: property.expectedTenant, propertyCode: property.propertyCode,
    targetAliases: [...input.go.preparation.targetAliases, ...hmsDispatchTargetKeys(input.dispatchTarget)] });
  let consumed: Awaited<ReturnType<typeof consumeHmsWriteApproval>>;
  try {
    consumed = await consumeHmsWriteApproval({ db, runId: fence.runId, fence });
  } catch (error) {
    if (!(error instanceof HmsApprovalError)) throw error;
    return error.refusal === 'lease_lost'
      ? { status: 'lease_lost' }
      : endRun(db, fence, 'NEEDS_CHECK', error.refusal);
  }
  if (!consumed.verifiedStaffGo || consumed.verifiedStaffGo.grant.grantId !== input.go.grant.grantId) {
    return endRun(db, fence, 'NEEDS_CHECK', 'fresh_preparation_required');
  }
  // The grant binds the form digest. The approved form must equal the one the policy read, or the file to upload may differ.
  const approved = parseHmsWriteForm(consumed.form);
  if (!approved || canonicalJson(approved) !== canonicalJson(form)) {
    return endRun(db, fence, 'NEEDS_CHECK', 'form_changed');
  }
  if (approved.action === 'cancel') {
    if (!approved.cloudCancel || !input.dispatchTarget ||
        approved.confirmation !== approved.cloudCancel.preimage.confirmation ||
        approved.arrival !== approved.cloudCancel.preimage.arrival ||
        approved.lastName !== approved.cloudCancel.preimage.lastName ||
        approved.reason !== approved.cloudCancel.reasonLabel) return endRun(db, fence, 'POLICY_BLOCK', 'cancel_unavailable');
    return executeCloudCancel({ db, fence, transportId: input.transportId, workItemId: input.workItemId,
      target, dispatchTarget: input.dispatchTarget, bound: approved.cloudCancel, consumed, go: input.go, heldTargetLock: input.heldTargetLock, env: input.env,
      runDirs: input.runDirs, pendingCloudEvidence: input.pendingCloudEvidence, signal: input.signal });
  }
  const isCloudAttach = approved.action === 'attach_document';
  const parsedFiling = isCloudAttach ? boundFilingFormSchema.safeParse(approved) : null;
  if (isCloudAttach && !parsedFiling?.success) return endRun(db, fence, 'POLICY_BLOCK', 'form_invalid');
  const filing = parsedFiling?.success ? parsedFiling.data : null;
  if (filing && consumed.hmsBeforeDigest !== filing.filingStateDigest) {
    return endRun(db, fence, 'NEEDS_CHECK', 'filing_target_changed');
  }
  const request = { confirmation: approved.confirmation, arrival: approved.arrival };
  const readCloud = paneHmsWriteLoaders.readCloudFiling ?? readCloudFilingRecord;
  const dispatchTarget = input.dispatchTarget;
  const cloudTargetKey = dispatchTarget ? hmsDispatchTargetKey(dispatchTarget) : undefined;
  const cloudStay = isCloudAttach ? await readCloud(request, target, { allowRealGuest: input.allowRealGuest, cloudTargetKey, transportId: input.transportId }) : null;
  if (isCloudAttach && (!cloudStay || dispatchTarget?.kind !== 'saved' ||
      cloudStay.nativeStayId !== dispatchTarget.nativeStayId || cloudStay.stay.confirmation !== dispatchTarget.confirmation)) {
    return endRun(db, fence, 'NEEDS_CHECK', 'filing_target_changed');
  }
  // This epoch is captured only after the native target was re-read under its lock.
  const dispatchEpoch = isCloudAttach && dispatchTarget
    ? await captureHmsLabtestDispatchEpoch(db, dispatchTarget, input.workItemId).catch(() => null) : null;
  if (isCloudAttach && dispatchEpoch === null) return endRun(db, fence, 'NEEDS_CHECK', 'filing_target_unavailable');
  const found = isCloudAttach ? { outcome: cloudStay ? 'found' : 'execution_failure', stay: cloudStay?.stay ?? null }
    : await findStay(request, { lock: () => HELD_LOCK, onRun: ({ dir }) => input.runDirs.push(dir), target, transportId: input.transportId });
  if (found.outcome !== 'found' || !found.stay) {
    return endRun(db, fence, 'NEEDS_CHECK', `read_${found.outcome}`);
  }
  const stay = found.stay;
  const identity = stayRefusal(stay, approved, { allowRealGuest: input.allowRealGuest });
  if (identity) return endRun(db, fence, 'NEEDS_CHECK', identity);
  let pre: HmsPreSaveOutcome;
  try {
    pre = await assertHmsUnchangedBeforeSave({
      db,
      runId: fence.runId,
      fence,
      readHmsState: async () => cloudStay ? filingState(cloudStay) : stay,
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
  const dispatch: { handle: HmsLabtestWriteHandle | null; attempted: boolean; provedAuthorityRefusal: boolean; provedNoDispatch: boolean; guestId: string | null;
    nativeStayId: string | null;
    stay: PaneStayFields | null; filingSnapshot: FilingSnapshot | null; code: string | null; requestDigest: string | null;
    before: { eventId: string; sha256: string } | null; recovery: Record<string, unknown> | null } =
    { handle: null, attempted: false, provedAuthorityRefusal: false, provedNoDispatch: false, guestId: null, nativeStayId: null,
      stay: null, filingSnapshot: null,
      code: null, requestDigest: null, before: null, recovery: null };
  // A backward wall-clock adjustment must not extend the remaining write budget.
  const finishCutoff = performance.now() + fence.deadlineAt.getTime() - Date.now() - CLOUD_ATTACH_FINISH_RESERVE_MS;
  const hasFinishBudget = () => !input.signal?.aborted && Number.isFinite(finishCutoff) && performance.now() <= finishCutoff &&
    fence.deadlineAt.getTime() - Date.now() >= CLOUD_ATTACH_FINISH_RESERVE_MS;
  try {
    const cloud = filing && cloudStay ? {
      approvedStay: { ...stay, propertyCode: target.propertyCode, nativeGuestId: cloudStay.nativeGuestId, nativeStayId: cloudStay.nativeStayId,
        allowRealGuest: input.allowRealGuest },
      guestName: `${stay.firstName} ${stay.lastName}`,
      cloudTargetKey, signal: input.signal, transportId: input.transportId,
      staffGo: input.go, heldTargetLock: input.heldTargetLock, worker: { db, fence },
      approvedSnapshot: cloudStay.filingSnapshot,
      continuationAllowed: hasFinishBudget,
      beforeDispatch: async () => {
        if (!hasFinishBudget()) return false;
        dispatch.stay = cloudStay.stay;
        dispatch.guestId = cloudStay.nativeGuestId;
        dispatch.nativeStayId = cloudStay.nativeStayId;
        dispatch.filingSnapshot = cloudStay.filingSnapshot;
        const current = await assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence,
          readHmsState: async () => filingState(cloudStay) });
        if (current.status !== 'unchanged') return false;
        const bytes = await readBoundFilingSource({ db, transportId: input.transportId,
          workItemId: input.workItemId, form: filing, fence });
        return hasFinishBudget() && !!bytes && pdfBytesHash(bytes) === filing.pdfSha256 &&
          await currentFilingSelection(db, input.transportId, { threadId: filing.sourceThreadId,
            messageId: filing.sourceMessageId, sourceHash: filing.sourceHash });
      },
      finalAuthority: async (code: string) => {
        if (!/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(code) || !dispatch.stay || !dispatch.guestId || !dispatch.nativeStayId ||
            !dispatch.filingSnapshot || dispatch.handle || !hasFinishBudget()) return false;
        return (await assertHmsUnchangedBeforeSave({ db, runId: fence.runId, fence,
          readHmsState: async () => filingState({ stay: dispatch.stay!, nativeGuestId: dispatch.guestId!,
            nativeStayId: dispatch.nativeStayId!, filingSnapshot: dispatch.filingSnapshot! }) })).status === 'unchanged';
      },
      dispatchWithAuthority: async (code: string, nativeGuestId: string, nativeStayId: string, requestDigest: string,
        continueOnce: NativeAttachContinuation, writer: unknown, beforeShot: string, interceptedRequest: unknown) => {
        if (dispatchEpoch === null || !consumed.sessionId || !consumed.sessionProfile || !dispatch.stay ||
            !dispatch.filingSnapshot || dispatch.handle ||
            dispatchTarget?.kind !== 'saved' || typeof dispatch.stay.firstName !== 'string' ||
            typeof dispatch.stay.lastName !== 'string' || typeof dispatch.stay.departure !== 'string' || !hasFinishBudget() ||
            !cloudWriterCurrent(writer) ||
            nativeGuestId !== dispatch.guestId || !/^\d{1,30}$/.test(nativeGuestId) ||
            nativeStayId !== dispatch.nativeStayId || nativeStayId !== dispatchTarget.nativeStayId ||
            !/^NAVA[A-Z2-7]{25}[AEIMQUY4]$/.test(code) || !/^[a-f0-9]{64}$/.test(requestDigest)) {
          throw new Error('attachment_authority_unavailable');
        }
        const evidenceDir = dirname(beforeShot), root = dirname(evidenceDir);
        if (basename(beforeShot) !== 'before.png' || !basename(evidenceDir).startsWith('hms-document-') ||
            !basename(root).startsWith('pane-cloud-attach-') || dirname(root) !== tmpdir()) {
          throw new Error('attachment_before_evidence_unavailable');
        }
        const sealedBefore = await recordHmsWriteEvidence({ db, transportId: input.transportId,
          workItemId: input.workItemId, runId: fence.runId, name: 'before.png', png: await readFile(beforeShot) });
        dispatch.before = { eventId: sealedBefore.eventId, sha256: sealedBefore.sha256 };
        if (!hasFinishBudget()) throw new HmsApprovalError('lease_lost');
        const sourceDigest = filing.sourceSnapshotDigest, approvedDigest = formDigest(consumed.form);
        const sessionId = consumed.sessionId, sessionProfile = consumed.sessionProfile;
        const recovery = { confirmation: filing.confirmation, arrival: filing.arrival, departure: dispatch.stay.departure,
          documentCode: code, documentName: filing.documentName, pdfSha256: filing.pdfSha256,
          ...(filing.documentDescription ? { documentDescription: filing.documentDescription } : {}),
          nativeStayId, guestName: `${dispatch.stay.firstName} ${dispatch.stay.lastName}`,
          cmsSend: dispatch.filingSnapshot.cmsSend,
          allowRealGuest: input.allowRealGuest, ...(cloudTargetKey ? { cloudTargetKey } : {}),
          runId: fence.runId, claimDigest: pdfBytesHash(Buffer.from(canonicalJson({ claimOwner: fence.claimOwner,
            claimToken: fence.claimToken }))), before: dispatch.before, writer };
        dispatch.recovery = recovery;
        dispatch.attempted = true;
        let authorityRefusal: HmsApprovalError | null = null;
        let authorizationStarted = false;
        try {
          dispatch.handle = await claimHmsLabtestDispatch(db, { workItemId: input.workItemId, transportId: input.transportId,
            actorUserId: consumed.actorUserId, grantId: consumed.grantId, propertyCode: propertyCodeSchema.parse(target.propertyCode),
            firstName: dispatch.stay.firstName, lastName: dispatch.stay.lastName, target: dispatchTarget,
            nativeGuestId, operation: 'attach_document', sourceDigest, approvedDigest, requestDigest, recovery },
          async (tx, claim) => {
            authorizationStarted = true;
            if (claim.requestDigest !== requestDigest || canonicalJson(claim.recovery) !== canonicalJson(recovery)) {
              throw new Error('attachment_recovery_changed');
            }
            try {
              if (!hasFinishBudget()) throw new HmsApprovalError('lease_lost');
              assertTargetAliasesHeld(input.heldTargetLock, { tenantId: property.expectedTenant, propertyCode: property.propertyCode,
                targetAliases: [...input.go.preparation.targetAliases, ...hmsDispatchTargetKeys(dispatchTarget)] });
              const verified = await verifyStaffGoForRun(tx, fence);
              if (verified.grant.grantId !== input.go.grant.grantId || verified.grant.operation !== 'attach_document') {
                throw new HmsApprovalError('state_changed');
              }
              await authorizeConsumedLabtestAttach(tx, { fence, transportId: input.transportId, workItemId: input.workItemId,
                grantId: consumed.grantId, actorUserId: consumed.actorUserId, sessionId, sessionProfile, sourceDigest, approvedDigest,
                confirmation: filing.confirmation, arrival: filing.arrival, documentCode: code, documentName: filing.documentName,
                pdfSha256: filing.pdfSha256, env: input.env,
                lockSource: (lockedTx) => lockBoundFilingSource(lockedTx, { transportId: input.transportId,
                  workItemId: input.workItemId, form: filing }) });
              if (!hasFinishBudget()) throw new HmsApprovalError('lease_lost');
            } catch (error) {
              if (error instanceof HmsApprovalError) authorityRefusal = error;
              throw error;
            }
          }, dispatchEpoch);
        } catch (error) {
          // The shared claim checks occupancy before authorization and inserts
          // only after authorization returns. An occupied refusal before the
          // callback starts therefore proves no intent was inserted by us.
          // Changed errors and ambiguous commit acknowledgements stay unknown.
          dispatch.provedAuthorityRefusal = (authorityRefusal !== null && error === authorityRefusal) ||
            (!authorizationStarted && error instanceof HmsLabtestDispatchError && error.reason === 'occupied');
          throw error;
        }
        dispatch.code = code;
        dispatch.requestDigest = requestDigest;
        try {
          if (!hasFinishBudget()) throw new Error('attachment_finish_deadline_unavailable');
          // A confirmed commit authorizes exactly this already-intercepted request.
          return await continueOnce();
        } catch (error) {
          // A permanently disarmed gate can prove this exact request never left.
          // An attempted send, a lost claim acknowledgement or a failed resolution stays UNKNOWN.
          const proof = continueOnce.proveNeverDispatched?.();
          if (proof && dispatch.handle) {
            try {
              await resolveNeverDispatchedAttach(db, dispatch.handle, proof, interceptedRequest, async (tx, intent) => {
                if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
                    intent.actorUserId !== consumed.actorUserId || intent.grantId !== consumed.grantId ||
                    intent.requestDigest !== requestDigest || canonicalJson(intent.recovery) !== canonicalJson(recovery)) {
                  throw new Error('filing_no_dispatch_scope_changed');
                }
                await recordNeverDispatchedAttach(tx, intent, fence);
              });
              dispatch.handle = null;
              dispatch.provedNoDispatch = true;
            } catch { /* Keep the hold on any uncertain resolution. */ }
          }
          throw error;
        }
      },
    } : undefined;
    if (approved.action !== 'attach_document') {
      clearInterval(beat);
      return endRun(db, fence, 'NEEDS_CHECK', 'fresh_preparation_required');
    }
    saved = await saveAttach(approved, input.file, target, input.allowRealGuest, cloud);
  } catch (error) {
    clearInterval(beat);
    // A failed dispatch acknowledgment remains uncertain until fresh readback proves its outcome.
    warnPaneStaySpawnFailed('pane_hms_write', error);
    return endRun(db, fence, 'UNKNOWN', 'save_failed');
  }
  clearInterval(beat);
  const safeCloudRoot = Boolean(saved.cleanupRoot && dirname(saved.cleanupRoot) === tmpdir() &&
    basename(saved.cleanupRoot).startsWith('pane-cloud-attach-'));
  const safeCloudEvidence = Boolean(safeCloudRoot && saved.runDir && dirname(saved.runDir) === saved.cleanupRoot &&
    basename(saved.runDir).startsWith('hms-document-'));
  if (isCloudAttach) {
    if (safeCloudRoot && saved.cleanupRoot) {
      const dir = await lstat(saved.cleanupRoot).catch(() => null);
      if ((saved.uploadSent || dispatch.attempted) && dir?.isDirectory() &&
          dir.uid === process.getuid?.() && !(dir.mode & 0o077)) {
        // A possible upload must not destroy its only local screenshot if sealing fails.
        input.pendingCloudEvidence.set(saved.cleanupRoot, false);
      } else input.runDirs.push(saved.cleanupRoot);
    }
    if (!safeCloudEvidence) saved.screenshots = [];
  } else if (saved.runDir) input.runDirs.push(saved.runDir);
  const confirmedListing = saved.outcome === 'confirmed' && saved.listed === true;
  if (isCloudAttach && !confirmedListing && dispatch.provedNoDispatch) {
    return { status: 'ended', failureClass: 'NEEDS_CHECK', reason: 'filing_not_dispatched' };
  }
  if (isCloudAttach && !confirmedListing && saved.uploadSent && !dispatch.handle) return endRun(db, fence, 'UNKNOWN', 'target_hold_missing');
  if (isCloudAttach && !confirmedListing && dispatch.provedAuthorityRefusal && !dispatch.handle && !saved.uploadSent &&
      saved.dispatchCallbacksDrained === true && saved.writerSessionClosed === true) {
    // A fresh Go may follow after the refused run clears its stale snapshot.
    return endRun(db, fence, 'NEEDS_CHECK', 'filing_authority_refused');
  }
  if (isCloudAttach && !confirmedListing && dispatch.attempted && (!dispatch.handle || !saved.uploadSent)) {
    return endRun(db, fence, 'UNKNOWN', 'dispatch_claim_unresolved');
  }
  const receipts: Record<string, { eventId: string; sha256: string }> = dispatch.before ? { 'before.png': dispatch.before } : {};
  const evidence = await recordEvidence(db, {
    transportId: input.transportId,
    workItemId: input.workItemId,
    runId: fence.runId,
    saved,
    receipts,
  });
  if (saved.cleanupRoot && receipts['before.png'] && receipts['after.png'] &&
      input.pendingCloudEvidence.has(saved.cleanupRoot)) input.pendingCloudEvidence.set(saved.cleanupRoot, true);
  const verdict = classifySave(approved.action, saved);
  if (!verdict.ok) return endRun(db, fence, verdict.failureClass, verdict.reason);
  if (isCloudAttach && filing) {
    const before = receipts['before.png'], after = receipts['after.png'];
    const nativeReadback = z.object({ confirmation: z.string(), nativeStayId: z.string().regex(/^\d{1,100}$/),
      nativeGuestId: z.string().regex(/^\d{1,30}$/), documentCode: z.string(), documentName: z.string(),
      uniqueFreshListing: z.literal(true) }).strict().safeParse(saved.nativeReadback);
    if (!dispatch.handle || !dispatch.code || !dispatch.requestDigest || saved.documentCode !== dispatch.code ||
        saved.listed !== true || !before || !after || saved.dispatchCallbacksDrained !== true || saved.writerSessionClosed !== true ||
        !nativeReadback.success || nativeReadback.data.confirmation !== filing.confirmation ||
        nativeReadback.data.nativeStayId !== dispatch.nativeStayId || nativeReadback.data.nativeGuestId !== dispatch.guestId ||
        nativeReadback.data.documentCode !== dispatch.code || nativeReadback.data.documentName !== filing.documentName) {
      // The metadata listing can be confirmed while the separate write hold remains open.
      return endConfirmedWithHold(db, fence);
    }
    const recovery = dispatch.recovery;
    if (!recovery) return endConfirmedWithHold(db, fence);
    const readbackDigest = pdfBytesHash(Buffer.from(canonicalJson(nativeReadback.data)));
    let observationRef: string | undefined;
    try {
      await resolveHmsLabtestDispatch(db, dispatch.handle, { operation: 'attach_document', confirmation: filing.confirmation,
        nativeStayId: nativeReadback.data.nativeStayId, nativeReadback: nativeReadback.data,
        readbackDigest, savedShot: { runId: fence.runId, sha256: after.sha256 } }, async (tx, intent) => {
        if (intent.workItemId !== input.workItemId || intent.transportId !== input.transportId ||
            intent.actorUserId !== consumed.actorUserId || intent.grantId !== consumed.grantId ||
            intent.sourceDigest !== filing.sourceSnapshotDigest || intent.approvedDigest !== formDigest(consumed.form) ||
            intent.requestDigest !== dispatch.requestDigest || intent.nativeGuestId !== dispatch.guestId ||
            canonicalJson(intent.recovery) !== canonicalJson(recovery)) throw new Error('filing_result_changed');
        for (const [name, receipt] of [['before.png', before], ['after.png', after]] as const) {
          const [event] = await tx.select({ value: workEvent.value, evidence: workEvent.evidence, actorKind: workEvent.actorKind })
            .from(workEvent).where(and(eq(workEvent.id, receipt.eventId), eq(workEvent.workItemId, input.workItemId),
              eq(workEvent.type, 'write.evidence'))).limit(1).for('share');
          const values = z.object({ runId: z.string(), name: z.string() }).safeParse(event?.value);
          const image = z.object({ sha256: z.string().regex(PDF_SHA256) }).passthrough().safeParse(event?.evidence);
          if (event?.actorKind !== 'system' || !values.success || values.data.runId !== fence.runId || values.data.name !== name ||
              !image.success || image.data.sha256 !== receipt.sha256) throw new Error('filing_evidence_changed');
        }
        const [run] = await tx.select({ metrics: aiWorkflowRun.metrics, deadlineAt: aiWorkflowRun.deadlineAt }).from(aiWorkflowRun)
          .where(and(eq(aiWorkflowRun.id, fence.runId), eq(aiWorkflowRun.runKind, HMS_WRITE_RUN_KIND),
            eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
            inArray(aiWorkflowRun.state, ['claimed', 'running']))).limit(1).for('update');
        if (!run?.deadlineAt || run.deadlineAt.getTime() !== fence.deadlineAt.getTime() || Date.now() >= run.deadlineAt.getTime()) {
          throw new Error('filing_lease_lost');
        }
        if (!consumed.verifiedStaffGo) {
          const now = new Date();
          await tx.update(aiWorkflowRun).set({ state: 'succeeded', finishedAt: now, updatedAt: now,
            claimOwner: null, claimToken: null,
            metrics: mergeTerminalRunMetrics(run.metrics, { action: 'attach_document', outcome: 'confirmed', listed: true })
          }).where(eq(aiWorkflowRun.id, fence.runId));
        }
      });
      const resolved = await db.select({ id: workEvent.id, value: workEvent.value }).from(workEvent).where(and(
        eq(workEvent.workItemId, input.workItemId), eq(workEvent.type, 'write.evidence'), eq(workEvent.actorKind, 'system'),
        eq(workEvent.fieldPath, 'nava.hms.labtest.dispatch.v1'),
        sql`${workEvent.value}->>'holdId' = ${dispatch.handle.holdId}`,
        sql`${workEvent.value}->>'kind' = 'resolved'`)).limit(2);
      const receipt = z.object({ version: z.literal(1), kind: z.literal('resolved'),
        holdId: z.literal(dispatch.handle.holdId), operation: z.literal('attach_document'),
        confirmation: z.literal(filing.confirmation), nativeStayId: z.literal(nativeReadback.data.nativeStayId),
        readbackDigest: z.literal(readbackDigest), nativeReadback: z.record(z.string(), z.unknown()),
        savedShot: z.object({ runId: z.literal(fence.runId), sha256: z.literal(after.sha256) }).strict()
      }).passthrough().safeParse(resolved[0]?.value);
      if (resolved.length !== 1 || !receipt.success ||
          canonicalJson(receipt.data.nativeReadback) !== canonicalJson(nativeReadback.data)) {
        throw new Error('filing_resolution_receipt_unverified');
      }
      observationRef = resolved[0]!.id;
    } catch { return endConfirmedWithHold(db, fence); }
    // The native result is already durable. A review-marker failure must not turn
    // a confirmed upload into an uncertain write or trigger another upload.
    try {
      await db.transaction((tx) => recordConfirmedVoucherFile(tx, { transportId: input.transportId, workItemId: input.workItemId,
        source: { threadId: filing.sourceThreadId, messageId: filing.sourceMessageId, sourceHash: filing.sourceHash },
        attachmentId: filing.attachmentId, pdfSha256: filing.pdfSha256,
        snapshotDigest: filing.sourceSnapshotDigest, runId: fence.runId }));
    } catch { console.warn('voucher_review_confirmation_not_recorded'); }
    return { status: 'succeeded', action: 'attach_document', outcome: 'confirmed', evidence,
      observationRef, nativeReadbackDigest: readbackDigest };
  }
  const marked = await markAiRunSucceeded(
    {
      runId: fence.runId,
      claimOwner: fence.claimOwner,
      claimToken: fence.claimToken,
      expectedStates: ['claimed', 'running'],
      metrics: {
        action: approved.action,
        outcome: verdict.outcome,
        ...(approved.action === 'attach_document' ? { listed: saved.listed === true } : {}),
      },
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
  pendingCloudEvidence: Map<string, boolean>,
  signal?: AbortSignal,
  go?: VerifiedStaffGo,
): Promise<PaneHmsWriteResult> {
  if (runId !== fence.runId) return { status: 'lease_lost' };
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
  if (!form) return endRun(db, fence, 'POLICY_BLOCK', 'form_invalid');
  let verified: VerifiedStaffGo;
  try { verified = await db.transaction((tx) => verifyStaffGoForRun(tx, fence)); }
  catch { return endRun(db, fence, 'NEEDS_CHECK', 'fresh_preparation_required'); }
  if ((go && go.grant.grantId !== verified.grant.grantId) || verified.grant.operation !== form.action ||
      verified.grant.workItemId !== workItemId || verified.grant.transportId !== transportId) {
    return endRun(db, fence, 'NEEDS_CHECK', 'form_changed');
  }
  const resolved = paneStayHmsTargetForTransport(transportId, verified.grant.propertyCode);
  if (!resolved.ok) return endRun(db, fence, 'POLICY_BLOCK', 'refused_unknown_transport');
  const target = resolved.target;
  const attachMode = effectiveWorkflowPolicy(env, verified.grant.propertyCode, 'attach').admittedMode;
  const admittedCancelMode = effectiveWorkflowPolicy(env, verified.grant.propertyCode, 'cancel').admittedMode;
  const selectedCancelMode = verified.grant.propertyCode === 'HRCEN' ? paneWriteMode('cancel', 'unpaid', env) : admittedCancelMode;
  const cancelMode = admittedCancelMode === 'off' || selectedCancelMode === 'off' ? 'off'
    : admittedCancelMode === 'lab' || selectedCancelMode === 'lab' ? 'lab' : 'on';
  if (form.action === 'amend') return endRun(db, fence, 'NEEDS_CHECK', 'fresh_preparation_required');
  const isCloudCancel = form.action === 'cancel';
  if (form.action === 'attach_document') {
    if (attachMode === 'off') return endRun(db, fence, 'POLICY_BLOCK', 'refused_flag_off');
  } else if (cancelMode === 'off') {
    return endRun(db, fence, 'POLICY_BLOCK', 'refused_flag_off');
  }
  const allowRealGuest = form.action === 'attach_document' ? attachMode === 'on'
    : isCloudCancel && cancelMode === 'on';
  const refusal = formRefusal(form, { allowRealGuest });
  if (refusal) return endRun(db, fence, 'POLICY_BLOCK', refusal);

  const isCloudAttach = form.action === 'attach_document';
  const parsedFiling = isCloudAttach ? boundFilingFormSchema.safeParse(form) : null;
  if (isCloudAttach && ((verified.grant.propertyCode === 'HRCEN' && !labtestAttachEnabled(env)) || !parsedFiling?.success)) {
    return endRun(db, fence, 'POLICY_BLOCK', 'refused_cloud_upload_unavailable');
  }
  if (isCloudCancel && (form.action !== 'cancel' || !form.cloudCancel ||
      (form.cloudCancel.preimage.allowRealGuest && cancelMode !== 'on'))) {
    return endRun(db, fence, 'POLICY_BLOCK', 'cancel_unavailable');
  }
  if (parsedFiling?.success && !await currentFilingSelection(db, transportId, { threadId: parsedFiling.data.sourceThreadId,
    messageId: parsedFiling.data.sourceMessageId, sourceHash: parsedFiling.data.sourceHash })) {
    return endRun(db, fence, 'POLICY_BLOCK', 'source_mail_changed');
  }

  // Read before consume: a refused read ends the run with nothing consumed.
  let file: string | null = null;
  if (form.action === 'attach_document') {
    if (!item?.sourceMessageId) return endRun(db, fence, 'POLICY_BLOCK', 'source_mail_missing');
    const read = { transportId, sourceMessageId: item.sourceMessageId, attachmentId: form.attachmentId };
    const pdf = parsedFiling?.success
      ? await readBoundFilingSource({ db, transportId, workItemId, form: parsedFiling.data, fence })
      : await (paneHmsWriteLoaders.readAttachment ?? ((at) => readApprovedAttachment(db, at)))(read);
    if (!Buffer.isBuffer(pdf)) return endRun(db, fence, 'POLICY_BLOCK', typeof pdf === 'string' ? pdf : 'attachment_not_found');
    const notPdf = pdfRefusal(pdf);
    if (notPdf) return endRun(db, fence, 'POLICY_BLOCK', notPdf);
    if (form.pdfSha256 && pdfBytesHash(pdf) !== form.pdfSha256) {
      return endRun(db, fence, 'POLICY_BLOCK', 'attachment_hash_changed');
    }
    const work = await mkdtemp(join(tmpdir(), 'pane-hms-write-'));
    runDirs.push(work);
    file = join(work, 'upload.pdf');
    await writeFile(file, pdf, { mode: 0o600 });
  }

  // Find the native identity before taking its per-target Cloud lock. The same
  // identity is re-read under that lock before the dispatch epoch is captured.
  let dispatchTarget: HmsDispatchTarget | undefined;
  if (isCloudAttach) {
    const initial = await (paneHmsWriteLoaders.readCloudFiling ?? readCloudFilingRecord)(
      { confirmation: form.confirmation, arrival: form.arrival }, target, { allowRealGuest, transportId });
    if (!initial || stayRefusal(initial.stay, form, { allowRealGuest })) {
      return endRun(db, fence, 'NEEDS_CHECK', 'filing_target_unavailable');
    }
    dispatchTarget = { propertyCode: verified.grant.propertyCode, kind: 'saved', confirmation: initial.stay.confirmation!,
      nativeStayId: initial.nativeStayId };
  } else if (isCloudCancel && form.action === 'cancel' && form.cloudCancel) {
    const initial = await readCloudCancelPreimage({ target, confirmation: form.confirmation, arrival: form.arrival,
      allowRealGuest: form.cloudCancel.preimage.allowRealGuest, transportId, signal });
    if (!initial || canonicalJson(cancelBusinessPreimage(initial, form.cloudCancel.preimage)) !==
        canonicalJson(form.cloudCancel.preimage)) {
      return endRun(db, fence, 'NEEDS_CHECK', 'cancel_target_unavailable');
    }
    dispatchTarget = { propertyCode: verified.grant.propertyCode, kind: 'saved', confirmation: initial.confirmation,
      nativeStayId: initial.nativeStayId };
  }
  const lock = paneHmsWriteLoaders.lock ?? (dispatchTarget
    ? paneStayCloudTargetLock(target, dispatchTarget, { kind: 'independent_cloud', targetAliases: verified.preparation.targetAliases }) : paneStayPropertyLock(target));
  if (!lock) return endRun(db, fence, 'POLICY_BLOCK', 'refused_lock_unavailable');
  try {
    return await lock.withLock(
      (lockSignal, heldTargetLock) => executeUnderLock({ db, fence, transportId, workItemId, form, file, runDirs, pendingCloudEvidence,
        go: verified, target, heldTargetLock,
        allowRealGuest, dispatchTarget, env,
        signal: lockSignal && signal ? AbortSignal.any([lockSignal, signal]) : lockSignal ?? signal }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return endRun(db, fence, 'HMS_LOCK_BUSY', 'refused_lock_busy');
    throw error;
  }
}

/**
 * One claimed hms_write run (U26). Order: policy and the attachment read, both before consume. Then, under the property
 * aliases, the stay read, identity check and pre-Save check. Go consumes in the paused native-dispatch transaction.
 * Each refusal before Save ends the run with nothing written. An unexpected error propagates, and the sweep turns the
 * stale claim into LEASE_LOST, which blocks approval.
 */
export async function runPaneHmsWriteOnce(input: {
  runId: string;
  fence: AiRunFence;
  db?: DB;
  env?: NodeJS.Dict<string>;
  signal?: AbortSignal;
  go?: VerifiedStaffGo;
}): Promise<PaneHmsWriteResult> {
  const db = input.db ?? getDb();
  const runDirs: string[] = [];
  const pendingCloudEvidence = new Map<string, boolean>();
  try {
    return await runClaimed(db, input.runId, input.fence, input.env ?? process.env, runDirs, pendingCloudEvidence, input.signal, input.go);
  } finally {
    for (const [directory, sealed] of pendingCloudEvidence) {
      if (sealed) runDirs.push(directory);
      else console.warn('pane_hms_write_unsealed_evidence_retained', { runId: input.runId, directory });
    }
    await removeDirs(runDirs);
  }
}

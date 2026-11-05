import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, attachment, message } from '../db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import { panePop3AttachmentCandidate } from '../mail/artifacts/pane-pop3-attachment.js';
import { getS3Storage } from '../storage/s3.js';
import { handledRequestKeys, handledRequestStates } from './reservationist-task-completion.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { isVoucherMail, voucherFilingFiles } from './voucher-filing-file.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION } from './run-ledger.js';
import { resolveOutlookVoucherSnapshot } from './voucher-filing-source.js';

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type Source = { threadId: string; messageId: string; sourceHash: string };
type Mail = { id: string; subject: string | null; textBody: string | null; htmlBody: string | null };
type File = { id: string; messageId: string; filename: string; mimeType: string; sizeBytes: number;
  isInline: boolean; sha256: string | null; s3Key: string };

/** A decision belongs to this message revision and this exact attachment identity. */
export function voucherFileKey(transportId: string, mail: Mail, file: File): string {
  return createHash('sha256').update(JSON.stringify(['voucher-file-review/v1', transportId, mail.id,
    staffQuoteSourceHash(mail), file.id, file.sha256, file.s3Key, file.filename, file.mimeType, file.sizeBytes])).digest('hex');
}

export function voucherReviewFiles(transportId: string, kind: string, payload: unknown, mail: Mail, files: File[]) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const read = payload as Record<string, unknown>;
  if (kind !== 'booking' || read.needsAction === false || read.origin === 'system_notice' ||
      (read.action && read.action !== 'new_booking')) return [];
  const current = files.filter((file) => file.messageId === mail.id && !file.isInline);
  if (!isVoucherMail({ subject: mail.subject ?? '', bodyText: mail.textBody ?? '',
    attachmentNames: current.map((file) => file.filename) })) return [];
  const eligible = voucherFilingFiles(current);
  const named = eligible.filter((file) => /voucher|_vch_|(?:^|[^a-z0-9])(?:pop|proof[_ -]?of[_ -]?payment|remittance)(?:[^a-z0-9]|$)/i.test(file.filename));
  const candidates = named.length ? named : eligible;
  return candidates.map((file) => ({ attachmentId: file.id, key: voucherFileKey(transportId, mail, file) }));
}

async function matchesFilingSnapshot(db: WorkTx, input: { transportId: string; source: Source;
  attachmentId: string; pdfSha256: string; snapshotDigest: string }, file: File) {
  try {
    const bucket = getS3Storage().bucket;
    const identity = { transportId: input.transportId, messageId: input.source.messageId, attachmentId: input.attachmentId };
    if (file.s3Key.startsWith('attachments/')) {
      const candidate = await panePop3AttachmentCandidate({ ...identity, db: db as DB, bucket });
      return !!candidate && (!candidate.sha256 || candidate.sha256 === input.pdfSha256) &&
        createHash('sha256').update(`${candidate.fingerprint}:${input.pdfSha256}`).digest('hex') === input.snapshotDigest;
    }
    const snapshot = await resolveOutlookVoucherSnapshot(identity, { db: db as DB, storage: { bucket } });
    return snapshot?.source.sha256 === input.pdfSha256 && snapshot.source.snapshotDigest === input.snapshotDigest;
  } catch { return false; }
}

/** Older confirmed filings can still be recognized while their grant-bound form remains current. */
export async function confirmedVoucherKey(db: WorkTx, input: { transportId: string; workItemId: string;
  source: Source; state: Record<string, unknown>; files: File[]; candidates: { attachmentId: string; key: string }[] }) {
  const state = input.state;
  if (state.action !== 'attach_document' || state.sourceMessageId !== input.source.messageId ||
      state.sourceThreadId !== input.source.threadId || state.sourceHash !== input.source.sourceHash ||
      typeof state.attachmentId !== 'string' || typeof state.pdfSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.pdfSha256) || typeof state.sourceSnapshotDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state.sourceSnapshotDigest)) return null;
  const candidate = input.candidates.find((file) => file.attachmentId === state.attachmentId);
  const file = input.files.find((row) => row.id === state.attachmentId && row.messageId === input.source.messageId);
  if (!candidate || !file || file.filename !== state.documentName || (file.sha256 && file.sha256 !== state.pdfSha256)) return null;
  const [run] = await db.select({ state: aiWorkflowRun.state, metrics: aiWorkflowRun.metrics,
    promptVersion: aiWorkflowRun.promptVersion, idempotencyKey: aiWorkflowRun.idempotencyKey })
    .from(aiWorkflowRun).where(and(eq(aiWorkflowRun.workItemId, input.workItemId), eq(aiWorkflowRun.runKind, 'hms_write')))
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id)).limit(1);
  if (run?.state !== 'succeeded' || run.promptVersion !== HMS_LABTEST_ATTACH_PROMPT_VERSION ||
      run.metrics?.action !== 'attach_document' || run.metrics.outcome !== 'confirmed' || run.metrics.listed !== true ||
      !run.idempotencyKey.startsWith('hms-write:')) return null;
  const grantId = run.idempotencyKey.slice('hms-write:'.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(grantId)) return null;
  if (!await matchesFilingSnapshot(db, { transportId: input.transportId, source: input.source,
    attachmentId: state.attachmentId, pdfSha256: state.pdfSha256, snapshotDigest: state.sourceSnapshotDigest }, file)) return null;
  try {
    const { formDigest, readVerifiedHmsWriteGrant } = await import('./hms-approval.js');
    const { grant } = await readVerifiedHmsWriteGrant(db as DB, input.workItemId, grantId);
    return grant.grantId === grantId && grant.workItemId === input.workItemId && grant.transportId === input.transportId &&
      grant.formDigest === formDigest(state) ? candidate.key : null;
  } catch { return null; }
}

/** The pane can only acknowledge a file from the selected, current source. */
export async function selectedVoucherReview(db: WorkTx, input: { transportId: string; workItemId: string; source: Source },
  includeReceipt = true) {
  const [row] = await db.select({ id: workItem.id, kind: workItem.kind, status: workItem.status,
    threadId: workItem.threadId, sourceMessageId: workItem.sourceMessageId, state: workItem.state, payload: mailExtraction.payload,
    message: { id: message.id, subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
      direction: message.direction, historyOnly: message.historyOnly } })
    .from(workItem).innerJoin(message, eq(message.id, workItem.sourceMessageId))
    .leftJoin(mailExtraction, eq(mailExtraction.id, workItem.extractionId))
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
      eq(message.transportId, input.transportId))).limit(1);
  if (!row || row.threadId !== input.source.threadId || row.sourceMessageId !== input.source.messageId ||
      row.message.direction !== 'inbound' || row.message.historyOnly ||
      staffQuoteSourceHash(row.message) !== input.source.sourceHash) return null;
  const files = await db.select({ id: attachment.id, messageId: attachment.messageId, filename: attachment.filename,
    mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline,
    sha256: attachment.sha256, s3Key: attachment.s3Key }).from(attachment).where(eq(attachment.messageId, row.message.id));
  const decisions = await handledRequestStates(db as DB, { transportId: input.transportId, threadId: input.source.threadId,
    sourceIds: [input.source.messageId] });
  const handled = handledRequestKeys(decisions.get(input.source.messageId));
  const candidates = voucherReviewFiles(input.transportId, row.kind, row.payload, row.message, files);
  const confirmed = includeReceipt ? await confirmedVoucherKey(db, { ...input, state: row.state, files, candidates }) : null;
  return { status: row.status, files: candidates.map((file) => ({ ...file,
    handled: handled.has(file.key) || file.key === confirmed })) };
}

export async function acknowledgeVoucherReview(db: DB, input: { transportId: string; workItemId: string; userId: string;
  source: Source; attachmentId: string; key: string }) {
  const result = await db.transaction(async (tx) => {
    const [item] = await tx.select({ id: workItem.id, status: workItem.status }).from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1).for('update');
    if (!item || item.status === 'done' || item.status === 'dismissed') return false;
    const review = await selectedVoucherReview(tx, input);
    const file = review?.files.find((candidate) => candidate.attachmentId === input.attachmentId && candidate.key === input.key);
    if (!file) return false;
    if (!file.handled) await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'user',
      actorUserId: input.userId, type: 'request.handled', value: { key: file.key, handled: true,
        attachmentId: input.attachmentId, sourceHash: input.source.sourceHash } });
    return true;
  });
  if (result) {
    try {
      const { refreshThreadWork } = await import('./work-items.js');
      await refreshThreadWork(db, { transportId: input.transportId, threadId: input.source.threadId });
    } catch { console.warn('voucher_review_refresh_failed'); }
  }
  return result;
}

/** A confirmed/listed native filing handles only the source file that was approved. */
export async function recordConfirmedVoucherFile(tx: WorkTx, input: { transportId: string; workItemId: string;
  source: Source; attachmentId: string; pdfSha256: string; snapshotDigest: string; runId: string }) {
  const review = await selectedVoucherReview(tx, input, false);
  const file = review?.files.find((candidate) => candidate.attachmentId === input.attachmentId);
  if (!file || file.handled) return;
  const [current] = await tx.select({ id: attachment.id, messageId: attachment.messageId, filename: attachment.filename,
    mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline,
    sha256: attachment.sha256, s3Key: attachment.s3Key }).from(attachment)
    .where(and(eq(attachment.id, input.attachmentId), eq(attachment.messageId, input.source.messageId))).limit(1);
  if (!current || (current.sha256 && current.sha256 !== input.pdfSha256)) return;
  if (!await matchesFilingSnapshot(tx, input, current)) return;
  await tx.insert(workEvent).values({ workItemId: input.workItemId, actorKind: 'system', type: 'request.handled',
    value: { key: file.key, handled: true, attachmentId: input.attachmentId, sourceHash: input.source.sourceHash,
      runId: input.runId } });
}

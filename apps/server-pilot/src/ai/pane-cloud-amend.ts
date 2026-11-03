import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { attachment, mailThread, message } from '../db/schema/mail.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { CENTURION_HMS_READ_TARGET, type HmsReadTarget } from '../hms/hms-read-target.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { assertNoOpenWrite, formDigest, HmsApprovalError, hmsStateDigest, hmsWriteStateOf, retainedPricesForApproval } from './hms-approval.js';
import { cloudAmendPreservedSchema } from './cloud-amend-price-projection.js';
import { projectCloudStayFind, runCloudStayFind, type HmsCloudFindResult } from './hms-cloud-saved-stay-find.js';
import { assertNoCreateDispatchFence, CreateFenceError } from './pane-create-dispatch-fence.js';
import { labtestAmendWorkerEnabled } from './pane-cloud-amend-readiness.js';
import { createSourceSnapshotDigest } from './pane-create-source-snapshot.js';
import { classifyAmendPayment } from './pane-stay-lookup.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const cloudAmendSelectionSchema = z.object({
  threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
// The extraction is server-owned. The client selects a message, not a version.
export const cloudAmendSourceSchema = cloudAmendSelectionSchema.extend({ extractionId: z.string().uuid() }).strict();
const cursor = z.number().int().nonnegative().safe();
export const cloudAmendSourceBindingSchema = z.object({ selected: cloudAmendSourceSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), revision: cursor, revisionHead: cursor, revisionSeq: cursor,
}).strict().refine((binding) => binding.revision <= binding.revisionHead);
export const cloudAmendChangesSchema = z.object({
  arrival: day.optional(), departure: day.optional(), adults: z.number().int().min(1).max(16).optional(),
  children: z.number().int().min(0).max(9).optional(), childAges: z.array(z.number().int().min(0).max(17)).max(9).optional(),
  ratePlan: z.string().regex(/^[A-Z0-9]{1,12}$/), retainRates: z.enum(['yes', 'no']),
}).strict().refine((fields) => (fields.children === undefined) === (fields.childAges === undefined))
  .refine((fields) => fields.children === undefined || fields.children === fields.childAges?.length);
export const bindCloudAmendInput = z.object({
  workItemId: z.string().uuid(), source: cloudAmendSelectionSchema, confirmation: z.string().regex(/^\d{6,}-\d+$/),
  arrival: day, changes: cloudAmendChangesSchema,
}).strict();
export type CloudAmendChanges = z.infer<typeof cloudAmendChangesSchema>;
export type CloudAmendSource = z.infer<typeof cloudAmendSourceSchema>;

type Item = Pick<typeof workItem.$inferSelect, 'id' | 'transportId' | 'threadId' | 'sourceMessageId' | 'extractionId' | 'status' | 'kind' | 'state'>;
type Thread = Pick<typeof mailThread.$inferSelect, 'id' | 'transportId' | 'historyOnly' | 'trashedAt'>;
type Mail = Pick<typeof message.$inferSelect, 'id' | 'transportId' | 'threadId' | 'direction' | 'historyOnly' | 'sourceProvenance' | 'subject' | 'textBody' | 'htmlBody'>;
type Extraction = Pick<typeof mailExtraction.$inferSelect, 'id' | 'messageId' | 'kind' | 'status'>;

/** The selected message, stored work item and extraction must all still name the same input. */
export function selectedAmendSourceMatches(input: CloudAmendSource, item: Item | undefined, mail: Mail | undefined,
  extraction: Extraction | undefined, transportId: string, thread: Thread | undefined): boolean {
  return Boolean(item && thread && mail && extraction && thread.transportId === transportId &&
    thread.id === input.threadId && !thread.historyOnly && thread.trashedAt === null &&
    item.transportId === transportId && item.kind === 'amendment' &&
    !['done', 'dismissed'].includes(item.status) && item.threadId === input.threadId &&
    item.sourceMessageId === input.messageId && item.extractionId === input.extractionId &&
    mail.transportId === transportId && mail.threadId === input.threadId && mail.id === input.messageId &&
    mail.direction === 'inbound' && !mail.historyOnly && mail.sourceProvenance?.attention == null &&
    extraction.id === input.extractionId && extraction.messageId === input.messageId &&
    extraction.status === 'succeeded' && extraction.kind === 'amendment' && staffQuoteSourceHash(mail) === input.sourceHash);
}

const MAX_SOURCE_ATTACHMENTS = 512;
type SourceRows = {
  item: typeof workItem.$inferSelect | undefined;
  thread: Thread | undefined;
  mail: typeof message.$inferSelect | undefined;
  extraction: typeof mailExtraction.$inferSelect | undefined;
  attachments: Array<typeof attachment.$inferSelect>;
};
export type CloudAmendSourceBinding = z.infer<typeof cloudAmendSourceBindingSchema>;

/** Bind the material source and the item's edit cursor, not just the extraction ID. */
export function cloudAmendSourceBinding(rows: SourceRows, selected: CloudAmendSource, transportId: string): CloudAmendSourceBinding | null {
  if (!selectedAmendSourceMatches(selected, rows.item, rows.mail, rows.extraction, transportId, rows.thread) ||
      !rows.item || !rows.mail || !rows.extraction || rows.attachments.length > MAX_SOURCE_ATTACHMENTS) return null;
  try {
    const digest = createSourceSnapshotDigest({ source: rows.mail, extraction: rows.extraction,
      attachments: rows.attachments, historicalCorrections: [] });
    return { selected, digest, revision: rows.item.revision, revisionHead: rows.item.revisionHead,
      revisionSeq: rows.item.revisionSeq };
  } catch { return null; }
}

const sameBinding = (left: CloudAmendSourceBinding | null, right: CloudAmendSourceBinding) => Boolean(left &&
  left.digest === right.digest && left.revision === right.revision && left.revisionHead === right.revisionHead &&
  left.revisionSeq === right.revisionSeq);

/** Stable server-owned HMS facts; observedAt and browser session ids must not alter the approval digest. */
export function cloudAmendPreimage(found: HmsCloudFindResult) {
  const native = found.nativePreimage, stay = found.stay;
  if (found.outcome !== 'found' || found.arrivalMismatch || !native || !stay ||
      native.propertyCode !== 'HRCEN' || native.firstName !== 'Proof' || native.lastName !== 'Labtest' ||
      native.status !== 'Reserved' || native.arrival < '2027-01-01' || classifyAmendPayment(stay) !== 'unpaid') return null;
  return { native, stay, financial: found.financialObservations ?? null, reservation: found.reservationObservations ?? null };
}
export type CloudAmendPreimage = NonNullable<ReturnType<typeof cloudAmendPreimage>>;

type NativeAmendScope = Pick<CloudAmendPreimage['native'],
  'arrival' | 'departure' | 'ratePlan' | 'adults' | 'children' | 'childAges'>;

/** First supervised Labtest slice; unsupported edits fail closed. */
export function cloudAmendFirstPilotScopeSupported(current: NativeAmendScope, fields: CloudAmendChanges): boolean {
  const arrival = day.safeParse(current.arrival), departure = day.safeParse(current.departure);
  const targetArrival = day.safeParse(fields.arrival ?? current.arrival), targetDeparture = day.safeParse(fields.departure ?? current.departure);
  if (!arrival.success || !departure.success || !targetArrival.success || !targetDeparture.success ||
      current.arrival < '2027-01-01' || targetArrival.data < '2027-01-01' ||
      Date.parse(`${current.departure}T00:00:00Z`) - Date.parse(`${current.arrival}T00:00:00Z`) !== 86_400_000 ||
      Date.parse(`${targetDeparture.data}T00:00:00Z`) - Date.parse(`${targetArrival.data}T00:00:00Z`) !== 86_400_000 ||
      Object.keys(fields).some((key) => !['arrival', 'departure', 'adults', 'ratePlan', 'retainRates'].includes(key)) ||
      fields.ratePlan !== current.ratePlan || fields.retainRates !== 'yes') return false;
  return targetArrival.data !== current.arrival || targetDeparture.data !== current.departure ||
    (fields.adults !== undefined && fields.adults !== current.adults);
}

async function readSource(db: DB, workItemId: string, transportId: string, selected: CloudAmendSource) {
  const [item] = await db.select().from(workItem)
    .where(and(eq(workItem.id, workItemId), eq(workItem.transportId, transportId))).limit(1);
  const [thread] = await db.select({ id: mailThread.id, transportId: mailThread.transportId,
    historyOnly: mailThread.historyOnly, trashedAt: mailThread.trashedAt }).from(mailThread)
    .where(and(eq(mailThread.id, selected.threadId), eq(mailThread.transportId, transportId))).limit(1);
  const [mail] = await db.select().from(message)
    .where(and(eq(message.id, selected.messageId), eq(message.transportId, transportId))).limit(1);
  const [extraction] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, selected.extractionId)).limit(1);
  const attachments = await db.select().from(attachment).where(eq(attachment.messageId, selected.messageId))
    .orderBy(attachment.id).limit(MAX_SOURCE_ATTACHMENTS + 1);
  return { item, thread, mail, extraction, attachments };
}

type WorkTx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Lock the selected source and edit cursor while the caller records the dispatch intent.
 * The caller also validates the consumed grant, active actor, lease and target hold.
 * Lock order follows canonical ingest: mailbox, thread, message, extraction, item.
 */
export async function lockCloudAmendSource(tx: WorkTx, input: {
  workItemId: string; transportId: string; binding: CloudAmendSourceBinding;
}): Promise<typeof workItem.$inferSelect | null> {
  const selected = input.binding.selected;
  await lockCanonicalMailbox(tx as unknown as DB, input.transportId);
  const [thread] = await tx.select({ id: mailThread.id, transportId: mailThread.transportId,
    historyOnly: mailThread.historyOnly, trashedAt: mailThread.trashedAt }).from(mailThread)
    .where(and(eq(mailThread.id, selected.threadId), eq(mailThread.transportId, input.transportId)))
    .limit(1).for('share');
  if (!thread || thread.historyOnly || thread.trashedAt !== null) return null;
  const [mail] = await tx.select().from(message)
    .where(and(eq(message.id, selected.messageId), eq(message.transportId, input.transportId)))
    .limit(1).for('no key update');
  const [extraction] = await tx.select().from(mailExtraction)
    .where(eq(mailExtraction.id, selected.extractionId)).limit(1).for('no key update');
  const attachments = await tx.select().from(attachment).where(eq(attachment.messageId, selected.messageId))
    .orderBy(attachment.id).limit(MAX_SOURCE_ATTACHMENTS + 1).for('update');
  const [item] = await tx.select().from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1).for('no key update');
  const current = cloudAmendSourceBinding({ item, thread, mail, extraction, attachments }, selected, input.transportId);
  return item && sameBinding(current, input.binding) ? item : null;
}

/** A dispatch must use the binding in the form that staff actually approved. */
export async function lockBoundCloudAmendSource(tx: WorkTx, input: {
  workItemId: string; transportId: string; binding: CloudAmendSourceBinding;
}): Promise<typeof workItem.$inferSelect | null> {
  const item = await lockCloudAmendSource(tx, input);
  const stored = item?.state.cloudAmend;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
      !Object.hasOwn(stored, 'binding') ||
      hmsStateDigest((stored as { binding: unknown }).binding) !== hmsStateDigest(input.binding)) return null;
  return item;
}

/** Read the approval card only while its exact selected message still owns the bound form. */
export async function cloudAmendWriteState(input: {
  db?: DB; workItemId: string; transportId: string; source: z.infer<typeof cloudAmendSelectionSchema>;
}) {
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    if (!await lockSelectedBoundCloudAmend(tx, input)) return null;
    return hmsWriteStateOf({ db: tx as unknown as DB, transportId: input.transportId, workItemId: input.workItemId });
  });
}

export function sameSelection(left: z.infer<typeof cloudAmendSelectionSchema>, right: z.infer<typeof cloudAmendSelectionSchema>): boolean {
  return left.threadId === right.threadId && left.messageId === right.messageId && left.sourceHash === right.sourceHash;
}

/** Lock before the item so review/approval cannot race a selected-source change. */
export async function lockSelectedBoundCloudAmend(tx: WorkTx, input: {
  workItemId: string; transportId: string; source: z.infer<typeof cloudAmendSelectionSchema>;
}): Promise<typeof workItem.$inferSelect | null> {
  const [candidate] = await tx.select({ state: workItem.state }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  const stored = candidate?.state.cloudAmend;
  const binding = cloudAmendSourceBindingSchema.safeParse(
    stored && typeof stored === 'object' && !Array.isArray(stored) && 'binding' in stored ? stored.binding : null);
  const selection = cloudAmendSelectionSchema.safeParse(input.source);
  if (!binding.success || !selection.success || !sameSelection(binding.data.selected, selection.data)) return null;
  return lockBoundCloudAmendSource(tx, { workItemId: input.workItemId, transportId: input.transportId, binding: binding.data });
}

/** Prepare only. This stores no grant and dispatches no HMS mutation. */
export async function bindCloudAmendForm(input: z.infer<typeof bindCloudAmendInput> & { db?: DB; transportId: string }) {
  const { db: supplied, transportId, ...request } = input;
  const parsed = bindCloudAmendInput.safeParse(request);
  if (!parsed.success) return { status: 'refused' as const, reason: 'form_invalid' };
  if (!labtestAmendWorkerEnabled()) {
    return { status: 'refused' as const, reason: 'amend_save_unavailable' };
  }
  const db = supplied ?? getDb();
  const data = parsed.data;
  const [selectedItem] = await db.select({ extractionId: workItem.extractionId }).from(workItem)
    .where(and(eq(workItem.id, data.workItemId), eq(workItem.transportId, transportId))).limit(1);
  if (!selectedItem?.extractionId) return { status: 'refused' as const, reason: 'source_mail_changed' };
  const selected = { ...data.source, extractionId: selectedItem.extractionId };
  const sourceRows = await readSource(db, data.workItemId, transportId, selected);
  const binding = cloudAmendSourceBinding(sourceRows, selected, transportId);
  if (!binding) {
    return { status: 'refused' as const, reason: 'source_mail_changed' };
  }
  const target = paneStayHmsTargetForTransport(transportId);
  const exactTarget = ['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const;
  if (!target.ok || exactTarget.some((key) => target.target[key] !== CENTURION_HMS_READ_TARGET[key])) {
    return { status: 'refused' as const, reason: 'refused_unknown_transport' };
  }
  const readAt = new Date();
  const stayRequest = { confirmation: data.confirmation, arrival: data.arrival };
  const raw = await runCloudStayFind({ request: stayRequest, target: target.target, signal: AbortSignal.timeout(5 * 60_000) });
  const preimage = cloudAmendPreimage(projectCloudStayFind(stayRequest, raw));
  if (!preimage || preimage.native.confirmation !== data.confirmation || preimage.native.arrival !== data.arrival) {
    return { status: 'refused' as const, reason: 'hms_preimage_unverified' };
  }
  if (!cloudAmendFirstPilotScopeSupported(preimage.native, data.changes)) {
    return { status: 'refused' as const, reason: 'amendment_unsupported' };
  }
  // The readable projection is not enough for a full native Save. Bind a second, clean
  // Record View's complete model before showing the human approval; never persist it.
  const nativeUrl = new URL('../../tooling/hms-cloud/pane-amend-session.mjs', import.meta.url);
  const nativeModule = await import(nativeUrl.href) as { prepareCloudPaneAmend(input: {
    target: HmsReadTarget; selected: CloudAmendPreimage['native']; confirmation: string; arrival: string;
    changes: CloudAmendChanges; signal: AbortSignal;
  }): Promise<{ outcome: string; nativeDigest?: string; approvedPrices?: unknown; preserved?: unknown }>;
    oneNightRetainPricesMatchObservations(prices: unknown, financial: unknown): boolean };
  const native = await nativeModule.prepareCloudPaneAmend({ target: target.target, selected: preimage.native,
    confirmation: data.confirmation, arrival: data.arrival, changes: data.changes, signal: AbortSignal.timeout(5 * 60_000) });
  if (native.outcome !== 'prepared' || !native.nativeDigest || !/^[a-f0-9]{64}$/.test(native.nativeDigest)) {
    return { status: 'refused' as const, reason: 'hms_preimage_unverified' };
  }
  // The first write path is narrowly limited to one night, unchanged rate and
  // explicit retain=yes. Both fresh HMS readers must agree before staff see Go.
  const preserved = cloudAmendPreservedSchema.safeParse(native.preserved);
  if (!preserved.success || !retainedPricesForApproval(native.approvedPrices) ||
      !nativeModule.oneNightRetainPricesMatchObservations(native.approvedPrices, preimage.financial)) {
    return { status: 'refused' as const, reason: 'amendment_unsupported' };
  }
  const nativeDigest = native.nativeDigest;
  const previewDigest = hmsStateDigest({ binding, preimage, changes: data.changes, nativeDigest,
    approvedPrices: native.approvedPrices, preserved: preserved.data });
  return db.transaction(async (tx) => {
    const item = await lockCloudAmendSource(tx, { workItemId: data.workItemId, transportId, binding });
    if (!item) {
      return { status: 'refused' as const, reason: 'source_mail_changed' };
    }
    try {
      await assertNoCreateDispatchFence(tx, { transportId, workItemId: data.workItemId });
      await assertNoOpenWrite(tx as DB, data.workItemId);
    } catch (error) {
      if (error instanceof HmsApprovalError) return { status: 'refused' as const, reason: error.refusal };
      if (error instanceof CreateFenceError && error.reason === 'active') return { status: 'refused' as const, reason: 'write_in_flight' };
      throw error;
    }
    const state: Record<string, unknown> = { ...item.state };
    for (const key of ['action', 'confirmation', 'arrival', 'lastName', 'attachmentId', 'documentName', 'pdfSha256',
      'sourceMessageId', 'sourceSnapshotDigest', 'reason', 'fields', 'previewDigest', 'cloudAmend', 'hmsSnapshot']) delete state[key];
    Object.assign(state, { action: 'amend', confirmation: data.confirmation, arrival: data.arrival, lastName: 'Labtest',
      fields: data.changes, previewDigest, cloudAmend: { binding, preimage, nativeDigest,
        approvedPrices: native.approvedPrices, preserved: preserved.data },
      hmsSnapshot: { digest: hmsStateDigest(preimage), readAt: readAt.toISOString(), values: {
        fields: { arrival: preimage.native.arrival, departure: preimage.native.departure, adults: preimage.native.adults,
          children: preimage.native.children, childAges: preimage.native.childAges, ratePlan: preimage.native.ratePlan },
      } },
    });
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, data.workItemId));
    return { status: 'bound' as const, previewDigest, formDigest: formDigest(state), readAt: readAt.toISOString() };
  });
}

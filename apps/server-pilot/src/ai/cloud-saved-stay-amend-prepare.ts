import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type DB } from '../db/client.js';
import { mailboxAccess, mailboxTransport, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { formDigest } from './hms-approval.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { cloudSavedStayAmendPayloadSchema } from './cloud-saved-stay-amend.js';

// Neither a property, an HMS preimage nor its reference is accepted from the browser.
export const savedStayAmendSelectionSchema = cloudSavedStayAmendPayloadSchema
  .omit({ preimageRef: true })
  .extend({ workItemId: z.string().uuid() })
  .strict();
export type SavedStayAmendSelection = z.infer<typeof savedStayAmendSelectionSchema>;

/** These two values must come from the authenticated session, not request JSON. */
export type SavedStayAmendActor = { actorUserId: string; transportId: string };

type Refused = { status: 'refused'; reason: string };
export type LockedSavedStayAmendSource = {
  status: 'source_locked';
  actor: SavedStayAmendActor;
  selection: SavedStayAmendSelection;
  propertyCode: string;
  /** Current work-item state before binding. Never an approval of the proposed form. */
  priorFormDigest: string;
  revisionSeq: number;
  kind: string;
  itemStatus: string;
  itemUpdatedAt: string;
};

/**
 * Internal primitive for a future Cloud binder. Call only inside a DB transaction;
 * its locks stop protecting the result as soon as that transaction ends. Repeat it
 * after the HMS read, compare priorFormDigest and revisionSeq, and perform the
 * writer's no-open-write check and form mutation under the same work-item lock.
 * This verifies mail ownership and selection, NOT the stay or any HMS preimage.
 */
export async function lockSavedStayAmendSource(
  tx: DB,
  actor: SavedStayAmendActor,
  input: unknown,
): Promise<LockedSavedStayAmendSource | Refused> {
  const parsed = savedStayAmendSelectionSchema.safeParse(input);
  if (!parsed.success || !actor.actorUserId || !actor.transportId) {
    return { status: 'refused', reason: 'input_invalid' };
  }
  const selection = parsed.data;
  const [item] = await tx.select().from(workItem).where(and(
    eq(workItem.id, selection.workItemId), eq(workItem.transportId, actor.transportId),
  )).limit(1).for('update');
  if (!item) return { status: 'refused', reason: 'not_found' };

  // Lock both records, so access removal or mailbox deactivation cannot race this transaction.
  const [access] = await tx.select({ id: mailboxAccess.id }).from(mailboxAccess).where(and(
    eq(mailboxAccess.userId, actor.actorUserId), eq(mailboxAccess.transportId, actor.transportId),
  )).limit(1).for('update');
  if (!access) return { status: 'refused', reason: 'mailbox_forbidden' };
  const [mailbox] = await tx.select({ email: mailboxTransport.email, active: mailboxTransport.isActive })
    .from(mailboxTransport).where(eq(mailboxTransport.id, actor.transportId)).limit(1).for('update');
  if (!mailbox?.active) return { status: 'refused', reason: 'mailbox_forbidden' };
  if (mailbox.email.trim().toLowerCase() !== selection.source.mailboxEmail.trim().toLowerCase()) {
    return { status: 'refused', reason: 'source_changed' };
  }
  if (item.status === 'done' || item.status === 'dismissed') return { status: 'refused', reason: 'not_open' };
  if (item.threadId !== selection.source.threadId || item.sourceMessageId !== selection.source.messageId) {
    return { status: 'refused', reason: 'source_changed' };
  }
  const [mail] = await tx.select({ id: message.id, transportId: message.transportId, threadId: message.threadId,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody })
    .from(message).where(and(eq(message.id, selection.source.messageId),
      eq(message.transportId, actor.transportId), eq(message.threadId, selection.source.threadId)))
    .limit(1).for('update');
  if (!mail || staffQuoteSourceHash(mail) !== selection.source.sourceHash) {
    return { status: 'refused', reason: 'source_changed' };
  }
  const target = paneStayHmsTargetForTransport(actor.transportId);
  if (!target.ok) return { status: 'refused', reason: 'property_unavailable' };
  // Canonicalize mailbox identity from the database rather than retaining the browser's spelling.
  return { status: 'source_locked', actor, selection: { ...selection,
    source: { ...selection.source, mailboxEmail: mailbox.email } }, propertyCode: target.target.propertyCode,
    priorFormDigest: formDigest(item.state), revisionSeq: item.revisionSeq,
    kind: item.kind, itemStatus: item.status, itemUpdatedAt: item.updatedAt.toISOString() };
}

/** Compare two independently locked reads, including proposal and mailbox, before committing a future form. */
export function sameSavedStayAmendSource(
  first: LockedSavedStayAmendSource,
  current: LockedSavedStayAmendSource,
): boolean {
  return first.actor.actorUserId === current.actor.actorUserId && first.actor.transportId === current.actor.transportId &&
    first.propertyCode === current.propertyCode && first.priorFormDigest === current.priorFormDigest &&
    first.revisionSeq === current.revisionSeq && first.kind === current.kind &&
    first.itemStatus === current.itemStatus && first.itemUpdatedAt === current.itemUpdatedAt &&
    formDigest({ selection: first.selection }) === formDigest({ selection: current.selection });
}

/**
 * Only the mail-side preflight exists today. PaneStayFields lacks the complete
 * native saved-record identity, full form/model and child-age preimage required
 * by the Cloud adapter. No client-supplied ref, staged editor or generic lookup
 * can satisfy that requirement. Therefore do not store a Cloud form or snapshot,
 * issue a grant, enqueue work, or present this result as a prepared HMS write.
 */
export async function prepareSavedStayAmendment(input: {
  db?: DB;
  actor: SavedStayAmendActor;
  selection: unknown;
}): Promise<Refused> {
  const db = input.db ?? getDb();
  return db.transaction(async (tx) => {
    const source = await lockSavedStayAmendSource(tx as DB, input.actor, input.selection);
    if (source.status === 'refused') return source;
    return { status: 'refused' as const, reason: 'saved_preimage_unavailable' };
  });
}

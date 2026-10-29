import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { attachment, mailboxTransport, message } from '../../db/schema/mail.js';
import { guardCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { quoteDigest } from '../../quote-proposal/quote-revision.js';
import { loadSyncedQuoteSelectionFromMailbox, type SyncedQuoteSelection } from '../quote-workflow-synced-selection.js';
import { centurionSourceFence } from '../work-item-source-lock.js';
import { extractionPromptMaxChars, extractionReasoningEffort, extractionVisionEnabled } from './config.js';
import { EXTRACTION_MODEL_ID } from './extract.js';

export const CENTURION_SOURCE_WITNESS_VERSION = 1 as const;

type WitnessScope = { transportId: string; threadId: string; messageId: string };
type Source = {
  status: 'captured';
  digest: string;
  selection: SyncedQuoteSelection;
  from: string;
  mailbox: string;
  propertyCode: 'HRCEN';
};
type Unproven = { status: 'unproven'; reason: 'origin' | 'source_unavailable' | 'attachments' };

/**
 * Call only inside a short transaction. No model or artifact work runs under these locks.
 * The exact returned selection is the one to pass to extraction, and is re-read before commit.
 */
export async function captureCenturionExtractionSource(
  db: DB, scope: WitnessScope, promptVersion: string, env: NodeJS.ProcessEnv,
): Promise<Source | Unproven> {
  if (!centurionSourceFence(scope.transportId)) return { status: 'unproven', reason: 'origin' };
  // The origin binder locks the thread then every message (NOWAIT), excluding message inserts via FK.
  const origin = await guardCenturionHmsMailboxOrigin({ ...scope, db, lock: true });
  if (!origin.ok) return { status: 'unproven', reason: 'origin' };
  const [selected] = await db.select({ id: message.id, from: message.fromAddress, direction: message.direction })
    .from(message).where(and(eq(message.id, scope.messageId), eq(message.threadId, scope.threadId),
      eq(message.transportId, scope.transportId))).limit(1);
  if (!selected || selected.direction !== 'inbound') return { status: 'unproven', reason: 'source_unavailable' };
  const messages = await db.select({ id: message.id }).from(message)
    .where(and(eq(message.threadId, scope.threadId), eq(message.transportId, scope.transportId)));
  const parts = messages.length ? await db.select({ id: attachment.id, isInline: attachment.isInline })
    .from(attachment).where(inArray(attachment.messageId, messages.map((row) => row.id)))
    .orderBy(asc(attachment.id)).for('share', { noWait: true }) : [];
  // This first slice witnesses only inputs the existing reader drops without touching object storage.
  if (parts.some((part) => !part.isInline)) return { status: 'unproven', reason: 'attachments' };
  const [mailbox] = await db.select({ email: mailboxTransport.email }).from(mailboxTransport)
    .where(eq(mailboxTransport.id, scope.transportId)).limit(1).for('share', { noWait: true });
  if (!mailbox) return { status: 'unproven', reason: 'source_unavailable' };
  const selection = await loadSyncedQuoteSelectionFromMailbox({
    transportId: scope.transportId, messageId: scope.messageId, db, includeThreadState: true,
    includeVisionImages: extractionVisionEnabled(env), trackVisionImages: true, inlineAttachmentsOnly: true,
  });
  if (!selection || selection.threadId !== scope.threadId || selection.messageId !== scope.messageId) {
    return { status: 'unproven', reason: 'source_unavailable' };
  }
  const propertyCode = 'HRCEN' as const;
  // Only the digest is persisted; email, names and selection text remain in memory.
  const digest = quoteDigest({
    domain: 'centurion-inbound-extraction-source', version: CENTURION_SOURCE_WITNESS_VERSION,
    transportId: scope.transportId, threadId: scope.threadId, messageId: scope.messageId,
    promptVersion, model: EXTRACTION_MODEL_ID, propertyCode,
    from: selected.from, mailbox: mailbox.email, selection,
    promptMaxChars: extractionPromptMaxChars(env), reasoningEffort: extractionReasoningEffort(env),
    vision: extractionVisionEnabled(env),
  });
  return { status: 'captured', digest, selection, from: selected.from, mailbox: mailbox.email, propertyCode };
}

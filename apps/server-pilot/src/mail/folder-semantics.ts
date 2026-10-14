import { and, eq, exists, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailThread, message } from '../db/schema/mail.js';

export const MAIL_FOLDER_VALUES = [
  'inbox',
  'sent',
  'drafts',
  'draft',
  'archived',
  'archive',
  'bin',
  'spam',
  'starred',
  'snoozed',
  'all',
] as const;

export type MailFolderValue = (typeof MAIL_FOLDER_VALUES)[number];

/** Lazy-clear expired snoozes so they reappear in inbox without a cron. */
export async function clearExpiredSnoozes(db: DB, transportId: string): Promise<void> {
  await db
    .update(mailThread)
    .set({ snoozedUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailThread.transportId, transportId),
        isNotNull(mailThread.snoozedUntil),
        lte(mailThread.snoozedUntil, sql`now()`),
      ),
    );
}

/** Shared base and folder conditions used by listThreads and loaders. */
export function buildMailFolderConditions(
  db: DB,
  transportId: string,
  folder: MailFolderValue,
): SQL[] {
  const conditions: SQL[] = [eq(mailThread.transportId, transportId)];

  if (folder === 'bin') {
    conditions.push(isNotNull(mailThread.trashedAt));
  } else {
    conditions.push(isNull(mailThread.trashedAt));
  }

  if (folder === 'spam') {
    conditions.push(isNotNull(mailThread.spamAt));
  } else {
    conditions.push(isNull(mailThread.spamAt));
  }

  if (folder !== 'all' && folder !== 'archive' && folder !== 'archived') {
    conditions.push(eq(mailThread.historyOnly, false));
  }

  if (folder === 'inbox') {
    conditions.push(eq(mailThread.isArchived, false));
    const snoozedCond = or(isNull(mailThread.snoozedUntil), lte(mailThread.snoozedUntil, sql`now()`));
    if (snoozedCond) conditions.push(snoozedCond);
    // Folder membership requires operational mail; historical context cannot activate a folder.
    // Outbound-only compose threads live in sent.
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(message)
          .where(
            and(
              eq(message.threadId, mailThread.id),
              eq(message.transportId, transportId),
              eq(message.direction, 'inbound'),
              eq(message.historyOnly, false),
            ),
          ),
      ),
    );
  } else if (folder === 'archived' || folder === 'archive') {
    conditions.push(eq(mailThread.isArchived, true));
  } else if (folder === 'starred') {
    conditions.push(eq(mailThread.isStarred, true));
  } else if (folder === 'snoozed') {
    conditions.push(isNotNull(mailThread.snoozedUntil));
  }

  if (folder === 'sent') {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(message)
          .where(
            and(
              eq(message.threadId, mailThread.id),
              eq(message.transportId, transportId),
              eq(message.direction, 'outbound'),
              eq(message.historyOnly, false),
            ),
          ),
      ),
    );
  }

  return conditions;
}

/** Workflow lists get membership from latestWorkflowThreads, not inbox/archive/spam state. */
export function buildMailListConditions(
  db: DB,
  transportId: string,
  folder: MailFolderValue,
  workflowFolder?: string,
): SQL[] {
  return workflowFolder
    ? [eq(mailThread.transportId, transportId)]
    : buildMailFolderConditions(db, transportId, folder);
}

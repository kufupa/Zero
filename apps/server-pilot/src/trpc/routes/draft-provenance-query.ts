import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { mailDraft, mailDraftRevision } from '../../db/schema/mail.js';

/** Fetch each draft's edited revisions without losing the correlated draft identity. */
export function draftWithEditedRevisionsQuery(db: DB, id: string, transportId: string) {
  // A separately built subquery keeps both table names when Drizzle builds the outer select.
  const editedRevisions = db.select({ id: mailDraftRevision.id }).from(mailDraftRevision)
    .where(and(eq(mailDraftRevision.draftId, mailDraft.id), eq(mailDraftRevision.kind, 'edited')));
  return db.select({
    draft: mailDraft,
    editedRevisionIds: sql<string[]>`ARRAY${editedRevisions}`,
  }).from(mailDraft)
    .where(and(eq(mailDraft.id, id), eq(mailDraft.transportId, transportId)))
    .limit(1);
}

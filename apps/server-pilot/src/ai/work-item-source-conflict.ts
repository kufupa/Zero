import { and, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { sqlList } from '../db/schema/hitl.js';
import { FOLLOW_UP_DRAFT_FIELD_PATH, TELEMETRY_EVENT_TYPES, workEvent, workItem } from '../db/schema/work.js';

export type StoredSourceConflict = {
  reason: 'workflow_reclassified';
  previousItems: Array<{ workItemId: string; kind: string; status: string }>;
};

/** User decisions count, excluding pane telemetry and plain acceptance of an unedited AI value. */
export function personTouchSql(alias: string): SQL {
  const e = sql.raw(alias);
  return sql`(${e}.actor_kind = 'user' and ${e}.type not in (${sqlList(TELEMETRY_EVENT_TYPES)})
    and (${e}.type <> 'field.accept' or ${e}.field_path = ${FOLLOW_UP_DRAFT_FIELD_PATH}))`;
}

/** Find saved work or decisions on another workflow for exactly this mailbox and source message. */
export async function priorKindConflict(
  db: DB,
  input: { transportId: string; threadId: string; messageId: string; latestKind: string },
): Promise<StoredSourceConflict | undefined> {
  const previousItems = await db
    .select({ workItemId: workItem.id, kind: workItem.kind, status: workItem.status })
    .from(workItem)
    .where(and(
      eq(workItem.transportId, input.transportId),
      eq(workItem.threadId, input.threadId),
      eq(workItem.sourceMessageId, input.messageId),
      ne(workItem.kind, input.latestKind),
      or(
        sql`${workItem.state} <> '{}'::jsonb`,
        inArray(workItem.status, ['done', 'review']),
        sql`exists (select 1 from ${workEvent} as prior_event
          where prior_event.work_item_id = ${workItem.id} and ${personTouchSql('prior_event')})`,
      ),
    ))
    .orderBy(desc(workItem.updatedAt), desc(workItem.id));
  return previousItems.length ? { reason: 'workflow_reclassified', previousItems } : undefined;
}

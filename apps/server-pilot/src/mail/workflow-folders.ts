import { and, asc, desc, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DB } from '../db/client.js';
import {
  aiWorkflowRun,
  mailCategory,
  mailActionLabel,
  mailThread,
  mailThreadCategory,
  message,
} from '../db/schema/mail.js';
import {
  mailExtraction,
  workEvent,
  workItem,
} from '../db/schema/work.js';
import { MAIL_ACTIONS, type MailAction } from './action-labels.js';

export const WORKFLOW_FOLDER_IDS = [
  'quotes',
  'new-bookings',
  'amendments',
  'cancellations',
  'payments',
  'billing',
  'groups-events',
  'other-to-do',
  'not-for-nava',
] as const;

export type WorkflowFolderId = (typeof WORKFLOW_FOLDER_IDS)[number];
export type AdminReviewDecision = 'right' | 'edited' | 'wrong';

export type WorkflowFolderReview = {
  decision: AdminReviewDecision;
  note: string | null;
  at: string;
};

export type WorkflowFolderStats = {
  threads: number;
  /** Latest inbound message has a succeeded extraction, i.e. Nava read it; independent of mailbox isRead. */
  read: number;
  prefilled: number;
  reviewedRight: number;
  reviewedEdited: number;
  reviewedWrong: number;
};

export type WorkflowFolderSummary = Record<WorkflowFolderId, WorkflowFolderStats>;
export type WorkflowFolderEvalSummary = Record<WorkflowFolderId, { total: number; marked: number }>;

type WorkflowMappingInput = {
  /** Optional database column; deployments without it get null from to_jsonb(mail_extraction). */
  action?: unknown;
  payload?: unknown;
  kind?: string | null;
  origin?: unknown;
  automatedChannel?: boolean;
  ownerAction?: unknown;
};

type WorkflowSourceRow = {
  threadId: string;
  folder?: WorkflowFolderId;
  sourceMessageId: string;
  sender: string;
  subject: string | null;
  receivedAt: Date | null;
  messageCreatedAt: Date;
  isMessageRead: boolean;
  isThreadRead: boolean;
  extractionId: string;
  kind: string | null;
  action: string | null;
  ownerAction?: string | null;
  payload: Record<string, unknown> | null;
  extractorVersion: string;
  extractionCreatedAt: Date;
  origin: string | null;
  automatedChannel: boolean;
};

export type WorkflowFolderRow = {
  threadId: string;
  sourceMessageId: string;
  extractionId: string | null;
  folder: WorkflowFolderId;
  sender: string;
  subject: string;
  receivedAt: string;
  isRead: boolean;
  kind: string | null;
  action: string | null;
  payload: Record<string, unknown> | null;
  extractorVersion: string | null;
  extractionCreatedAt: string | null;
  prefilled: boolean;
  workItemStatus: string | null;
  review: WorkflowFolderReview | null;
  predictedAction?: MailAction;
  ownerAction?: MailAction | null;
  markedAt?: string | null;
};

export type StoredWorkflowRun = {
  id: string;
  triggerMessageId: string;
  kind: string;
  state: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  resultExpiresAt: string | null;
};

export type WorkflowThreadMessage = {
  messageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  isRead: boolean;
  extraction: null | {
    id: string;
    kind: string | null;
    action: string | null;
    folder: WorkflowFolderId;
    payload: Record<string, unknown> | null;
    extractorVersion: string;
    createdAt: string;
  };
  review: WorkflowFolderReview | null;
  workItemStatus: string | null;
  predictedAction?: MailAction;
  ownerAction?: MailAction | null;
  markedAt?: string | null;
};

type WorkItemReviewRow = {
  id: string;
  sourceMessageId: string | null;
  extractionId: string | null;
  status: string;
};

type ReviewEventRow = {
  workItemId: string;
  at: Date;
  value: unknown;
  evidence: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const ACTION_FOLDERS: Record<string, WorkflowFolderId> = {
  quote_availability: 'quotes',
  new_booking: 'new-bookings',
  amend: 'amendments',
  cancel: 'cancellations',
  payment_proof: 'payments',
  billing: 'billing',
  group_event: 'groups-events',
  other_actionable: 'other-to-do',
  no_action: 'not-for-nava',
};

/** Inverse of ACTION_FOLDERS: Done golds unmarked rows as this action. */
export const FOLDER_ACTIONS = {
  quotes: 'quote_availability',
  'new-bookings': 'new_booking',
  amendments: 'amend',
  cancellations: 'cancel',
  payments: 'payment_proof',
  billing: 'billing',
  'groups-events': 'group_event',
  'other-to-do': 'other_actionable',
  'not-for-nava': 'no_action',
} as const satisfies Record<WorkflowFolderId, MailAction>;

function isMailAction(value: unknown): value is MailAction {
  return typeof value === 'string' && (MAIL_ACTIONS as readonly string[]).includes(value);
}

function actionFolderSql(action: SQLWrapper): SQL<WorkflowFolderId> {
  const actionCases = Object.entries(ACTION_FOLDERS).map(
    ([value, folder]) => sql`when ${value} then ${folder}`,
  );
  return sql<WorkflowFolderId>`case ${action}
    ${sql.join(actionCases, sql` `)}
    else 'other-to-do'
  end`;
}

function latestModelActionLabels(db: DB, transportId: string, version?: string) {
  const conditions = [
    eq(mailActionLabel.transportId, transportId),
    eq(mailActionLabel.source, 'model'),
  ];
  // One model version at a time, so the desk shows exactly the set the eval report scores.
  conditions.push(
    version
      ? eq(mailActionLabel.version, version)
      : sql`${mailActionLabel.version} = (
          select newest.version from ${mailActionLabel} newest
          where newest.transport_id = ${transportId} and newest.source = 'model'
          order by newest.created_at desc, newest.id desc
          limit 1
        )`,
  );

  return db.$with('workflow_review_set_labels').as(
    db
      .selectDistinctOn([mailActionLabel.messageId], {
        modelTransportId: sql<string>`${mailActionLabel.transportId}`.as('model_transport_id'),
        modelMessageId: sql<string>`${mailActionLabel.messageId}`.as('model_message_id'),
        predictedAction: sql<MailAction>`${mailActionLabel.action}`.as('predicted_action'),
        // Computed once here: a parameterised CASE repeated in GROUP BY is not the same expression to Postgres.
        predictedFolder: actionFolderSql(sql<MailAction>`${mailActionLabel.action}`).as('predicted_folder'),
        modelVersion: sql<string>`${mailActionLabel.version}`.as('model_version'),
        modelCreatedAt: sql<Date>`${mailActionLabel.createdAt}`
          .mapWith(mailActionLabel.createdAt)
          .as('model_created_at'),
      })
      .from(mailActionLabel)
      .where(and(...conditions))
      .orderBy(
        asc(mailActionLabel.messageId),
        desc(mailActionLabel.createdAt),
        desc(mailActionLabel.id),
      ),
  );
}

function actionFolder(action: MailAction): WorkflowFolderId {
  return ACTION_FOLDERS[action] ?? 'other-to-do';
}

const LEGACY_KIND_FOLDERS: Record<string, WorkflowFolderId> = {
  quote: 'quotes',
  booking: 'new-bookings',
  amendment: 'amendments',
  cancellation: 'cancellations',
  voucher_pop: 'payments',
  other: 'not-for-nava',
  spam: 'not-for-nava',
};

/** The single server-side membership mapping: source exclusion, then action, then legacy kind. */
export function mapWorkflowFolder(input: WorkflowMappingInput): WorkflowFolderId {
  const payload = asRecord(input.payload);
  const origin = cleanString(input.origin) ?? cleanString(payload.origin);
  if (input.automatedChannel || origin === 'system_notice') return 'not-for-nava';

  const action =
    cleanString(input.ownerAction) ?? cleanString(input.action) ?? cleanString(payload.action);
  if (action) return ACTION_FOLDERS[action] ?? 'other-to-do';

  const kind = cleanString(input.kind);
  return (kind && LEGACY_KIND_FOLDERS[kind]) || 'not-for-nava';
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;
}

/** True when the successful read supplied at least one usable value that the panel can show as prefilled. */
export function hasPrefilledData(payloadValue: unknown): boolean {
  const payload = asRecord(payloadValue);
  const contact = asRecord(payload.contact);
  if (
    [contact.name, contact.email, contact.phone, payload.agency, payload.endClient].some(hasValue)
  ) {
    return true;
  }
  if (
    Array.isArray(payload.confirmationNumbers) &&
    payload.confirmationNumbers.some(hasValue)
  ) {
    return true;
  }
  if (!Array.isArray(payload.stays)) return false;
  return payload.stays.some((value) => {
    const stay = asRecord(value);
    const requested = asRecord(stay.requested);
    const booked = asRecord(stay.booked);
    if (
      [
        stay.hotel,
        stay.totalRooms,
        requested.arrival,
        requested.departure,
        booked.arrival,
        booked.departure,
      ].some(hasValue)
    ) {
      return true;
    }
    return Array.isArray(stay.rows) && stay.rows.some((row) => {
      const fields = asRecord(row);
      return [fields.roomType, fields.rooms, fields.adultsPerRoom, fields.board].some(hasValue) ||
        (Array.isArray(fields.childAges) && fields.childAges.length > 0);
    });
  });
}

function emptyStats(): WorkflowFolderStats {
  return {
    threads: 0,
    read: 0,
    prefilled: 0,
    reviewedRight: 0,
    reviewedEdited: 0,
    reviewedWrong: 0,
  };
}

export function emptyWorkflowFolderSummary(): WorkflowFolderSummary {
  return Object.fromEntries(WORKFLOW_FOLDER_IDS.map((folder) => [folder, emptyStats()])) as
    WorkflowFolderSummary;
}

const actionColumn = sql<string | null>`to_jsonb(${mailExtraction})->>'action'`;
const payloadAction = sql<string | null>`${mailExtraction.payload}->>'action'`;
const effectiveAction = sql<string | null>`coalesce(
  nullif(btrim(${actionColumn}), ''),
  nullif(btrim(${payloadAction}), '')
)`;
const payloadOrigin = sql<string | null>`${mailExtraction.payload}->>'origin'`;

function ownerActionSql(transportId: string): SQL<string | null> {
  return sql<string | null>`(
    select ${mailActionLabel.action}
    from ${mailActionLabel}
    where ${mailActionLabel.messageId} = ${message.id}
      and ${mailActionLabel.transportId} = ${transportId}
      and ${mailActionLabel.source} = 'owner'
      and ${mailActionLabel.version} = 'owner'
    order by ${mailActionLabel.updatedAt} desc, ${mailActionLabel.id} desc
    limit 1
  )`;
}

export function workflowFolderMembershipSql(transportId: string): SQL<WorkflowFolderId> {
  const action = sql<string | null>`coalesce(
    nullif(btrim(${ownerActionSql(transportId)}), ''),
    ${effectiveAction}
  )`;
  return mapWorkflowFolderSql(action);
}

const automatedChannel = sql<boolean>`exists (
  select 1
  from ${mailThreadCategory} mtc
  join ${mailCategory} mc on mc.id = mtc.category_id
  where mtc.thread_id = ${mailThread.id}
    and mtc.transport_id = ${mailThread.transportId}
    and mc.transport_id = ${mailThread.transportId}
    and mc.slug = 'automated-channel'
)`;

/** SQL form used by the paged list/summary queries. It shares the same mapping tables as mapWorkflowFolder. */
function mapWorkflowFolderSql(action: SQL<unknown> = effectiveAction): SQL<WorkflowFolderId> {
  const actionCases = Object.entries(ACTION_FOLDERS).map(
    ([action, folder]) => sql`when ${action} then ${folder}`,
  );
  const kindCases = Object.entries(LEGACY_KIND_FOLDERS).map(
    ([kind, folder]) => sql`when ${kind} then ${folder}`,
  );
  return sql<WorkflowFolderId>`case
    when ${automatedChannel} or ${payloadOrigin} = 'system_notice' then 'not-for-nava'
    when ${action} is not null then case ${action}
      ${sql.join(actionCases, sql` `)}
      else 'other-to-do'
    end
    else case ${mailExtraction.kind}
      ${sql.join(kindCases, sql` `)}
      else 'not-for-nava'
    end
  end`;
}

function jsonHasDisplayableValue(value: SQL<unknown>): SQL<boolean> {
  return sql<boolean>`(
    ${value} is not null
    and ${value} <> 'null'::jsonb
    and (jsonb_typeof(${value}) <> 'string' or btrim(${value} #>> '{}') <> '')
  )`;
}

function jsonArray(value: SQL<unknown>): SQL<unknown> {
  return sql`case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end`;
}

/** SQL equivalent of hasPrefilledData, so counts do not need to load every extraction payload. */
function hasPrefilledDataSql(): SQL<boolean> {
  const payload = mailExtraction.payload;
  const confirmations = sql`${payload}->'confirmationNumbers'`;
  const stays = sql`${payload}->'stays'`;
  const confirmationExists = sql<boolean>`exists (
    select 1
    from jsonb_array_elements(${jsonArray(confirmations)}) as confirmation(value)
    where ${jsonHasDisplayableValue(sql.raw('confirmation.value'))}
  )`;
  const stayRows = sql`case when jsonb_typeof(stay.value->'rows') = 'array'
    then stay.value->'rows' else '[]'::jsonb end`;
  const roomHasChildren = sql<boolean>`case
    when jsonb_typeof(room.value->'childAges') = 'array'
      then jsonb_array_length(room.value->'childAges') > 0
    else false
  end`;
  const roomExists = sql<boolean>`exists (
    select 1
    from jsonb_array_elements(${stayRows}) as room(value)
    where ${jsonHasDisplayableValue(sql.raw("room.value->'roomType'"))}
      or ${jsonHasDisplayableValue(sql.raw("room.value->'rooms'"))}
      or ${jsonHasDisplayableValue(sql.raw("room.value->'adultsPerRoom'"))}
      or ${jsonHasDisplayableValue(sql.raw("room.value->'board'"))}
      or ${roomHasChildren}
  )`;
  const stayExists = sql<boolean>`exists (
    select 1
    from jsonb_array_elements(${jsonArray(stays)}) as stay(value)
    where ${jsonHasDisplayableValue(sql.raw("stay.value->'hotel'"))}
      or ${jsonHasDisplayableValue(sql.raw("stay.value->'totalRooms'"))}
      or ${jsonHasDisplayableValue(sql.raw("stay.value->'requested'->'arrival'"))}
      or ${jsonHasDisplayableValue(sql.raw("stay.value->'requested'->'departure'"))}
      or ${jsonHasDisplayableValue(sql.raw("stay.value->'booked'->'arrival'"))}
      or ${jsonHasDisplayableValue(sql.raw("stay.value->'booked'->'departure'"))}
      or ${roomExists}
  )`;
  return sql<boolean>`(
    ${jsonHasDisplayableValue(sql`${payload}->'contact'->'name'`)}
    or ${jsonHasDisplayableValue(sql`${payload}->'contact'->'email'`)}
    or ${jsonHasDisplayableValue(sql`${payload}->'contact'->'phone'`)}
    or ${jsonHasDisplayableValue(sql`${payload}->'agency'`)}
    or ${jsonHasDisplayableValue(sql`${payload}->'endClient'`)}
    or ${confirmationExists}
    or ${stayExists}
  )`;
}

export function latestWorkflowThreads(db: DB, transportId: string) {
  const ownerAction = ownerActionSql(transportId);
  return db.$with('workflow_latest_threads').as(
    db
      .selectDistinctOn([message.threadId], {
        threadId: message.threadId,
        sourceMessageId: sql<string>`${message.id}`.as('latest_source_message_id'),
        sender: message.fromAddress,
        subject: message.subject,
        receivedAt: message.receivedAt,
        messageCreatedAt: sql<Date>`${message.createdAt}`.mapWith(message.createdAt).as('message_created_at'),
        sortTime: sql<Date>`coalesce(${message.receivedAt}, ${message.createdAt})`.as('sort_time'),
        isMessageRead: sql<boolean>`${message.isRead}`.as('message_is_read'),
        isThreadRead: sql<boolean>`${mailThread.isRead}`.as('thread_is_read'),
        extractionId: sql<string>`${mailExtraction.id}`.as('latest_extraction_id'),
        kind: mailExtraction.kind,
        action: actionColumn.as('action'),
        ownerAction: ownerAction.as('owner_action'),
        payload: mailExtraction.payload,
        extractorVersion: mailExtraction.extractorVersion,
        extractionCreatedAt: sql<Date>`${mailExtraction.createdAt}`.mapWith(mailExtraction.createdAt).as('extraction_created_at'),
        origin: payloadOrigin.as('origin'),
        automatedChannel: automatedChannel.as('automated_channel'),
        folder: workflowFolderMembershipSql(transportId).as('folder'),
        prefilled: hasPrefilledDataSql().as('prefilled'),
      })
      .from(mailExtraction)
      .innerJoin(message, eq(mailExtraction.messageId, message.id))
      .innerJoin(mailThread, eq(message.threadId, mailThread.id))
      .where(
        and(
          eq(message.transportId, transportId),
          eq(message.direction, 'inbound'),
          eq(mailThread.transportId, transportId),
          eq(mailExtraction.status, 'succeeded'),
          isNull(mailThread.trashedAt),
        ),
      )
      .orderBy(
        asc(message.threadId),
        desc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`),
        desc(message.createdAt),
        desc(message.id),
        desc(mailExtraction.createdAt),
        desc(mailExtraction.id),
      ),
  );
}

function latestWorkflowReviews(db: DB, transportId: string) {
  const sourceMessageId = sql<string | null>`${workEvent.evidence}->>'sourceMessageId'`;
  const extractionId = sql<string | null>`${workEvent.evidence}->>'extractionId'`;
  return db.$with('workflow_latest_reviews').as(
    db
      .selectDistinctOn([sourceMessageId, extractionId], {
        sourceMessageId: sourceMessageId.as('source_message_id'),
        extractionId: extractionId.as('extraction_id'),
        decision: sql<string | null>`${workEvent.value}->>'decision'`.as('decision'),
      })
      .from(workEvent)
      .innerJoin(workItem, eq(workEvent.workItemId, workItem.id))
      .where(
        and(
          eq(workItem.transportId, transportId),
          eq(workEvent.type, 'admin_review'),
          sql`${sourceMessageId} is not null`,
          sql`${extractionId} is not null`,
        ),
      )
      .orderBy(asc(sourceMessageId), asc(extractionId), desc(workEvent.at), desc(workEvent.id)),
  );
}

function latestSucceededExtractions(db: DB, transportId: string, threadId?: string) {
  const conditions = [
    eq(message.transportId, transportId),
    eq(message.direction, 'inbound'),
    eq(mailThread.transportId, transportId),
    eq(mailExtraction.status, 'succeeded'),
    isNull(mailThread.trashedAt),
  ];
  if (threadId) conditions.push(eq(message.threadId, threadId));

  return db
    .select({
      threadId: message.threadId,
      sourceMessageId: message.id,
      sender: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      messageCreatedAt: message.createdAt,
      isMessageRead: message.isRead,
      isThreadRead: mailThread.isRead,
      extractionId: mailExtraction.id,
      kind: mailExtraction.kind,
      action: actionColumn,
      ownerAction: ownerActionSql(transportId),
      payload: mailExtraction.payload,
      extractorVersion: mailExtraction.extractorVersion,
      extractionCreatedAt: mailExtraction.createdAt,
      origin: payloadOrigin,
      automatedChannel,
    })
    .from(mailExtraction)
    .innerJoin(message, eq(mailExtraction.messageId, message.id))
    .innerJoin(mailThread, eq(message.threadId, mailThread.id))
    .where(and(...conditions))
    .orderBy(
      asc(message.threadId),
      desc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`),
      desc(message.createdAt),
      desc(message.id),
      desc(mailExtraction.createdAt),
      desc(mailExtraction.id),
    );
}

function newestExtractionPerMessage(rows: readonly WorkflowSourceRow[]): WorkflowSourceRow[] {
  const latest = new Map<string, WorkflowSourceRow>();
  for (const row of rows) {
    if (!latest.has(row.sourceMessageId)) latest.set(row.sourceMessageId, row);
  }
  return [...latest.values()];
}

function reviewFromEvent(row: ReviewEventRow): WorkflowFolderReview | null {
  const value = asRecord(row.value);
  const decision = value.decision;
  if (decision !== 'right' && decision !== 'edited' && decision !== 'wrong') return null;
  return {
    decision,
    note: typeof value.note === 'string' ? value.note : null,
    at: row.at.toISOString(),
  };
}

async function reviewsForSources(
  db: DB,
  transportId: string,
  pairs: readonly { sourceMessageId: string; extractionId: string }[],
): Promise<Map<string, { review: WorkflowFolderReview | null; status: string | null }>> {
  const byPair = new Map<string, { review: WorkflowFolderReview | null; status: string | null }>();
  if (pairs.length === 0) return byPair;
  const sourceIds = [...new Set(pairs.map((pair) => pair.sourceMessageId))];
  const items = (await db
    .select({
      id: workItem.id,
      sourceMessageId: workItem.sourceMessageId,
      extractionId: workItem.extractionId,
      status: workItem.status,
    })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, transportId),
        inArray(workItem.sourceMessageId, sourceIds),
      ),
    )) as WorkItemReviewRow[];
  const itemsBySource = new Map<string, WorkItemReviewRow[]>();
  for (const item of items) {
    if (!item.sourceMessageId) continue;
    const matching = itemsBySource.get(item.sourceMessageId) ?? [];
    matching.push(item);
    itemsBySource.set(item.sourceMessageId, matching);
  }
  for (const pair of pairs) {
    const matchingItems = itemsBySource.get(pair.sourceMessageId) ?? [];
    const currentItem = matchingItems.find((item) => item.extractionId === pair.extractionId);
    byPair.set(`${pair.sourceMessageId}:${pair.extractionId}`, {
      review: null,
      status: currentItem?.status ?? null,
    });
  }
  const itemIds = [...new Set(items.map((item) => item.id))];
  if (itemIds.length === 0) return byPair;
  const events = await db
    .select({
      workItemId: workEvent.workItemId,
      at: workEvent.at,
      value: workEvent.value,
      evidence: workEvent.evidence,
    })
    .from(workEvent)
    .where(and(eq(workEvent.type, 'admin_review'), inArray(workEvent.workItemId, itemIds)))
    .orderBy(desc(workEvent.at), desc(workEvent.id));
  for (const event of events) {
    const evidence = asRecord(event.evidence);
    const sourceMessageId = cleanString(evidence.sourceMessageId);
    const extractionId = cleanString(evidence.extractionId);
    if (!sourceMessageId || !extractionId) continue;
    const entry = byPair.get(`${sourceMessageId}:${extractionId}`);
    if (!entry || entry.review) continue;
    entry.review = reviewFromEvent(event);
  }
  return byPair;
}

function toWorkflowFolderRow(
  row: WorkflowSourceRow,
  review: { review: WorkflowFolderReview | null; status: string | null } | undefined,
): WorkflowFolderRow {
  return {
    threadId: row.threadId,
    sourceMessageId: row.sourceMessageId,
    extractionId: row.extractionId,
    folder: row.folder ?? mapWorkflowFolder({
      action: row.action,
      ownerAction: row.ownerAction,
      payload: row.payload,
      kind: row.kind,
      origin: row.origin,
      automatedChannel: row.automatedChannel,
    }),
    sender: row.sender,
    subject: row.subject?.trim() || '(no subject)',
    receivedAt: (row.receivedAt ?? row.messageCreatedAt).toISOString(),
    isRead: row.isMessageRead || row.isThreadRead,
    kind: row.kind,
    action: cleanString(row.action) ?? cleanString(asRecord(row.payload).action),
    payload: row.payload,
    extractorVersion: row.extractorVersion,
    extractionCreatedAt: row.extractionCreatedAt.toISOString(),
    prefilled: hasPrefilledData(row.payload),
    workItemStatus: review?.status ?? null,
    review: review?.review ?? null,
    ownerAction: isMailAction(row.ownerAction) ? row.ownerAction : null,
  };
}

export async function listWorkflowFolderRows(
  db: DB,
  transportId: string,
  folder: WorkflowFolderId,
  offset: number,
  limit: number,
  options: { set?: 'eval'; version?: string } = {},
): Promise<{ rows: WorkflowFolderRow[]; nextOffset: number | null }> {
  if (options.set === 'eval') {
    return listReviewSetRows(db, transportId, folder, offset, limit, options.version);
  }

  const latest = latestWorkflowThreads(db, transportId);
  const selectedRows = await db
    .with(latest)
    .select()
    .from(latest)
    .where(eq(latest.folder, folder))
    .orderBy(desc(latest.sortTime), desc(latest.threadId))
    .limit(limit + 1)
    .offset(offset);
  const hasNextPage = selectedRows.length > limit;
  const pageRows = selectedRows.slice(0, limit) as WorkflowSourceRow[];
  const reviews = await reviewsForSources(
    db,
    transportId,
    pageRows.map((row) => ({ sourceMessageId: row.sourceMessageId, extractionId: row.extractionId })),
  );
  return {
    rows: pageRows.map((row) =>
      toWorkflowFolderRow(row, reviews.get(`${row.sourceMessageId}:${row.extractionId}`)),
    ),
    nextOffset: hasNextPage ? offset + limit : null,
  };
}

export async function goldRemainingInFolder(
  db: DB,
  input: {
    transportId: string;
    folder: WorkflowFolderId;
    labelledBy: string;
  },
): Promise<{ goldWrote: number }> {
  const action = FOLDER_ACTIONS[input.folder];
  const unmarked: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await listWorkflowFolderRows(db, input.transportId, input.folder, offset, 200);
    for (const row of page.rows) {
      if (!row.ownerAction) unmarked.push(row.sourceMessageId);
    }
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  if (unmarked.length === 0) return { goldWrote: 0 };

  const inserted = await db
    .insert(mailActionLabel)
    .values(
      unmarked.map((messageId) => ({
        transportId: input.transportId,
        messageId,
        source: 'owner' as const,
        version: 'owner',
        action,
        needsAction: action !== 'no_action',
        labelledBy: input.labelledBy,
      })),
    )
    .onConflictDoNothing()
    .returning({ messageId: mailActionLabel.messageId });
  return { goldWrote: inserted.length };
}

async function listReviewSetRows(
  db: DB,
  transportId: string,
  folder: WorkflowFolderId,
  offset: number,
  limit: number,
  version?: string,
): Promise<{ rows: WorkflowFolderRow[]; nextOffset: number | null }> {
  const labels = latestModelActionLabels(db, transportId, version);
  const ownerLabels = alias(mailActionLabel, 'workflow_review_owner_label');
  const predictedFolder = labels.predictedFolder;
  const selectedRows = await db
    .with(labels)
    .select({
      threadId: message.threadId,
      sourceMessageId: message.id,
      folder: predictedFolder,
      sender: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      messageCreatedAt: message.createdAt,
      isMessageRead: message.isRead,
      isThreadRead: mailThread.isRead,
      predictedAction: labels.predictedAction,
      ownerAction: ownerLabels.action,
      markedAt: ownerLabels.updatedAt,
    })
    .from(labels)
    .innerJoin(
      message,
      and(
        eq(message.id, labels.modelMessageId),
        eq(message.transportId, transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    .innerJoin(
      mailThread,
      and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, transportId)),
    )
    .leftJoin(
      ownerLabels,
      and(
        eq(ownerLabels.messageId, labels.modelMessageId),
        eq(ownerLabels.transportId, transportId),
        eq(ownerLabels.source, 'owner'),
        eq(ownerLabels.version, 'owner'),
      ),
    )
    .where(
      and(
        eq(labels.modelTransportId, transportId),
        isNull(mailThread.trashedAt),
        eq(predictedFolder, folder),
      ),
    )
    .orderBy(
      asc(sql<number>`case when ${ownerLabels.id} is null then 0 else 1 end`),
      desc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`),
      desc(message.createdAt),
      desc(message.id),
    )
    .limit(limit + 1)
    .offset(offset);
  const hasNextPage = selectedRows.length > limit;
  const pageRows = selectedRows.slice(0, limit);

  return {
    rows: pageRows.map((row) => ({
      threadId: row.threadId,
      sourceMessageId: row.sourceMessageId,
      extractionId: null,
      folder: row.folder,
      sender: row.sender,
      subject: row.subject?.trim() || '(no subject)',
      receivedAt: (row.receivedAt ?? row.messageCreatedAt).toISOString(),
      isRead: row.isMessageRead || row.isThreadRead,
      kind: null,
      action: null,
      payload: null,
      extractorVersion: null,
      extractionCreatedAt: null,
      prefilled: false,
      workItemStatus: null,
      review: null,
      predictedAction: row.predictedAction,
      ownerAction: row.ownerAction,
      markedAt: row.markedAt?.toISOString() ?? null,
    })),
    nextOffset: hasNextPage ? offset + limit : null,
  };
}

export async function getWorkflowFolderSummary(
  db: DB,
  transportId: string,
): Promise<WorkflowFolderSummary>;
export async function getWorkflowFolderSummary(
  db: DB,
  transportId: string,
  options: { set: 'eval'; version?: string },
): Promise<WorkflowFolderEvalSummary>;
export async function getWorkflowFolderSummary(
  db: DB,
  transportId: string,
  options?: { set?: 'eval'; version?: string },
): Promise<WorkflowFolderSummary | WorkflowFolderEvalSummary> {
  if (options?.set === 'eval') {
    return getReviewSetSummary(db, transportId, options.version);
  }

  const latest = latestWorkflowThreads(db, transportId);
  const reviews = latestWorkflowReviews(db, transportId);
  const rows = await db
    .with(latest, reviews)
    .select({
      folder: latest.folder,
      threads: sql<number>`count(*)::int`.as('threads'),
      // Every row in this CTE is a latest succeeded extraction: this is Nava-read count, not mailbox read state.
      read: sql<number>`count(*)::int`.as('read'),
      prefilled: sql<number>`count(*) filter (where ${latest.prefilled})::int`.as('prefilled'),
      reviewedRight: sql<number>`count(*) filter (where ${reviews.decision} = 'right')::int`.as('reviewed_right'),
      reviewedEdited: sql<number>`count(*) filter (where ${reviews.decision} = 'edited')::int`.as('reviewed_edited'),
      reviewedWrong: sql<number>`count(*) filter (where ${reviews.decision} = 'wrong')::int`.as('reviewed_wrong'),
    })
    .from(latest)
    .leftJoin(
      reviews,
      and(
        eq(reviews.sourceMessageId, latest.sourceMessageId),
        // Review evidence stores the extraction id as JSON text; the extraction id is a uuid.
        sql`${reviews.extractionId} = ${latest.extractionId}::text`,
      ),
    )
    .groupBy(latest.folder);
  const summary = emptyWorkflowFolderSummary();
  for (const row of rows) {
    summary[row.folder] = {
      threads: row.threads,
      read: row.read,
      prefilled: row.prefilled,
      reviewedRight: row.reviewedRight,
      reviewedEdited: row.reviewedEdited,
      reviewedWrong: row.reviewedWrong,
    };
  }
  return summary;
}

async function getReviewSetSummary(
  db: DB,
  transportId: string,
  version?: string,
): Promise<WorkflowFolderEvalSummary> {
  const labels = latestModelActionLabels(db, transportId, version);
  const ownerLabels = alias(mailActionLabel, 'workflow_review_summary_owner_label');
  const predictedFolder = labels.predictedFolder;
  const rows = await db
    .with(labels)
    .select({
      folder: predictedFolder,
      total: sql<number>`count(*)::int`.as('total'),
      marked: sql<number>`count(${ownerLabels.id})::int`.as('marked'),
    })
    .from(labels)
    .innerJoin(
      message,
      and(
        eq(message.id, labels.modelMessageId),
        eq(message.transportId, transportId),
        eq(message.direction, 'inbound'),
      ),
    )
    .innerJoin(
      mailThread,
      and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, transportId)),
    )
    .leftJoin(
      ownerLabels,
      and(
        eq(ownerLabels.messageId, labels.modelMessageId),
        eq(ownerLabels.transportId, transportId),
        eq(ownerLabels.source, 'owner'),
        eq(ownerLabels.version, 'owner'),
      ),
    )
    .where(and(eq(labels.modelTransportId, transportId), isNull(mailThread.trashedAt)))
    .groupBy(predictedFolder);
  const summary = Object.fromEntries(
    WORKFLOW_FOLDER_IDS.map((folder) => [folder, { total: 0, marked: 0 }]),
  ) as WorkflowFolderEvalSummary;
  for (const row of rows) {
    summary[row.folder as WorkflowFolderId] = { total: row.total, marked: row.marked };
  }
  return summary;
}

type SafeJson = string | number | boolean | null | SafeJson[] | { [key: string]: SafeJson };

const STORED_RESULT_OMIT_KEYS = new Set([
  'admission',
  'authorizationid',
  'claimowner',
  'claimtoken',
  'credential',
  'credentials',
  'html',
  'locator',
  'password',
  'pagetext',
  'screenshotdir',
  'session',
  'token',
  'url',
]);

function safeStoredJson(value: unknown, depth = 0): SafeJson | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 1000);
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => safeStoredJson(item, depth + 1) ?? null);
  }
  if (typeof value !== 'object') return undefined;
  const out: Record<string, SafeJson> = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (STORED_RESULT_OMIT_KEYS.has(key.toLowerCase())) continue;
    const safe = safeStoredJson(item, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

function storedWorkflowRun(run: {
  id: string;
  triggerMessageId: string;
  readRequest: Record<string, unknown> | null;
  readResult: Record<string, unknown> | null;
  state: string;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  readResultExpiresAt: Date | null;
}): StoredWorkflowRun {
  const request = safeStoredJson(run.readRequest) ?? {};
  const result = safeStoredJson(run.readResult);
  const requestRecord = asRecord(request);
  const resultRecord = asRecord(result);
  return {
    id: run.id,
    triggerMessageId: run.triggerMessageId,
    kind: cleanString(requestRecord.kind) ?? cleanString(requestRecord.toolId) ?? 'workflow read',
    state: run.state,
    request: requestRecord,
    result: Object.keys(resultRecord).length > 0 ? resultRecord : null,
    lastError: run.lastError,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    resultExpiresAt: run.readResultExpiresAt?.toISOString() ?? null,
  };
}

export async function getWorkflowFolderThread(
  db: DB,
  input: {
    transportId: string;
    folder: WorkflowFolderId;
    threadId: string;
    set?: 'eval';
    version?: string;
    messageId?: string;
  },
): Promise<{
  folder: WorkflowFolderId;
  threadId: string;
  defaultMessageId: string;
  messages: WorkflowThreadMessage[];
  runs: StoredWorkflowRun[];
} | null> {
  let defaultMessageId: string;
  const reviewSetLabels = new Map<
    string,
    { predictedAction: MailAction; ownerAction: MailAction | null; markedAt: Date | null }
  >();
  if (input.set === 'eval') {
    const labels = latestModelActionLabels(db, input.transportId, input.version);
    const ownerLabels = alias(mailActionLabel, 'workflow_thread_owner_label');
    const labelRows = await db
      .with(labels)
      .select({
        messageId: message.id,
        predictedAction: labels.predictedAction,
        ownerAction: ownerLabels.action,
        markedAt: ownerLabels.updatedAt,
      })
      .from(labels)
      .innerJoin(
        message,
        and(
          eq(message.id, labels.modelMessageId),
          eq(message.transportId, input.transportId),
          eq(message.direction, 'inbound'),
        ),
      )
      .innerJoin(
        mailThread,
        and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, input.transportId)),
      )
      .leftJoin(
        ownerLabels,
        and(
          eq(ownerLabels.messageId, labels.modelMessageId),
          eq(ownerLabels.transportId, input.transportId),
          eq(ownerLabels.source, 'owner'),
          eq(ownerLabels.version, 'owner'),
        ),
      )
      .where(
        and(
          eq(labels.modelTransportId, input.transportId),
          eq(message.threadId, input.threadId),
          isNull(mailThread.trashedAt),
        ),
      )
      .orderBy(
        desc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`),
        desc(message.createdAt),
        desc(message.id),
      );
    for (const row of labelRows) {
      reviewSetLabels.set(row.messageId, {
        predictedAction: row.predictedAction,
        ownerAction: row.ownerAction,
        markedAt: row.markedAt,
      });
    }
    const selected = input.messageId
      ? labelRows.find(
          (row) => row.messageId === input.messageId && actionFolder(row.predictedAction) === input.folder,
        )
      : labelRows.find((row) => actionFolder(row.predictedAction) === input.folder);
    if (!selected) return null;
    defaultMessageId = selected.messageId;
  } else {
    const threadRows = (await latestSucceededExtractions(
      db,
      input.transportId,
      input.threadId,
    )) as WorkflowSourceRow[];
    const latestForThread = newestExtractionPerMessage(threadRows)[0];
    if (
      !latestForThread ||
      mapWorkflowFolder({
        action: latestForThread.action,
        ownerAction: latestForThread.ownerAction,
        payload: latestForThread.payload,
        kind: latestForThread.kind,
        origin: latestForThread.origin,
        automatedChannel: latestForThread.automatedChannel,
      }) !== input.folder
    ) {
      return null;
    }
    defaultMessageId = latestForThread.sourceMessageId;
  }

  const rows = await db
    .select({
      threadId: message.threadId,
      sourceMessageId: message.id,
      sender: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      messageCreatedAt: message.createdAt,
      isMessageRead: message.isRead,
      isThreadRead: mailThread.isRead,
      extractionId: mailExtraction.id,
      kind: mailExtraction.kind,
      action: actionColumn,
      ownerAction: ownerActionSql(input.transportId),
      payload: mailExtraction.payload,
      extractorVersion: mailExtraction.extractorVersion,
      extractionCreatedAt: mailExtraction.createdAt,
      origin: payloadOrigin,
      automatedChannel,
    })
    .from(message)
    .innerJoin(mailThread, eq(message.threadId, mailThread.id))
    .leftJoin(
      mailExtraction,
      and(eq(mailExtraction.messageId, message.id), eq(mailExtraction.status, 'succeeded')),
    )
    .where(
      and(
        eq(message.transportId, input.transportId),
        eq(message.direction, 'inbound'),
        eq(message.threadId, input.threadId),
        eq(mailThread.transportId, input.transportId),
        isNull(mailThread.trashedAt),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${message.receivedAt}, ${message.createdAt})`),
      desc(message.createdAt),
      desc(message.id),
      desc(mailExtraction.createdAt),
      desc(mailExtraction.id),
    );

  const latestByMessage = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByMessage.has(row.sourceMessageId)) latestByMessage.set(row.sourceMessageId, row);
  }
  const newestMessages = [...latestByMessage.values()];
  const extracted = newestMessages.filter((row) => row.extractionId);
  const reviews = await reviewsForSources(
    db,
    input.transportId,
    extracted.map((row) => ({ sourceMessageId: row.sourceMessageId, extractionId: row.extractionId! })),
  );
  const messages: WorkflowThreadMessage[] = newestMessages.map((row) => {
    const currentReview = row.extractionId
      ? reviews.get(`${row.sourceMessageId}:${row.extractionId}`)
      : undefined;
    const extraction = row.extractionId
      ? {
          id: row.extractionId,
          kind: row.kind,
          action: cleanString(row.action) ?? cleanString(asRecord(row.payload).action),
          folder: mapWorkflowFolder({
            action: row.action,
            ownerAction: row.ownerAction,
            payload: row.payload,
            kind: row.kind,
            origin: row.origin,
            automatedChannel: row.automatedChannel,
          }),
          payload: row.payload,
          extractorVersion: row.extractorVersion!,
          createdAt: row.extractionCreatedAt!.toISOString(),
        }
      : null;
    return {
      messageId: row.sourceMessageId,
      sender: row.sender,
      subject: row.subject?.trim() || '(no subject)',
      receivedAt: (row.receivedAt ?? row.messageCreatedAt).toISOString(),
      isRead: row.isMessageRead || row.isThreadRead,
      extraction,
      review: currentReview?.review ?? null,
      workItemStatus: currentReview?.status ?? null,
      ...(reviewSetLabels.has(row.sourceMessageId)
        ? {
            predictedAction: reviewSetLabels.get(row.sourceMessageId)!.predictedAction,
            ownerAction: reviewSetLabels.get(row.sourceMessageId)!.ownerAction,
            markedAt: reviewSetLabels.get(row.sourceMessageId)!.markedAt?.toISOString() ?? null,
          }
        : {}),
    };
  });
  const sourceMessageIds = newestMessages.map((row) => row.sourceMessageId);
  const runs = sourceMessageIds.length
    ? await db
        .select({
          id: aiWorkflowRun.id,
          triggerMessageId: aiWorkflowRun.triggerMessageId,
          readRequest: aiWorkflowRun.readRequest,
          readResult: aiWorkflowRun.readResult,
          state: aiWorkflowRun.state,
          lastError: aiWorkflowRun.lastError,
          createdAt: aiWorkflowRun.createdAt,
          finishedAt: aiWorkflowRun.finishedAt,
          readResultExpiresAt: aiWorkflowRun.readResultExpiresAt,
        })
        .from(aiWorkflowRun)
        .where(
          and(
            eq(aiWorkflowRun.transportId, input.transportId),
            eq(aiWorkflowRun.threadId, input.threadId),
            inArray(aiWorkflowRun.triggerMessageId, sourceMessageIds),
          ),
        )
        .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
        .limit(100)
    : [];

  return {
    folder: input.folder,
    threadId: input.threadId,
    defaultMessageId,
    messages,
    runs: runs.map(storedWorkflowRun),
  };
}

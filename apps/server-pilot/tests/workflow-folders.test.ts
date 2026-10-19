import { and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { __setDbForTests } from '../src/db/client.js';
import { TRANSPORT_ID as CENTURION_TRANSPORT_ID } from '../src/db/seed.js';
import { message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { appRouter } from '../src/trpc/router.js';
import {
  workflowFolderListInputSchema,
  workflowFolderOffset,
} from '../src/trpc/routes/workflow-folders.js';
import { buildMailListConditions } from '../src/mail/folder-semantics.js';
import {
  GOLD_REVIEW_SINCE,
  GOLD_REVIEW_UNTIL,
  hasPrefilledData,
  latestWorkflowThreads,
  mapWorkflowFolder,
  workflowFolderMembershipSql,
} from '../src/mail/workflow-folders.js';

const TRANSPORT = CENTURION_TRANSPORT_ID;
const USER = 'user-ropperman';
const MESSAGE_ID = 'message-source-1';
const EXTRACTION_ID = '00000000-0000-4000-8000-000000000001';

function caller(accessRole: 'owner' | 'admin' | 'member' = 'owner') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: USER, email: 'owner@example.com', name: 'Owner' },
    activeTransportId: TRANSPORT,
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole,
  } as never);
}

function fakeReviewDb(options: {
  sourceFound?: boolean;
  latestExtractionId?: string;
  existingWorkItem?: boolean;
}) {
  const eventWrites: Array<Record<string, unknown>> = [];
  const fixedTime = new Date('2026-10-13T12:00:00.000Z');
  type Query = {
    table?: unknown;
    from: (table: unknown) => Query;
    innerJoin: (...args: unknown[]) => Query;
    where: (...args: unknown[]) => Query;
    orderBy: (...args: unknown[]) => Query;
    limit: (...args: unknown[]) => Promise<unknown[]>;
  };
  const fakeDb = {
    select: () => {
      const query: Query = {
        from(table) {
          query.table = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        async limit() {
          if (query.table === message) {
            return options.sourceFound === false
              ? []
              : [{ threadId: 'thread-1', kind: 'booking', action: null }];
          }
          if (query.table === mailExtraction) {
            return options.latestExtractionId
              ? [{ id: options.latestExtractionId }]
              : [{ id: EXTRACTION_ID }];
          }
          if (query.table === workItem && options.existingWorkItem !== false) {
            return [
              {
                id: 'work-item-1',
                status: 'needs_you',
                state: {},
                extractionId: EXTRACTION_ID,
              },
            ];
          }
          return [];
        },
      };
      return query;
    },
    insert: (table: unknown) => {
      const query = {
        values(value: Record<string, unknown>) {
          if (table === workEvent) eventWrites.push(value);
          return query;
        },
        onConflictDoNothing() {
          return query;
        },
        returning() {
          return Promise.resolve([{ id: 'event-1', at: fixedTime }]);
        },
      };
      return query;
    },
  };
  return { db: fakeDb, eventWrites };
}

async function withFakeDb<T>(db: unknown, run: () => Promise<T>): Promise<T> {
  __setDbForTests({ db: db as never, conn: {} as never });
  try {
    return await run();
  } finally {
    __setDbForTests(null);
  }
}

describe('workflow folder mapping', () => {
  it.each([
    ['quote_availability', 'quotes'],
    ['new_booking', 'new-bookings'],
    ['amend', 'amendments'],
    ['cancel', 'cancellations'],
    ['payment_proof', 'payments'],
    ['billing', 'billing'],
    ['group_event', 'groups-events'],
    ['other_actionable', 'other-to-do'],
    ['no_action', 'not-for-nava'],
  ] as const)('maps action %s to %s', (action, folder) => {
    expect(mapWorkflowFolder({ action, kind: 'quote' })).toBe(folder);
  });

  it('prefers a column action, then a payload action, over legacy kind', () => {
    expect(mapWorkflowFolder({ action: 'new_booking', kind: 'quote' })).toBe('new-bookings');
    expect(
      mapWorkflowFolder({ payload: { action: 'quote_availability' }, kind: 'booking' }),
    ).toBe('quotes');
    expect(mapWorkflowFolder({ action: 'amend', payload: { action: 'cancel' }, kind: 'quote' })).toBe(
      'amendments',
    );
  });

  it('lets a saved owner action override the extraction action', () => {
    expect(
      mapWorkflowFolder({
        ownerAction: 'amend',
        action: 'quote_availability',
        payload: { action: 'new_booking' },
        kind: 'quote',
      }),
    ).toBe('amendments');
    expect(
      mapWorkflowFolder({ ownerAction: '', action: 'quote_availability', kind: 'booking' }),
    ).toBe('quotes');
    expect(mapWorkflowFolder({ ownerAction: 'no_action', action: 'quote_availability' })).toBe(
      'not-for-nava',
    );
  });

  it.each([
    ['quote', 'quotes'],
    ['booking', 'new-bookings'],
    ['amendment', 'amendments'],
    ['cancellation', 'cancellations'],
    ['voucher_pop', 'payments'],
    ['other', 'not-for-nava'],
    ['spam', 'not-for-nava'],
  ] as const)('maps legacy kind %s to %s', (kind, folder) => {
    expect(mapWorkflowFolder({ kind })).toBe(folder);
  });

  it('routes system notices by action, except new bookings go to payments', () => {
    expect(mapWorkflowFolder({ action: 'new_booking', kind: 'booking', origin: 'system_notice' })).toBe(
      'payments',
    );
    expect(mapWorkflowFolder({ action: 'new_booking', kind: 'booking', origin: 'person' })).toBe(
      'new-bookings',
    );
    expect(mapWorkflowFolder({ action: 'amend', kind: 'amendment', origin: 'system_notice' })).toBe(
      'amendments',
    );
    expect(mapWorkflowFolder({ action: 'payment_proof', kind: 'voucher_pop', origin: 'system_notice' })).toBe(
      'payments',
    );
    expect(mapWorkflowFolder({ action: 'no_action', kind: 'booking', origin: 'system_notice' })).toBe(
      'not-for-nava',
    );
    expect(mapWorkflowFolder({ kind: 'booking', origin: 'system_notice' })).toBe('not-for-nava');
    expect(
      mapWorkflowFolder({ action: 'new_booking', kind: 'booking', automatedChannel: true }),
    ).toBe('not-for-nava');
    expect(mapWorkflowFolder({ action: 'future_action', kind: 'spam' })).toBe('other-to-do');
  });

  it('builds SQL membership from the latest owner action before extraction action', () => {
    const query = new PgDialect().sqlToQuery(workflowFolderMembershipSql(TRANSPORT));

    expect(query.sql).toContain('"mail_action_label"."source" = \'owner\'');
    expect(query.sql).toContain('"mail_action_label"."version" = \'owner\'');
    expect(query.sql).toContain('order by "mail_action_label"."updated_at" desc');
    expect(query.sql).toMatch(/coalesce\([\s\S]*?nullif\(btrim\(\([\s\S]*?select "mail_action_label"\."action"/);

    const sqlWithBinds = query.sql.replace(/\$(\d+)/g, (_match, index: string) =>
      String(query.params[Number(index) - 1]),
    );
    const newBookingCase = sqlWithBinds.slice(sqlWithBinds.indexOf('when new_booking then'));
    expect(newBookingCase).toMatch(
      /when new_booking then case when [\s\S]*?origin[\s\S]*?= 'system_notice'[\s\S]*?then payments else new-bookings end/,
    );
    expect(sqlWithBinds).toContain('when amend then amendments');
    expect(sqlWithBinds).toMatch(
      /when no_action then not-for-nava[\s\S]*?else 'other-to-do' end\s+when [\s\S]*?origin[\s\S]*?= 'system_notice' then 'not-for-nava'/,
    );
  });

  it('counts a successful extraction as prefilled only when a displayable value exists', () => {
    expect(hasPrefilledData({ contact: { name: null }, stays: [] })).toBe(false);
    expect(hasPrefilledData({ contact: { name: 'Taylor Guest' }, stays: [] })).toBe(true);
    expect(hasPrefilledData({ contact: {}, stays: [{ rows: [{ rooms: 2 }] }] })).toBe(true);
  });
});

describe('gold review window SQL binds', () => {
  it('binds the HITL window as timestamptz strings, not Date objects', async () => {
    const conn = postgres({
      hostname: '127.0.0.1',
      port: 9,
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
    });
    try {
      const db = drizzle(conn);
      const latest = latestWorkflowThreads(db, TRANSPORT);
      const query = db.with(latest).select().from(latest).toSQL();
      expect(query.params.filter((value) => value instanceof Date)).toEqual([]);
      expect(query.sql).toContain('::timestamptz');
      expect(query.params).toEqual(
        expect.arrayContaining([GOLD_REVIEW_SINCE.toISOString(), GOLD_REVIEW_UNTIL.toISOString()]),
      );
    } finally {
      await conn.end({ timeout: 1 });
    }
  });

  it('applies the gold window and staff-outbound filter only to Centurion', async () => {
    const conn = postgres({
      hostname: '127.0.0.1',
      port: 9,
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
    });
    try {
      const db = drizzle(conn);
      const centurion = latestWorkflowThreads(db, TRANSPORT);
      const centurionQuery = db.with(centurion).select().from(centurion).toSQL();
      const davinci = latestWorkflowThreads(db, 'transport-ayanda');
      const davinciQuery = db.with(davinci).select().from(davinci).toSQL();

      expect(centurionQuery.sql).toContain('staff_gold_out');
      expect(centurionQuery.params).toEqual(
        expect.arrayContaining([GOLD_REVIEW_SINCE.toISOString(), GOLD_REVIEW_UNTIL.toISOString()]),
      );
      expect(davinciQuery.sql).not.toContain('staff_gold_out');
      expect(davinciQuery.params).not.toContain(GOLD_REVIEW_SINCE.toISOString());
      expect(davinciQuery.params).not.toContain(GOLD_REVIEW_UNTIL.toISOString());
    } finally {
      await conn.end({ timeout: 1 });
    }
  });
});

describe('workflow mail list conditions', () => {
  it('uses workflow membership without Inbox state restrictions', () => {
    const query = new PgDialect().sqlToQuery(
      and(...buildMailListConditions({} as never, TRANSPORT, 'inbox', 'quotes'))!,
    );

    expect(query.sql).toBe('"mail_thread"."transport_id" = $1');
    expect(query.params).toEqual([TRANSPORT]);
  });
});

describe('workflow folder list pagination', () => {
  it('accepts React Query’s empty initial cursor as offset zero', () => {
    const input = workflowFolderListInputSchema.parse({ folder: 'quotes', cursor: '' });
    expect(input.cursor).toBe('');
    expect(workflowFolderOffset(input.cursor)).toBe(0);
  });

  it('accepts React Query direction and the eval review set', () => {
    expect(
      workflowFolderListInputSchema.parse({
        folder: 'quotes',
        limit: 100,
        cursor: '',
        direction: 'forward',
        set: 'eval',
      }),
    ).toMatchObject({
      folder: 'quotes',
      limit: 100,
      cursor: '',
      direction: 'forward',
      set: 'eval',
    });
  });

  it('still rejects unknown keys', () => {
    expect(() => workflowFolderListInputSchema.parse({ folder: 'quotes', extra: 1 })).toThrow();
  });
});

describe('workflowFolders.setActionLabel input and access', () => {
  it('rejects actions outside the shared action vocabulary', async () => {
    const mutation = (
      caller().workflowFolders as unknown as { setActionLabel?: (input: unknown) => Promise<unknown> }
    ).setActionLabel;
    expect(mutation).toBeTypeOf('function');
    if (!mutation) throw new Error('setActionLabel mutation is missing');
    await expect(mutation({ messageId: MESSAGE_ID, action: 'not-an-action' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('forbids member action marks before opening the database', async () => {
    const mutation = (
      caller('member').workflowFolders as unknown as {
        setActionLabel?: (input: unknown) => Promise<unknown>;
      }
    ).setActionLabel;
    expect(mutation).toBeTypeOf('function');
    if (!mutation) throw new Error('setActionLabel mutation is missing');
    await expect(mutation({ messageId: MESSAGE_ID, action: 'amend' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('workItems.adminReview', () => {
  it('refuses hotel staff with member access', async () => {
    await expect(
      caller('member').workItems.adminReview({
        sourceMessageId: 'msg-1',
        extractionId: '00000000-0000-4000-8000-000000000000',
        decision: 'right',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records a masked append-only admin_review event for the shown extraction', async () => {
    const fake = fakeReviewDb({});
    const result = await withFakeDb(fake.db, () =>
      caller().workItems.adminReview({
        sourceMessageId: MESSAGE_ID,
        extractionId: EXTRACTION_ID,
        decision: 'right',
        note: 'Matched alex@example.com; call +27825551234 if needed.',
      }),
    );

    expect(result).toMatchObject({
      workItemId: 'work-item-1',
      eventId: 'event-1',
      decision: 'right',
      reviewedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(fake.eventWrites).toHaveLength(1);
    expect(fake.eventWrites[0]).toMatchObject({
      workItemId: 'work-item-1',
      actorKind: 'user',
      actorUserId: USER,
      type: 'admin_review',
      value: { decision: 'right', note: expect.stringContaining('[email]') },
      evidence: { sourceMessageId: MESSAGE_ID, extractionId: EXTRACTION_ID, kind: 'booking' },
    });
    expect(JSON.stringify(fake.eventWrites[0]?.value)).not.toContain('alex@example.com');
  });

  it('rejects a stale extraction before writing a work event', async () => {
    const fake = fakeReviewDb({ latestExtractionId: '00000000-0000-4000-8000-000000000002' });
    await expect(
      withFakeDb(fake.db, () =>
        caller().workItems.adminReview({
          sourceMessageId: MESSAGE_ID,
          extractionId: EXTRACTION_ID,
          decision: 'wrong',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fake.eventWrites).toHaveLength(0);
  });

  it('rejects a message outside the active transport before writing', async () => {
    const fake = fakeReviewDb({ sourceFound: false });
    await expect(
      withFakeDb(fake.db, () =>
        caller().workItems.adminReview({
          sourceMessageId: MESSAGE_ID,
          extractionId: EXTRACTION_ID,
          decision: 'edited',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.eventWrites).toHaveLength(0);
  });
});

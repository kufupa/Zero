import { describe, expect, it } from 'vitest';
import { __setDbForTests } from '../src/db/client.js';
import { message } from '../src/db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../src/db/schema/work.js';
import { appRouter } from '../src/trpc/router.js';
import {
  workflowFolderListInputSchema,
  workflowFolderOffset,
} from '../src/trpc/routes/workflow-folders.js';
import { hasPrefilledData, mapWorkflowFolder } from '../src/mail/workflow-folders.js';

const TRANSPORT = 'transport-centurion';
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

  it('sends system mail to Not for Nava and leaves unknown actions visible for review', () => {
    expect(mapWorkflowFolder({ action: 'new_booking', kind: 'booking', origin: 'system_notice' })).toBe(
      'not-for-nava',
    );
    expect(mapWorkflowFolder({ kind: 'booking', automatedChannel: true })).toBe('not-for-nava');
    expect(mapWorkflowFolder({ action: 'future_action', kind: 'spam' })).toBe('other-to-do');
  });

  it('counts a successful extraction as prefilled only when a displayable value exists', () => {
    expect(hasPrefilledData({ contact: { name: null }, stays: [] })).toBe(false);
    expect(hasPrefilledData({ contact: { name: 'Taylor Guest' }, stays: [] })).toBe(true);
    expect(hasPrefilledData({ contact: {}, stays: [{ rows: [{ rooms: 2 }] }] })).toBe(true);
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

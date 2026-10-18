import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import {
  mailActionLabel,
  mailboxTransport,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import type { MailAction } from '../src/mail/action-labels.js';
import {
  FOLDER_ACTIONS,
  WORKFLOW_FOLDER_IDS,
  goldRemainingInFolder,
  listWorkflowFolderRows,
} from '../src/mail/workflow-folders.js';
import { appRouter } from '../src/trpc/router.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';

const TRANSPORT_ID = 'workflow-gold-remaining-transport';
const OTHER_TRANSPORT_ID = 'workflow-gold-remaining-other';
const OWNER_ID = 'workflow-gold-remaining-owner';

type AccessRole = 'owner' | 'admin' | 'member';

function caller(transportId = TRANSPORT_ID, accessRole: AccessRole = 'owner') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: OWNER_ID, email: 'owner@example.invalid', name: 'Owner' },
    activeTransportId: transportId,
    transportEmail: 'fixture@example.invalid',
    accessRole,
  } as never);
}

async function withRouteDb<T>(db: DB, run: () => Promise<T>): Promise<T> {
  __setDbForTests({ db, conn: {} as never });
  try {
    return await run();
  } finally {
    __setDbForTests(null);
  }
}

async function seedTransport(db: DB, transportId = TRANSPORT_ID) {
  await db.insert(mailboxTransport).values({
    id: transportId,
    email: `${transportId}@example.invalid`,
    ownerHeaderValue: transportId,
    mailboxType: 'personal',
  });
}

async function seedQuoteRow(
  db: DB,
  options: { threadId: string; messageId: string; transportId?: string },
) {
  const transportId = options.transportId ?? TRANSPORT_ID;
  await db.insert(mailThread).values({
    id: options.threadId,
    transportId,
    threadRootId: options.threadId,
  });
  await db.insert(message).values({
    id: options.messageId,
    transportId,
    threadId: options.threadId,
    direction: 'inbound',
    fromAddress: 'fixture@example.invalid',
    subject: 'Quote request',
  });
  await db.insert(mailExtraction).values({
    messageId: options.messageId,
    extractorVersion: 'gold-remaining-test-v1',
    status: 'succeeded',
    kind: 'quote',
    payload: { action: 'quote_availability' },
  });
}

async function seedOwnerGold(
  db: DB,
  options: {
    messageId: string;
    action: MailAction;
    labelledBy?: string;
    transportId?: string;
  },
) {
  await db.insert(mailActionLabel).values({
    transportId: options.transportId ?? TRANSPORT_ID,
    messageId: options.messageId,
    source: 'owner',
    version: 'owner',
    action: options.action,
    needsAction: options.action !== 'no_action',
    labelledBy: options.labelledBy ?? OWNER_ID,
  });
}

async function ownerRows(db: DB, messageId: string) {
  return db
    .select()
    .from(mailActionLabel)
    .where(
      and(
        eq(mailActionLabel.messageId, messageId),
        eq(mailActionLabel.source, 'owner'),
        eq(mailActionLabel.version, 'owner'),
      ),
    );
}

describe('FOLDER_ACTIONS', () => {
  it('is the inverse of the nine workflow folders', () => {
    expect(FOLDER_ACTIONS).toEqual({
      quotes: 'quote_availability',
      'new-bookings': 'new_booking',
      amendments: 'amend',
      cancellations: 'cancel',
      payments: 'payment_proof',
      billing: 'billing',
      'groups-events': 'group_event',
      'other-to-do': 'other_actionable',
      'not-for-nava': 'no_action',
    });
    expect(Object.keys(FOLDER_ACTIONS).sort()).toEqual([...WORKFLOW_FOLDER_IDS].sort());
  });
});

describe('workflowFolders.goldRemainingInFolder input and access', () => {
  it('forbids members before opening the database', async () => {
    const mutation = (
      caller(TRANSPORT_ID, 'member').workflowFolders as unknown as {
        goldRemainingInFolder?: (input: unknown) => Promise<unknown>;
      }
    ).goldRemainingInFolder;
    expect(mutation).toBeTypeOf('function');
    if (!mutation) throw new Error('goldRemainingInFolder mutation is missing');
    await expect(mutation({ folder: 'quotes' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe.skipIf(!TEST_DB_AVAILABLE)('goldRemainingInFolder (disposable PostgreSQL)', () => {
  it('golds three unlabelled Quote rows as quote_availability and leaves them in Quotes', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedQuoteRow(db, { threadId: 'gold-q1', messageId: 'gold-m1' });
      await seedQuoteRow(db, { threadId: 'gold-q2', messageId: 'gold-m2' });
      await seedQuoteRow(db, { threadId: 'gold-q3', messageId: 'gold-m3' });

      const result = await goldRemainingInFolder(db, {
        transportId: TRANSPORT_ID,
        folder: 'quotes',
        labelledBy: OWNER_ID,
      });
      const quotes = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);

      expect(result).toEqual({ goldWrote: 3 });
      expect(quotes.rows.map((row) => row.sourceMessageId).sort()).toEqual([
        'gold-m1',
        'gold-m2',
        'gold-m3',
      ]);
      for (const messageId of ['gold-m1', 'gold-m2', 'gold-m3']) {
        expect(await ownerRows(db, messageId)).toMatchObject([
          { action: 'quote_availability', labelledBy: OWNER_ID, needsAction: true },
        ]);
      }
    });
  });

  it('does not overwrite an already-gold amend override', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedQuoteRow(db, { threadId: 'gold-amend', messageId: 'gold-amend-m' });
      await seedOwnerGold(db, {
        messageId: 'gold-amend-m',
        action: 'amend',
        labelledBy: 'original-owner',
      });
      await seedQuoteRow(db, { threadId: 'gold-open', messageId: 'gold-open-m' });

      const result = await goldRemainingInFolder(db, {
        transportId: TRANSPORT_ID,
        folder: 'quotes',
        labelledBy: OWNER_ID,
      });
      const quotes = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      const amendments = await listWorkflowFolderRows(db, TRANSPORT_ID, 'amendments', 0, 10);

      expect(result).toEqual({ goldWrote: 1 });
      expect(quotes.rows.map((row) => row.sourceMessageId)).toEqual(['gold-open-m']);
      expect(amendments.rows.map((row) => row.sourceMessageId)).toEqual(['gold-amend-m']);
      expect(await ownerRows(db, 'gold-amend-m')).toMatchObject([
        { action: 'amend', labelledBy: 'original-owner' },
      ]);
      expect(await ownerRows(db, 'gold-open-m')).toMatchObject([
        { action: 'quote_availability', labelledBy: OWNER_ID },
      ]);
    });
  });

  it('skips an already-gold Quote row in the same folder', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedQuoteRow(db, { threadId: 'gold-saved', messageId: 'gold-saved-m' });
      await seedOwnerGold(db, {
        messageId: 'gold-saved-m',
        action: 'quote_availability',
        labelledBy: 'original-owner',
      });
      await seedQuoteRow(db, { threadId: 'gold-open', messageId: 'gold-open-m' });

      const before = (await ownerRows(db, 'gold-saved-m'))[0];
      const result = await goldRemainingInFolder(db, {
        transportId: TRANSPORT_ID,
        folder: 'quotes',
        labelledBy: OWNER_ID,
      });
      const after = (await ownerRows(db, 'gold-saved-m'))[0];

      expect(result).toEqual({ goldWrote: 1 });
      expect(after?.labelledBy).toBe('original-owner');
      expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
      expect(await ownerRows(db, 'gold-open-m')).toMatchObject([
        { action: 'quote_availability', labelledBy: OWNER_ID },
      ]);
    });
  });

  it('returns goldWrote 0 for an empty folder without error', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await expect(
        goldRemainingInFolder(db, {
          transportId: TRANSPORT_ID,
          folder: 'quotes',
          labelledBy: OWNER_ID,
        }),
      ).resolves.toEqual({ goldWrote: 0 });
    });
  });

  it('forbids members with zero writes and ignores other-transport mail', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedTransport(db, OTHER_TRANSPORT_ID);
      await seedQuoteRow(db, { threadId: 'gold-here', messageId: 'gold-here-m' });
      await seedQuoteRow(db, {
        threadId: 'gold-there',
        messageId: 'gold-there-m',
        transportId: OTHER_TRANSPORT_ID,
      });

      await withRouteDb(db, async () => {
        await expect(
          caller(TRANSPORT_ID, 'member').workflowFolders.goldRemainingInFolder({ folder: 'quotes' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(await ownerRows(db, 'gold-here-m')).toHaveLength(0);

        const result = await caller().workflowFolders.goldRemainingInFolder({ folder: 'quotes' });
        expect(result).toEqual({ goldWrote: 1 });
      });

      expect(await ownerRows(db, 'gold-here-m')).toMatchObject([{ action: 'quote_availability' }]);
      expect(await ownerRows(db, 'gold-there-m')).toHaveLength(0);
    });
  });

  it('keeps Save as gold ownerAction mapping after Done on the rest', async () => {
    await withTestDb(async (db) => {
      await seedTransport(db);
      await seedQuoteRow(db, { threadId: 'gold-saved', messageId: 'gold-saved-m' });
      await seedQuoteRow(db, { threadId: 'gold-open', messageId: 'gold-open-m' });

      await withRouteDb(db, async () => {
        await caller().workflowFolders.setActionLabel({
          messageId: 'gold-saved-m',
          action: 'amend',
        });
        const result = await caller().workflowFolders.goldRemainingInFolder({ folder: 'quotes' });
        expect(result).toEqual({ goldWrote: 1 });
      });

      const quotes = await listWorkflowFolderRows(db, TRANSPORT_ID, 'quotes', 0, 10);
      const amendments = await listWorkflowFolderRows(db, TRANSPORT_ID, 'amendments', 0, 10);
      expect(quotes.rows.map((row) => row.sourceMessageId)).toEqual(['gold-open-m']);
      expect(amendments.rows.map((row) => row.sourceMessageId)).toEqual(['gold-saved-m']);
      expect(await ownerRows(db, 'gold-saved-m')).toMatchObject([{ action: 'amend' }]);
      expect(await ownerRows(db, 'gold-open-m')).toMatchObject([{ action: 'quote_availability' }]);
    });
  });
});

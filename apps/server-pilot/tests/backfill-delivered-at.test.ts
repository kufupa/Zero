import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseDeliveredAtArgs,
  runDeliveredAtBackfill,
} from '../scripts/backfill-delivered-at.js';
import { message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const TRANSPORT = 'transport-centurion';
const MAILBOX = 'centurion@legacyhotels.co.za';

describe('backfill-delivered-at', () => {
  it('defaults to dry-run and rejects conflicting modes', () => {
    expect(parseDeliveredAtArgs([])).toEqual({ apply: false, help: false });
    expect(parseDeliveredAtArgs(['--dry-run'])).toEqual({ apply: false, help: false });
    expect(parseDeliveredAtArgs(['--apply'])).toEqual({ apply: true, help: false });
    expect(parseDeliveredAtArgs(['--help'])).toEqual({ apply: false, help: true });
    expect(() => parseDeliveredAtArgs(['--apply', '--dry-run'])).toThrow();
    expect(() => parseDeliveredAtArgs(['--unknown'])).toThrow();
  });

  it('dry-runs without writes, stamps only open non-Outlook POP3 rows, merges provenance, and is idempotent', () =>
    withIngestionDb(async ({ db: rawDb }) => {
      const db = rawDb;

      async function addRow(
        key: string,
        opts: {
          status: 'needs_you' | 'review' | 'done';
          kind?: 'quote' | 'spam';
          pop3Uidl?: string | null;
          rawMimeS3Key?: string | null;
          sourceProvenance?: Record<string, unknown> | null;
        },
      ): Promise<{ messageId: string; workItemId: string }> {
        const threadId = `thread-delivered-at-backfill-${key}`;
        const messageId = `msg-delivered-at-backfill-${key}`;
        const workItemId = randomUUID();
        await seedInboxThread(db, {
          threadId,
          transportId: TRANSPORT,
          transportEmail: MAILBOX,
          messageId,
          subject: 'Delivery backfill fixture',
        });
        await db.update(message).set({
          pop3Uidl: opts.pop3Uidl === undefined ? `uidl-${key}` : opts.pop3Uidl,
          ingestMailboxId: opts.pop3Uidl === null ? null : 'ingest-nava-legacy',
          rawMimeS3Key: opts.rawMimeS3Key ?? null,
          sourceProvenance: opts.sourceProvenance ?? null,
        }).where(eq(message.id, messageId));
        await db.insert(workItem).values({
          id: workItemId,
          transportId: TRANSPORT,
          threadId,
          sourceMessageId: messageId,
          kind: opts.kind ?? 'quote',
          status: opts.status,
        });
        return { messageId, workItemId };
      }

      const primary = await addRow('primary', {
        status: 'needs_you',
        sourceProvenance: { source: 'pop3', attention: 'AMBIGUOUS_IDENTITY' },
      });
      const reviewed = await addRow('reviewed', {
        status: 'review',
        rawMimeS3Key: 'raw-mime-fixture/reviewed.eml',
      });
      await addRow('outlook', {
        status: 'needs_you',
        sourceProvenance: { canonicalContentVersion: 'fixture-v1' },
      });
      await addRow('done', { status: 'done' });
      await addRow('not-pop3', { status: 'needs_you', pop3Uidl: null });
      await addRow('already-stamped', {
        status: 'needs_you',
        sourceProvenance: { deliveredAt: '2026-10-10T08:00:00.000Z' },
      });
      await addRow('spam', { status: 'needs_you', kind: 'spam' });

      const prefix = Buffer.from(
        'Received: from mx.example.test by hotel.example.test; Tue, 06 Oct 2026 10:00:00 +0000\r\nFrom: guest@example.test\r\n\r\n',
        'latin1',
      );
      const readKeys: string[] = [];
      const readRawMimePrefix = async (key: string) => {
        readKeys.push(key);
        return prefix;
      };

      const dryRun = await runDeliveredAtBackfill({ db, apply: false, readRawMimePrefix });
      expect(dryRun).toEqual({
        apply: false,
        candidates: 2,
        planned: 2,
        stamped: 0,
        skippedMissingRawMime: 0,
        skippedMissingReceived: 0,
        messageIds: [primary.messageId, reviewed.messageId].sort(),
      });
      expect(readKeys.sort()).toEqual([
        'raw-mime/ingest-nava-legacy/uidl-primary.eml',
        'raw-mime-fixture/reviewed.eml',
      ].sort());
      expect(
        await db.select({ sourceProvenance: message.sourceProvenance }).from(message)
          .where(eq(message.id, primary.messageId)),
      ).toEqual([{ sourceProvenance: { source: 'pop3', attention: 'AMBIGUOUS_IDENTITY' } }]);
      expect(await db.select().from(workEvent)).toEqual([]);

      readKeys.length = 0;
      const applied = await runDeliveredAtBackfill({ db, apply: true, readRawMimePrefix });
      expect(applied).toEqual({ ...dryRun, apply: true, stamped: 2 });
      expect(readKeys).toHaveLength(2);
      expect(
        await db.select({ sourceProvenance: message.sourceProvenance }).from(message)
          .where(eq(message.id, primary.messageId)),
      ).toEqual([{
        sourceProvenance: {
          source: 'pop3',
          attention: 'AMBIGUOUS_IDENTITY',
          deliveredAt: '2026-10-06T10:00:00.000Z',
        },
      }]);
      const auditRows = await db.select({ workItemId: workEvent.workItemId, type: workEvent.type })
        .from(workEvent);
      expect(auditRows).toHaveLength(2);
      expect(auditRows).toEqual(expect.arrayContaining([
        { workItemId: primary.workItemId, type: 'source.delivered_at.backfilled' },
        { workItemId: reviewed.workItemId, type: 'source.delivered_at.backfilled' },
      ]));

      readKeys.length = 0;
      const secondApply = await runDeliveredAtBackfill({ db, apply: true, readRawMimePrefix });
      expect(secondApply).toEqual({
        apply: true,
        candidates: 0,
        planned: 0,
        stamped: 0,
        skippedMissingRawMime: 0,
        skippedMissingReceived: 0,
        messageIds: [],
      });
      expect(readKeys).toHaveLength(0);
      expect(await db.select().from(workEvent)).toHaveLength(2);
    }));
});

/**
 * U13: saved rates belong to one transport and are archived, not deleted, so an approved quote keeps the name and amount it
 * was priced with. Each test runs in a rolled-back transaction. A statement that fails is always the last one in its test,
 * because Postgres refuses further statements after an error inside a transaction.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { NAVA_TRANSPORT_ID, NAVA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { customRate, workEvent, workItem } from '../src/db/schema/work.js';
import { appendWorkEvent, quoteWorkItemIdFor, recordRateEvents } from '../src/ai/work-events.js';
import { snapshotRowPrices } from '../src/trpc/routes/rates.js';
import { quotedTotalWithStoredExtras, storedRowPrices } from '../src/ai/prior-quote-booking.js';
import { quoteWorkbookForStays } from '../src/quote-proposal/quote-workbook.js';
import { seedInboxThread } from './helpers/seed-inbox-thread';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { syntheticRevision } from './helpers/synthetic-quote-revision';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('saved rates (seeded, transaction-rollback)', () => {
  it('creates a saved rate for the active transport, recorded against the session user', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const created = await caller.rates.create({ name: '  Corporate Q4  ', amountMinor: 185_000 });
      expect(created).toEqual({ id: expect.any(String), name: 'Corporate Q4', amountMinor: 185_000, currency: 'ZAR' });

      const [row] = await db.select().from(customRate).where(eq(customRate.id, created.id));
      expect(row).toMatchObject({ transportId: NAVA_TRANSPORT_ID, createdBy: NAVA_USER_ID });
      expect(row?.archivedAt).toBeNull();
      expect((await caller.rates.list()).map((rate) => rate.id)).toContain(created.id);
    });
  });

  it('refuses a second active rate with the same name', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      await caller.rates.create({ name: 'Repeat group', amountMinor: 150_000 });
      await expect(caller.rates.create({ name: 'Repeat group', amountMinor: 160_000 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'A saved rate with this name already exists',
      });
    });
  });

  it('once a rate is archived, its name can be used again', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const first = await caller.rates.create({ name: 'Repeat group', amountMinor: 150_000 });
      await caller.rates.archive({ id: first.id });
      await expect(caller.rates.create({ name: 'Repeat group', amountMinor: 160_000 })).resolves.toMatchObject({
        name: 'Repeat group',
        amountMinor: 160_000,
      });
    });
  });

  it('renaming a rate to a name another active rate uses is refused', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      await caller.rates.create({ name: 'Taken name', amountMinor: 150_000 });
      const other = await caller.rates.create({ name: 'Other name', amountMinor: 160_000 });
      await expect(caller.rates.update({ id: other.id, name: 'Taken name', amountMinor: 160_000 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'A saved rate with this name already exists',
      });
    });
  });

  it('edits an active rate, and an archived rate cannot be edited', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const rate = await caller.rates.create({ name: 'Group', amountMinor: 150_000 });
      await expect(caller.rates.update({ id: rate.id, name: 'Group B', amountMinor: 155_000 })).resolves.toMatchObject({
        id: rate.id,
        name: 'Group B',
        amountMinor: 155_000,
      });
      await caller.rates.archive({ id: rate.id });
      await expect(caller.rates.update({ id: rate.id, name: 'Group C', amountMinor: 1 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  it('archiving hides a rate from the list and keeps its row for the quotes that used it', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const rate = await caller.rates.create({ name: 'Old group', amountMinor: 150_000 });
      await expect(caller.rates.archive({ id: rate.id })).resolves.toEqual({ id: rate.id });
      expect((await caller.rates.list()).map((row) => row.id)).not.toContain(rate.id);

      const [row] = await db.select().from(customRate).where(eq(customRate.id, rate.id));
      expect(row?.archivedAt).not.toBeNull();
      await expect(caller.rates.archive({ id: rate.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('a rate belongs to its transport', async () => {
    await withSeededTestDb(async (db) => {
      const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const centurion = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
      const rate = await nava.rates.create({ name: 'Nava only', amountMinor: 150_000 });
      expect((await centurion.rates.list()).map((row) => row.id)).not.toContain(rate.id);
      await expect(centurion.rates.update({ id: rate.id, name: 'Taken', amountMinor: 1 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(centurion.rates.archive({ id: rate.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('refuses an empty name, and an amount that is zero or not whole minor units', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      await expect(caller.rates.create({ name: '   ', amountMinor: 1_000 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.rates.create({ name: 'Zero', amountMinor: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.rates.create({ name: 'Fraction', amountMinor: 12.5 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  it('a saved row takes the rate name and amount, and a retired or foreign rate is refused', async () => {
    await withSeededTestDb(async (db) => {
      const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const rate = await nava.rates.create({ name: 'Snapshot group', amountMinor: 175_000 });
      const groups = [{ id: 'g1' }, { id: 'g2' }];

      await expect(
        snapshotRowPrices(db, NAVA_TRANSPORT_ID, {
          groups,
          rowPrices: [
            { groupId: 'g1', source: 'saved', customRateId: rate.id },
            { groupId: 'g2', source: 'one_off', oneOffRate: 120_000 },
          ],
        }),
      ).resolves.toEqual([
        { groupId: 'g1', source: 'saved', customRateId: rate.id, name: 'Snapshot group', amountMinor: 175_000 },
        { groupId: 'g2', source: 'one_off', amountMinor: 120_000 },
      ]);

      // A rate of another transport is not offered on this one.
      await expect(
        snapshotRowPrices(db, TRANSPORT_ID, {
          groups,
          rowPrices: [{ groupId: 'g1', source: 'saved', customRateId: rate.id }],
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

      await nava.rates.archive({ id: rate.id });
      await expect(
        snapshotRowPrices(db, NAVA_TRANSPORT_ID, {
          groups,
          rowPrices: [{ groupId: 'g1', source: 'saved', customRateId: rate.id }],
        }),
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'That saved rate is archived or no longer exists. Pick another rate.',
      });
    });
  });

  it('an approved quote keeps its saved rate after the rate is renamed, repriced and archived', async () => {
    await withSeededTestDb(async (db) => {
      const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: NAVA_TRANSPORT_ID });
      const rate = await nava.rates.create({ name: 'Conference group', amountMinor: 175_000 });
      const revision = await syntheticRevision(['2400.00', '2400.00']);
      const groupId = revision.groups[0]!.id;
      const rowPrices = await snapshotRowPrices(db, NAVA_TRANSPORT_ID, {
        groups: revision.groups,
        rowPrices: [{ groupId, source: 'saved', customRateId: rate.id }],
      });
      const run = {
        transportId: NAVA_TRANSPORT_ID,
        threadId: 'thread-x',
        state: 'succeeded',
        metrics: { staffQuoteAttestation: { revisionIds: [revision.id], rowPrices } },
      };

      await nava.rates.update({ id: rate.id, name: 'Renamed group', amountMinor: 199_000 });
      await nava.rates.archive({ id: rate.id });

      expect(storedRowPrices(run, revision.id)).toEqual([
        { groupId, source: 'saved', customRateId: rate.id, name: 'Conference group', amountMinor: 175_000 },
      ]);
      // Two rooms for two nights at the approved R1,750.
      expect(quotedTotalWithStoredExtras(revision, run)).toBe(700_000);
      const workbook = quoteWorkbookForStays({
        stays: [{ revision, rowPrices: storedRowPrices(run, revision.id) }],
        header: {
          attention: 'Ann Guest',
          company: 'Acme Travel',
          clientEmail: 'ann@example.test',
          clientTelephone: '021 000 0000',
          signerName: 'Staff Member',
          signerEmail: 'staff@example.test',
        },
      });
      expect(workbook.totalMinor).toBe(700_000);
    });
  });

  it('a row price names a row on the quote, and each row takes one price', async () => {
    await withSeededTestDb(async (db) => {
      const groups = [{ id: 'g1' }];
      await expect(
        snapshotRowPrices(db, NAVA_TRANSPORT_ID, {
          groups,
          rowPrices: [{ groupId: 'g9', source: 'one_off', oneOffRate: 1_000 }],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'A priced row is not on this quote' });
      await expect(
        snapshotRowPrices(db, NAVA_TRANSPORT_ID, {
          groups,
          rowPrices: [
            { groupId: 'g1', source: 'one_off', oneOffRate: 1_000 },
            { groupId: 'g1', source: 'one_off', oneOffRate: 2_000 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Each row takes one price' });
    });
  });

  it('a rate event is written to the quote work item, by the session user', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = 'thread-u13-rates';
      const messageId = 'msg-u13-rates';
      await seedInboxThread(db, { threadId, transportId: TRANSPORT_ID, transportEmail: 'quotes@example.test', messageId });
      const [item] = await db
        .insert(workItem)
        .values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageId, kind: 'quote' })
        .returning({ id: workItem.id });
      const workItemId = item!.id;
      expect(await quoteWorkItemIdFor(db, { transportId: TRANSPORT_ID, threadId, messageId })).toBe(workItemId);
      expect(await quoteWorkItemIdFor(db, { transportId: TRANSPORT_ID, threadId, messageId: 'msg-other' })).toBeNull();

      const revision = await syntheticRevision(['2400.00', '2400.00']);
      const group = revision.groups[0]!;
      await recordRateEvents(db, {
        workItemId,
        actorUserId: NAVA_USER_ID,
        workflowRunId: 'run-u13',
        revision,
        rowPrices: [
          { groupId: group.id, source: 'override', rateCode: 'NCOR1B', amountMinor: 185_000, note: "Kamala OK'd – repeat group" },
        ],
      });

      const events = await db.select().from(workEvent).where(eq(workEvent.workItemId, workItemId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'rate.override',
        actorKind: 'user',
        actorUserId: NAVA_USER_ID,
        fieldPath: `quote.rows[${group.id}].rate`,
        aiSource: 'run-u13',
        aiValue: { rateCode: group.rateCode, nightlyMinor: [240_000, 240_000] },
        value: { source: 'override', rateCode: 'NCOR1B', amountMinor: 185_000, note: "Kamala OK'd – repeat group" },
      });

      await expect(
        appendWorkEvent(db, { workItemId, type: 'rate.typo' as never, actorUserId: NAVA_USER_ID }),
      ).rejects.toThrow('work_event_type');
    });
  });
});

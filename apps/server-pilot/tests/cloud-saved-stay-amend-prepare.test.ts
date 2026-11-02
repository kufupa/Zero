import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { user } from '../src/db/schema/auth.js';
import { aiWorkflowRun, mailboxAccess, mailboxTransport, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { lockSavedStayAmendSource, prepareSavedStayAmendment, sameSavedStayAmendSource } from '../src/ai/cloud-saved-stay-amend-prepare.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

let withIngestionDb: typeof import('./helpers/ingestion-db.js').withIngestionDb;

const transportId = 'transport-centurion';
const email = 'centurion@legacyhotels.co.za';
const actor = { actorUserId: 'amend-user', transportId };

async function fixture(db: Parameters<typeof seedInboxThread>[0]) {
  await db.insert(user).values({ id: actor.actorUserId, name: 'Staff', email: 'staff@example.test', emailVerified: true });
  await db.insert(mailboxAccess).values({ id: 'amend-access', userId: actor.actorUserId, transportId, role: 'member' });
  await seedInboxThread(db, { transportId, transportEmail: email, threadId: 'thread-amend',
    messageId: 'mail-amend', subject: 'Please amend', textBody: 'Please change dates.' });
  const [mail] = await db.select().from(message).where(eq(message.id, 'mail-amend'));
  const [item] = await db.insert(workItem).values({ transportId, threadId: 'thread-amend',
    sourceMessageId: 'mail-amend', kind: 'amendment', state: { original: 'unchanged', hmsSnapshot: { digest: 'old', readAt: 'old' } } }).returning();
  if (!mail || !item) throw new Error('fixture missing');
  const selection = { workItemId: item.id, source: { threadId: 'thread-amend', messageId: 'mail-amend',
    mailboxEmail: email, sourceHash: staffQuoteSourceHash(mail) },
    proposal: { confirmation: '12345678-1', changes: { adults: 2 } } };
  return { item, selection };
}

describe.skipIf(!process.env.TEST_DATABASE_URL || process.env.CONFIRM_DISPOSABLE_TEST_DB !== '1')(
  'saved-stay amendment source and preparation boundary', () => {
  beforeAll(async () => { ({ withIngestionDb } = await import('./helpers/ingestion-db.js')); });
  it('checks the real mailbox and current item, but never stores a form or snapshot without a validated saved preimage', async () => {
    await withIngestionDb(async ({ db }) => {
      const { item, selection } = await fixture(db);
      const locked = await db.transaction((tx) => lockSavedStayAmendSource(tx as typeof db, actor, selection));
      expect(locked).toMatchObject({ status: 'source_locked', propertyCode: 'HRCEN', selection });
      expect(await prepareSavedStayAmendment({ db, actor, selection })).toEqual({ status: 'refused', reason: 'saved_preimage_unavailable' });
      const [after] = await db.select().from(workItem).where(eq(workItem.id, item.id));
      expect(after?.state).toEqual(item.state);
      expect(after?.revisionSeq).toBe(item.revisionSeq);
      expect(await db.select().from(workEvent).where(eq(workEvent.workItemId, item.id))).toHaveLength(0);
      expect(await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.workItemId, item.id))).toHaveLength(0);
    });
  });

  it('refuses spoofed actor, mailbox, source, property, and client-supplied preimage', async () => {
    await withIngestionDb(async ({ db }) => {
      const { selection } = await fixture(db);
      expect(await prepareSavedStayAmendment({ db, actor: { ...actor, actorUserId: 'other' }, selection }))
        .toMatchObject({ status: 'refused', reason: 'mailbox_forbidden' });
      for (const source of [
        { ...selection.source, mailboxEmail: 'other@example.test' },
        { ...selection.source, messageId: 'other' },
        { ...selection.source, threadId: 'other' },
        { ...selection.source, sourceHash: 'a'.repeat(64) },
      ]) expect(await prepareSavedStayAmendment({ db, actor, selection: { ...selection, source } }))
        .toMatchObject({ status: 'refused', reason: 'source_changed' });
      for (const extra of [{ propertyCode: 'HRDAV' }, { preimageRef: 'client-snapshot' }, { hmsSnapshot: {} }]) {
        expect(await prepareSavedStayAmendment({ db, actor, selection: { ...selection, ...extra } }))
          .toEqual({ status: 'refused', reason: 'input_invalid' });
      }
      await db.update(mailboxTransport).set({ isActive: false }).where(eq(mailboxTransport.id, transportId));
      expect(await prepareSavedStayAmendment({ db, actor, selection })).toMatchObject({ reason: 'mailbox_forbidden' });
    });
  });

  it('rechecks current source and form under the item lock; closed or changed work is not the old binding', async () => {
    await withIngestionDb(async ({ db }) => {
      const { item, selection } = await fixture(db);
      const check = () => db.transaction((tx) => lockSavedStayAmendSource(tx as typeof db, actor, selection));
      const before = await check();
      await db.update(workItem).set({ state: { edited: true }, revisionSeq: 1 }).where(eq(workItem.id, item.id));
      const after = await check();
      expect(before.status).toBe('source_locked');
      expect(after.status).toBe('source_locked');
      if (before.status === 'source_locked' && after.status === 'source_locked') {
        expect(after.priorFormDigest).not.toBe(before.priorFormDigest);
        expect(after.revisionSeq).not.toBe(before.revisionSeq);
        expect(sameSavedStayAmendSource(before, before)).toBe(true);
        expect(sameSavedStayAmendSource(before, after)).toBe(false);
        expect(sameSavedStayAmendSource(before, { ...before, itemStatus: 'review' })).toBe(false);
        expect(sameSavedStayAmendSource(before, { ...before, propertyCode: 'HRDAV' })).toBe(false);
        expect(sameSavedStayAmendSource(before, { ...before, selection: { ...before.selection,
          proposal: { ...before.selection.proposal, changes: { adults: 3 } } } })).toBe(false);
      }
      await db.update(message).set({ textBody: 'Changed after selection' }).where(and(
        eq(message.id, selection.source.messageId), eq(message.transportId, transportId)));
      expect(await check()).toEqual({ status: 'refused', reason: 'source_changed' });
      await db.update(workItem).set({ status: 'done' }).where(eq(workItem.id, item.id));
      expect(await check()).toEqual({ status: 'refused', reason: 'not_open' });
      await db.delete(mailboxAccess).where(eq(mailboxAccess.id, 'amend-access'));
      expect(await check()).toEqual({ status: 'refused', reason: 'mailbox_forbidden' });
    });
  });
});

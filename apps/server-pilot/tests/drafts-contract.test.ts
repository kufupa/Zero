/**
 * Draft body wire contract: create stores content readable on get/list reopen.
 */
import { describe, expect, it } from 'vitest';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { mailDraft } from '../src/db/schema/mail.js';
import { randomUUID } from 'node:crypto';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'drafts content contract (seeded, transaction-rollback)',
  () => {
    it(
      'drafts.create message reopens non-empty from get and list',
      async () => {
        await withSeededTestDb(async (db) => {
          const caller = await callerFor('user-navaai', { db });
          const body = '<p>Hello draft</p>';

          const { id } = await caller.drafts.create({
            to: '',
            subject: 'Draft contract',
            message: body,
          });

          const got = await caller.drafts.get({ id });
          expect(got.content).toBe(body);

          const listed = await caller.drafts.list({});
          const row = listed.threads.find((t) => t.id === id);
          expect(row?.content).toBe(body);
        });
      },
      30000,
    );

    it('reopens intentionally cleared manual reply headers', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db });
        const { id } = await caller.drafts.create({ to: 'guest@example.com', subject: 'Custom', message: '<p>Reply</p>' });
        await caller.drafts.create({ id, to: '', subject: '', message: '<p>Reply</p>' });
        const got = await caller.drafts.get({ id });
        expect(got).toMatchObject({ headersSaved: true, to: [], cc: [], bcc: [], subject: '' });
      });
    }, 30000);

    it('recognizes historical manual drafts whose cleared subject is null', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db });
        const id = randomUUID();
        await db.insert(mailDraft).values({ id, transportId: caller.ctx.activeTransportId,
          createdByUserId: 'user-navaai', status: 'active', origin: 'manual', subject: null });
        expect(await caller.drafts.get({ id })).toMatchObject({ headersSaved: true, subject: null, to: [] });
      });
    }, 30000);

    it('preserves a cleared subject on the update path', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db });
        const { id } = await caller.drafts.create({ to: 'guest@example.com', subject: 'Custom', message: '<p>Reply</p>' });
        await caller.drafts.update({ id, subject: '' });
        expect(await caller.drafts.get({ id })).toMatchObject({ headersSaved: true, subject: '' });
      });
    }, 30000);

    it('records a staff header snapshot even when it matches empty generated values', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db });
        const id = randomUUID();
        await db.insert(mailDraft).values({ id, transportId: caller.ctx.activeTransportId,
          createdByUserId: 'user-navaai', status: 'active', origin: 'ai',
          toAddresses: [], ccAddresses: [], bccAddresses: [], subject: '',
          textBody: '<p>Reply</p>', htmlBody: '<p>Reply</p>' });
        expect(await caller.drafts.get({ id })).toMatchObject({ headersSaved: false });
        await caller.drafts.create({ id, to: '', subject: '', message: '<p>Reply</p>' });
        expect(await caller.drafts.get({ id })).toMatchObject({ headersSaved: true, to: [], subject: '' });
      });
    }, 30000);
  },
);

/**
 * Fixture loopback E2E — send → loopback queue → POP3 ingest → listThreads.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ingestOnce } from '../src/mail/ingest/worker';
import { FakePop3Client } from '../src/mail/ingest/pop3-client';
import {
  FakeSmtpTransport,
  __setSmtpTransportForTests,
} from '../src/mail/send/smtp';
import { resetFixtureLoopbackStoreForTests } from '../src/mail/fixture-loopback';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('fixture loopback e2e', () => {
  beforeEach(() => {
    resetFixtureLoopbackStoreForTests();
    resetS3Storage();
    setS3Storage(new FakeS3Storage('e2e-bucket'));
  });

  it('E2E-1 app-to-self: send to nava@ → ingest → inbox', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const nava = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['navaai@legacyhotels.co.za'],
          subject: 'self-loop',
          html: '<p>self</p>',
          text: 'self',
        });
        const pop3 = new FakePop3Client();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.some((t) => t.subject === 'self-loop')).toBe(
          true,
        );
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 60000);

  it('E2E-2 external-style: missing-owner → Nava inbox (spamAt null)', async () => {
    await withSeededTestDb(async (db) => {
      const pop3 = new FakePop3Client({
        messages: [{ uidl: 'ext-1', raw: readFixture('missing-owner.eml') }],
      });
      await ingestOnce({
        pop3,
        db,
        ingestMailboxId: 'ingest-nava-legacy',
        maxMessages: 10,
      });
      const nava = await callerFor('user-navaai', {
        db,
        requestedTransportId: 'transport-nava',
      });
      const inbox = await nava.mail.listThreads({ folder: 'inbox' });
      expect(
        inbox.threads.some((t) => t.subject.includes('General reservation')),
      ).toBe(true);
      const spam = await nava.mail.listThreads({ folder: 'spam' });
      expect(
        spam.threads.filter((t) => t.subject.includes('General reservation')),
      ).toHaveLength(0);
    });
  }, 60000);

  it('E2E-3 app-to-external: sent folder only', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const nava = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['external@example.com'],
          subject: 'outbound',
          html: '<p>out</p>',
          text: 'out',
        });
        const pop3 = new FakePop3Client();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const sent = await nava.mail.listThreads({ folder: 'sent' });
        expect(sent.threads.some((t) => t.subject === 'outbound')).toBe(true);
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'outbound')).toHaveLength(
          0,
        );
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 60000);

  it('E2E-4 isolation: Centurion cannot see Nava loopback thread', async () => {
    await withSeededTestDb(async (db) => {
      const fake = new FakeSmtpTransport();
      __setSmtpTransportForTests(fake);
      try {
        const nava = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['navaai@legacyhotels.co.za'],
          subject: 'nava-isolated-loop',
          html: '<p>isolated</p>',
          text: 'isolated',
        });
        const pop3 = new FakePop3Client();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });

        const navaInbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(
          navaInbox.threads.some((t) => t.subject === 'nava-isolated-loop'),
        ).toBe(true);

        const centurion = await callerFor('user-navaai', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const centurionInbox = await centurion.mail.listThreads({
          folder: 'inbox',
        });
        expect(
          centurionInbox.threads.every(
            (t) => t.subject !== 'nava-isolated-loop',
          ),
        ).toBe(true);
        expect(
          centurionInbox.threads.every(
            (t) => t.transportId !== 'transport-nava',
          ),
        ).toBe(true);
      } finally {
        __setSmtpTransportForTests(null);
      }
    });
  }, 60000);
});

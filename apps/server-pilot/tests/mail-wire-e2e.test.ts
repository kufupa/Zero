/**
 * Wire E2E — SMTP/POP3 over Mailpit TCP (RealPop3Client + RealSmtpTransport).
 * Mirrors fixture-loopback-e2e.test.ts scenarios.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { ingestOnce } from '../src/mail/ingest/worker.js';
import { createPop3Client } from '../src/mail/ingest/pop3-client.js';
import { __setSmtpTransportForTests } from '../src/mail/send/smtp.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { callerFor } from './helpers/trpc-caller.js';
import {
  startMailpitForTests,
  wireMailEnv,
  readFixtureEml,
  mailpitConfigured,
  type MailpitContext,
} from './helpers/mailpit.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable || !mailpitConfigured)(
  'mail wire e2e (mailpit tcp)',
  () => {
    let ctx: MailpitContext;

    beforeAll(async () => {
      const started = await startMailpitForTests();
      if (!started) throw new Error('mailpit required for wire e2e');
      ctx = started;
    }, 60_000);

    afterAll(async () => {
      await ctx?.stop();
    });

    beforeEach(async () => {
      await ctx.clearAll();
      resetS3Storage();
      setS3Storage(new FakeS3Storage('wire-e2e-bucket'));
      __setSmtpTransportForTests(null);
      Object.assign(process.env, wireMailEnv(ctx));
    });

    function wirePop3() {
      return createPop3Client({
        MAIL_TRANSPORT_MODE: 'wire',
        POP3_HOST: ctx.pop3Host,
        POP3_PORT: ctx.pop3Port,
        POP3_USER: ctx.pop3User,
        POP3_PASSWORD: ctx.pop3Password,
        POP3_TLS: false,
      })!;
    }

    it('WIRE-1 IT-style BCC: centurion stamp → ingest → centurion inbox', async () => {
      await withSeededTestDb(async (db) => {
        await ctx.injectRawEml(readFixtureEml('centurion-stamped.eml'));
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const centurion = await callerFor('user-manager', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const inbox = await centurion.mail.listThreads({ folder: 'inbox' });
        expect(
          inbox.threads.some((t) => t.subject.includes('Centurion booking')),
        ).toBe(true);
      });
    }, 60_000);

    it('WIRE-2 missing X-Zero-Mailbox → Nava spam', async () => {
      await withSeededTestDb(async (db) => {
        await ctx.injectRawEml(readFixtureEml('missing-owner.eml'));
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        const spam = await nava.mail.listThreads({ folder: 'spam' });
        expect(spam.threads.length).toBeGreaterThan(0);
      });
    }, 60_000);

    it('WIRE-3 app send external → sent only (real SMTP, no loopback)', async () => {
      await withSeededTestDb(async (db) => {
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['external@example.com'],
          subject: 'wire-outbound',
          html: '<p>out</p>',
          text: 'out',
        });
        // Mirror fixture E2E-3 empty FakePop3: external-only sends are not in ingest mailbox.
        // Mailpit captures SMTP locally; drain POP3 queue so ingest does not re-import app sends.
        await ctx.clearAll();
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const sent = await nava.mail.listThreads({ folder: 'sent' });
        expect(sent.threads.some((t) => t.subject === 'wire-outbound')).toBe(true);
        const inbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'wire-outbound')).toHaveLength(
          0,
        );
      });
    }, 60_000);

    it('WIRE-4 isolation: Centurion cannot see Nava wire thread', async () => {
      await withSeededTestDb(async (db) => {
        const nava = await callerFor('user-nava', {
          db,
          requestedTransportId: 'transport-nava',
        });
        await nava.mail.send({
          to: ['nava@legacyhotel.com'],
          subject: 'wire-nava-private',
          html: '<p>nava</p>',
          text: 'nava',
        });
        const pop3 = wirePop3();
        await ingestOnce({
          pop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
        const centurion = await callerFor('user-manager', {
          db,
          requestedTransportId: 'transport-centurion',
        });
        const inbox = await centurion.mail.listThreads({ folder: 'inbox' });
        expect(inbox.threads.filter((t) => t.subject === 'wire-nava-private')).toHaveLength(
          0,
        );
        const navaInbox = await nava.mail.listThreads({ folder: 'inbox' });
        expect(navaInbox.threads.some((t) => t.subject === 'wire-nava-private')).toBe(
          true,
        );
      });
    }, 60_000);
  },
);

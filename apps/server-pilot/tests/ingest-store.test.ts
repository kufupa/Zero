import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailIngestQuarantine,
  message,
  attachment,
  mailThread,
  aiWorkflowRun,
  mailboxTransport,
} from '../src/db/schema/mail';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message';
import { IngestTooLargeError } from '../src/mail/ingest/limits';
import {
  persistInboundMessage,
  quarantineOversizedMessage,
} from '../src/mail/ingest/store';
import { upsertSenderPreference } from '../src/mail/sender-preference';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import type { DB } from '../src/db/client';
import { readFixture } from './helpers/fixtures';
import { DAVINCI_MAILBOX_IDENTITIES } from '../src/hms/mailbox-hms-origin-bind';
import {
  AYANDA_MAILBOX_IDENTITIES,
  AYANDA_TRANSPORT_DISPLAY_NAME,
  AYANDA_TRANSPORT_ID,
  EPICK_MAILBOX_IDENTITIES,
  EPICK_TRANSPORT_DISPLAY_NAME,
  EPICK_TRANSPORT_ID,
  FAITH_MAILBOX_IDENTITIES,
  FAITH_TRANSPORT_DISPLAY_NAME,
  FAITH_TRANSPORT_ID,
  KMGIDI_MAILBOX_IDENTITIES,
  KMGIDI_TRANSPORT_DISPLAY_NAME,
  KMGIDI_TRANSPORT_ID,
} from '../src/db/seed';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

function withIngestOwnerHeaderEnv(
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const prev = process.env.INGEST_REQUIRE_OWNER_HEADER;
  if (value === undefined) delete process.env.INGEST_REQUIRE_OWNER_HEADER;
  else process.env.INGEST_REQUIRE_OWNER_HEADER = value;
  return run().finally(() => {
    if (prev === undefined) delete process.env.INGEST_REQUIRE_OWNER_HEADER;
    else process.env.INGEST_REQUIRE_OWNER_HEADER = prev;
  });
}

async function seedCenturionAliases(db: DB): Promise<void> {
  await db
    .update(mailboxTransport)
    .set({
      sendFromConfig: {
        aliases: [
          'centurion@legacyhotels.co.za',
          'centurion@legacyhotels.com',
          'centurion@legacyhotel.com',
        ],
      },
    })
    .where(eq(mailboxTransport.id, 'transport-centurion'));
}

async function seedHotelMailboxIdentities(
  db: DB,
  spec: {
    id: string;
    identities: readonly string[];
    displayName: string;
  },
): Promise<void> {
  const [email, ...aliases] = spec.identities;
  await db
    .insert(mailboxTransport)
    .values({
      id: spec.id,
      email,
      ownerHeaderValue: email,
      mailboxType: 'personal',
      displayName: spec.displayName,
      isActive: true,
      sendFromConfig: { aliases: [...aliases] },
    })
    .onConflictDoUpdate({
      target: mailboxTransport.id,
      set: {
        email,
        ownerHeaderValue: email,
        sendFromConfig: { aliases: [...aliases] },
        isActive: true,
      },
    });
}

async function seedDavinciIdentities(db: DB): Promise<void> {
  await seedHotelMailboxIdentities(db, {
    id: 'transport-davinci',
    identities: DAVINCI_MAILBOX_IDENTITIES,
    displayName: 'Da Vinci Hotel Reservations',
  });
}

async function seedFaithIdentities(db: DB): Promise<void> {
  await seedHotelMailboxIdentities(db, {
    id: FAITH_TRANSPORT_ID,
    identities: FAITH_MAILBOX_IDENTITIES,
    displayName: FAITH_TRANSPORT_DISPLAY_NAME,
  });
}

async function seedAyandaIdentities(db: DB): Promise<void> {
  await seedHotelMailboxIdentities(db, {
    id: AYANDA_TRANSPORT_ID,
    identities: AYANDA_MAILBOX_IDENTITIES,
    displayName: AYANDA_TRANSPORT_DISPLAY_NAME,
  });
}

/** Missing X-Zero-Mailbox, To not a known transport — quarantine path. */
function unknownToEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.com',
      'To: unknown@example.com',
      'Subject: unrouted external',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'No transport routing header.',
    ].join('\r\n'),
    'utf-8',
  );
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'inbound ingest (seeded, transaction-rollback)',
  () => {
    it(
      'routes stamped Centurion mail to Centurion transport',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // Persist + verify inside ONE seeded transaction so the verify sees
        // the rows the persist inserted (before rollback).
        const { result, stored, threadedId } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, {
            messageId,
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-1',
              messageId,
            },
            { db, storage },
          );
          let row: typeof message.$inferSelect | undefined;
          if (r.kind === 'stored') {
            const rows = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            row = rows[0];
          }
          return { result: r, stored: row, threadedId: messageId };
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-centurion');
        expect(result.messageId).toBe(threadedId);
        expect(result.threadId).toBeTruthy();
        expect(result.attachmentCount).toBe(0);

        // Verify the message row + raw-mime S3 key landed.
        expect(stored).toBeDefined();
        expect(stored!.transportId).toBe('transport-centurion');
        expect(stored!.direction).toBe('inbound');
        expect(stored!.pop3Uidl).toBe('uidl-1');
        expect(stored!.ownerHeaderValue).toBe('centurion@legacyhotel.com');
        expect(stored!.rawMimeS3Key).toBe(result.rawMimeS3Key);

        // Raw MIME was PUT to the fake S3 under raw-mime/.
        expect(storage.stored.has(result.rawMimeS3Key)).toBe(true);
        expect(result.rawMimeS3Key.startsWith('raw-mime/')).toBe(true);
      },
      30000,
    );

    it(
      'direct-To transport email without owner header lands with spamAt null',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('missing-owner.eml');
        const prevGate = process.env.AI_WRITE_GATE_ENABLED;
        process.env.AI_WRITE_GATE_ENABLED = 'true';
        try {
          const { result, stored, thread, triageRuns } = await withSeededTestDb(
            async (db) => {
              const messageId = generateMessageId();
              const parsed = await parseRawMessage(raw, { messageId, storage });
              expect(parsed.ownerHeaderValue).toBeNull();
              expect(parsed.toAddresses).toContain('navaai@legacyhotels.co.za');

              const r = await persistInboundMessage(
                parsed,
                raw,
                {
                  ingestMailboxId: 'ingest-nava-legacy',
                  pop3Uidl: 'uidl-direct-nava-inbox',
                  messageId,
                },
                { db, storage },
              );

              if (r.kind !== 'stored') {
                return {
                  result: r,
                  stored: undefined,
                  thread: undefined,
                  triageRuns: [],
                };
              }
              const messages = await db
                .select()
                .from(message)
                .where(eq(message.id, r.messageId));
              const threads = await db
                .select()
                .from(mailThread)
                .where(eq(mailThread.id, r.threadId));
              const runs = await db
                .select()
                .from(aiWorkflowRun)
                .where(eq(aiWorkflowRun.triggerMessageId, r.messageId));
              return {
                result: r,
                stored: messages[0],
                thread: threads[0],
                triageRuns: runs,
              };
            },
          );

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-nava');
          expect(stored!.ownerHeaderValue).toBeNull();
          expect(thread!.spamAt).toBeNull();
          expect(thread!.labelIds).not.toContain('label-spam-transport-nava');
          expect(triageRuns.length).toBeGreaterThan(0);
          expect(triageRuns[0]!.runKind).toBe('inbound_triage');
        } finally {
          if (prevGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
          else process.env.AI_WRITE_GATE_ENABLED = prevGate;
        }
      },
      30000,
    );

    it(
      'ingest from block-listed sender sets spamAt on persist',
      async () => {
        const storage = withFakeS3();
        const blockedFrom = 'blocked-ingest@example.com';
        const raw = Buffer.from(
          [
            `From: ${blockedFrom}`,
            'To: centurion@legacyhotel.com',
            'X-Zero-Mailbox: centurion@legacyhotel.com',
            'Subject: blocked sender ingest',
            'Message-ID: <blocked-ingest@test>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'should land in spam',
          ].join('\r\n'),
          'utf-8',
        );

        const { result, thread } = await withSeededTestDb(async (db) => {
          await upsertSenderPreference({
            db,
            transportId: 'transport-centurion',
            emailRaw: blockedFrom,
            kind: 'block',
          });

          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: `uidl-block-ingest-${messageId}`,
              messageId,
            },
            { db, storage },
          );

          if (r.kind !== 'stored') {
            return { result: r, thread: undefined };
          }
          const threads = await db
            .select()
            .from(mailThread)
            .where(eq(mailThread.id, r.threadId));
          return { result: r, thread: threads[0] };
        });

        expect(result.kind).toBe('stored');
        expect(thread?.spamAt).not.toBeNull();
      },
      30000,
    );

    it(
      'applies soft-quarantine when AI write gate off and From is external',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('missing-owner.eml');
        const prevGate = process.env.AI_WRITE_GATE_ENABLED;
        process.env.AI_WRITE_GATE_ENABLED = 'false';
        try {
          const { result, thread } = await withSeededTestDb(async (db) => {
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-direct-soft-q',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') return { result: r, thread: undefined };
            const threads = await db
              .select()
              .from(mailThread)
              .where(eq(mailThread.id, r.threadId));
            return { result: r, thread: threads[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(thread!.spamAt).toBeNull();
          expect(thread!.labelIds).toContain(
            'label-soft-quarantine-transport-nava',
          );
        } finally {
          if (prevGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
          else process.env.AI_WRITE_GATE_ENABLED = prevGate;
        }
      },
      30000,
    );

    it(
      'still quarantines missing-header mail with no known To address',
      async () => {
        const storage = withFakeS3();
        const raw = unknownToEml();

        const result = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          return persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-no-direct-match',
              messageId,
            },
            { db, storage },
          );
        });

        expect(result.kind).toBe('quarantined');
        if (result.kind !== 'quarantined') return;
        expect(result.reason).toBe('missing_owner_header');
      },
      30000,
    );

    it(
      'AE1: relaxed toggle routes unstamped To Centurion alias to Centurion transport',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: guest@example.com',
            'To: centurion@legacyhotels.co.za',
            'Subject: unstamped centurion alias',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'BCC copy without stamp.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            expect(parsed.ownerHeaderValue).toBeNull();
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-ae1-centurion-alias',
                messageId,
              },
              { db, storage },
            );
            let row: typeof message.$inferSelect | undefined;
            if (r.kind === 'stored') {
              const rows = await db
                .select()
                .from(message)
                .where(eq(message.id, r.messageId));
              row = rows[0];
            }
            return { result: r, stored: row };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-centurion');
          expect(stored?.direction).toBe('inbound');
        });
      },
      30000,
    );

    it(
      'AE2: relaxed toggle keeps direct-To navaai on Nava transport',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('missing-owner.eml');

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result } = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            return persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-ae2-nava-direct',
                messageId,
              },
              { db, storage },
            );
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-nava');
        });
      },
      30000,
    );

    it(
      'AE3: relaxed toggle treats Centurion From to guest as outbound without triage',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: centurion@legacyhotels.co.za',
            'To: guest@example.com',
            'Subject: centurion outbound copy',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hotel sent copy on sink.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored, triageRuns } = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-ae3-centurion-from',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined, triageRuns: [] };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            const runs = await db
              .select()
              .from(aiWorkflowRun)
              .where(eq(aiWorkflowRun.triggerMessageId, r.messageId));
            return { result: r, stored: messages[0], triageRuns: runs };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-centurion');
          expect(stored?.direction).toBe('outbound');
          // BCC sink copies routinely arrive with Bcc: stripped — Sent must not depend on it.
          expect(stored?.bccAddresses).toEqual([]);
          expect(triageRuns.length).toBe(0);
        });
      },
      30000,
    );

    it(
      'R6: pmbobo@ From to Centurion is inbound, not hotel-sent outbound',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: pmbobo@legacyhotels.co.za',
            'To: centurion@legacyhotels.co.za',
            'Subject: staff note to shared inbox',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Not a Centurion hotel-sent outbound.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-r6-pmbobo-from',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-centurion');
          expect(stored?.direction).toBe('inbound');
        });
      },
      30000,
    );

    it.each([...DAVINCI_MAILBOX_IDENTITIES])(
      'Da Vinci From %s to guest is hotel-sent outbound on transport-davinci',
      async (fromAddress) => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            `From: ${fromAddress}`,
            'To: guest@example.com',
            'Subject: davinci outbound copy',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hotel sent copy on sink.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedDavinciIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `uidl-davinci-from-${fromAddress}`,
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-davinci');
          expect(stored?.direction).toBe('outbound');
        });
      },
      30000,
    );

    it(
      'R6: pmbobo@ From to Da Vinci is inbound, not hotel-sent outbound',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: pmbobo@legacyhotels.co.za',
            `To: ${DAVINCI_MAILBOX_IDENTITIES[0]}`,
            'Subject: staff note to davinci inbox',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Not a Da Vinci hotel-sent outbound.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedDavinciIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-r6-pmbobo-davinci',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe('transport-davinci');
          expect(stored?.direction).toBe('inbound');
        });
      },
      30000,
    );

    it.each([...FAITH_MAILBOX_IDENTITIES])(
      'Faith From %s to guest is hotel-sent outbound on transport-faith',
      async (fromAddress) => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            `From: ${fromAddress}`,
            'To: guest@example.com',
            'Subject: faith outbound copy',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hotel sent copy on sink.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedFaithIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `uidl-faith-from-${fromAddress}`,
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe(FAITH_TRANSPORT_ID);
          expect(stored?.direction).toBe('outbound');
        });
      },
      30000,
    );

    it(
      'R6: pmbobo@ From to Faith is inbound, not hotel-sent outbound',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: pmbobo@legacyhotels.co.za',
            `To: ${FAITH_MAILBOX_IDENTITIES[0]}`,
            'Subject: staff note to faith inbox',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Not a Faith hotel-sent outbound.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedFaithIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-r6-pmbobo-faith',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe(FAITH_TRANSPORT_ID);
          expect(stored?.direction).toBe('inbound');
        });
      },
      30000,
    );

    it.each([...AYANDA_MAILBOX_IDENTITIES])(
      'Ayanda From %s to guest is hotel-sent outbound on transport-ayanda',
      async (fromAddress) => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            `From: ${fromAddress}`,
            'To: guest@example.com',
            'Subject: ayanda outbound copy',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hotel sent copy on sink.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedAyandaIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: `uidl-ayanda-from-${fromAddress}`,
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe(AYANDA_TRANSPORT_ID);
          expect(stored?.direction).toBe('outbound');
        });
      },
      30000,
    );

    it(
      'R6: pmbobo@ From to Ayanda is inbound, not hotel-sent outbound',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: pmbobo@legacyhotels.co.za',
            `To: ${AYANDA_MAILBOX_IDENTITIES[0]}`,
            'Subject: staff note to ayanda inbox',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Not an Ayanda hotel-sent outbound.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv('false', async () => {
          const { result, stored } = await withSeededTestDb(async (db) => {
            await seedAyandaIdentities(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            const r = await persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-r6-pmbobo-ayanda',
                messageId,
              },
              { db, storage },
            );
            if (r.kind !== 'stored') {
              return { result: r, stored: undefined };
            }
            const messages = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            return { result: r, stored: messages[0] };
          });

          expect(result.kind).toBe('stored');
          if (result.kind !== 'stored') return;
          expect(result.transportId).toBe(AYANDA_TRANSPORT_ID);
          expect(stored?.direction).toBe('inbound');
        });
      },
      30000,
    );

    it('unstamped mail with epick only in Cc routes to transport-epick, not quarantine', async () => {
      const storage = withFakeS3();
      const raw = Buffer.from(
        'From: guest@example.com\r\nTo: someone@example.com\r\n' +
          `Cc: ${EPICK_MAILBOX_IDENTITIES[0]}\r\nSubject: epick cc only\r\n` +
          'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCc only.',
      );
      await withIngestOwnerHeaderEnv('false', async () => {
        const result = await withSeededTestDb(async (db) => {
          await seedHotelMailboxIdentities(db, {
            id: EPICK_TRANSPORT_ID,
            identities: EPICK_MAILBOX_IDENTITIES,
            displayName: EPICK_TRANSPORT_DISPLAY_NAME,
          });
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          return persistInboundMessage(parsed, raw, {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-epick-cc',
            messageId,
          }, { db, storage });
        });
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe(EPICK_TRANSPORT_ID);
      });
    }, 30000);

    it('kmgidi From to guest is hotel-sent outbound on transport-kmgidi', async () => {
      const storage = withFakeS3();
      const raw = Buffer.from(
        `From: ${KMGIDI_MAILBOX_IDENTITIES[0]}\r\nTo: guest@example.com\r\n` +
          'Subject: kmgidi outbound copy\r\nMIME-Version: 1.0\r\n' +
          'Content-Type: text/plain; charset=utf-8\r\n\r\nHotel sent copy on sink.',
      );
      await withIngestOwnerHeaderEnv('false', async () => {
        const { result, stored } = await withSeededTestDb(async (db) => {
          await seedHotelMailboxIdentities(db, {
            id: KMGIDI_TRANSPORT_ID,
            identities: KMGIDI_MAILBOX_IDENTITIES,
            displayName: KMGIDI_TRANSPORT_DISPLAY_NAME,
          });
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          const r = await persistInboundMessage(parsed, raw, {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-kmgidi-from-guest',
            messageId,
          }, { db, storage });
          if (r.kind !== 'stored') return { result: r, stored: undefined };
          const rows = await db.select().from(message).where(eq(message.id, r.messageId));
          return { result: r, stored: rows[0] };
        });
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe(KMGIDI_TRANSPORT_ID);
        expect(stored?.direction).toBe('outbound');
      });
    }, 30000);

    it(
      'AE4: strict toggle quarantines unstamped Centurion-equated mail without direct-To',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: centurion@legacyhotels.co.za',
            'To: guest@example.com',
            'Subject: strict quarantine',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Should quarantine when toggle default strict.',
          ].join('\r\n'),
          'utf-8',
        );

        await withIngestOwnerHeaderEnv(undefined, async () => {
          const result = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const messageId = generateMessageId();
            const parsed = await parseRawMessage(raw, { messageId, storage });
            return persistInboundMessage(
              parsed,
              raw,
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-ae4-strict-quarantine',
                messageId,
              },
              { db, storage },
            );
          });

          expect(result.kind).toBe('quarantined');
          if (result.kind !== 'quarantined') return;
          expect(result.reason).toBe('missing_owner_header');
        });
      },
      30000,
    );

    it(
      'routes stamped mail to Centurion when header matches alias value',
      async () => {
        const storage = withFakeS3();
        const raw = Buffer.from(
          [
            'From: guest@example.com',
            'To: guest@example.com',
            'X-Zero-Mailbox: centurion@legacyhotels.co.za',
            'Subject: stamped alias header',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Stamp uses alias not primary owner header.',
          ].join('\r\n'),
          'utf-8',
        );

        const { result } = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotels.co.za');
          return persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-stamped-alias',
              messageId,
            },
            { db, storage },
          );
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-centurion');
      },
      30000,
    );

    it(
      'routes double-stamped mail using relay (last) X-Zero-Mailbox',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-double-stamp.eml');
        const { result, stored } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, {
            messageId,
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-double-stamp',
              messageId,
            },
            { db, storage },
          );
          let row: typeof message.$inferSelect | undefined;
          if (r.kind === 'stored') {
            const rows = await db
              .select()
              .from(message)
              .where(eq(message.id, r.messageId));
            row = rows[0];
          }
          return { result: r, stored: row };
        });

        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.transportId).toBe('transport-centurion');
        expect(stored).toBeDefined();
        expect(stored!.transportId).toBe('transport-centurion');
        expect(stored!.ownerHeaderValue).toBe('centurion@legacyhotel.com');
      },
      30000,
    );

    it(
      'quarantines unknown transport with reason unknown_transport',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // Mutate the header to point at a transport that does not exist.
        const mutated = Buffer.from(
          raw
            .toString('utf-8')
            .replace(
              'X-Zero-Mailbox: centurion@legacyhotel.com',
              'X-Zero-Mailbox: nope@legacyhotel.com',
            ),
          'utf-8',
        );
        const result = await withSeededTestDb(async (db) => {
          const parsed = await parseRawMessage(mutated, {
            messageId: generateMessageId(),
            storage,
          });
          expect(parsed.ownerHeaderValue).toBe('nope@legacyhotel.com');
          return persistInboundMessage(
            parsed,
            mutated,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-3',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
        });
        expect(result.kind).toBe('quarantined');
        if (result.kind !== 'quarantined') return;
        expect(result.reason).toBe('unknown_transport');
      },
      30000,
    );

    it(
      'streams an attachment to S3 and records an attachment row',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-attachment.eml');
        const { result, attRows, threadedId } = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          expect(parsed.attachments.length).toBe(1);
          expect(parsed.attachments[0]!.filename).toBe('invoice-003.pdf');
          const r = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-4',
              messageId,
            },
            { db, storage },
          );
          let rows: typeof attachment.$inferSelect[] = [];
          if (r.kind === 'stored') {
            rows = await db
              .select()
              .from(attachment)
              .where(eq(attachment.messageId, r.messageId));
          }
          return { result: r, attRows: rows, threadedId: messageId };
        });
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.attachmentCount).toBe(1);
        // The DB message.id MUST equal the threaded id (no regeneration).
        expect(result.messageId).toBe(threadedId);

        // Attachment S3 key under attachments/.
        const storedAttachment = storage.listKeys('attachments/');
        expect(storedAttachment.length).toBe(1);
        expect(storedAttachment[0]!.startsWith('attachments/')).toBe(true);
        // S3 attachment key prefix MUST equal the DB message.id
        // (attachments/{message.id}/...). This is the contract being verified.
        expect(storedAttachment[0]!.startsWith(`attachments/${threadedId}/`)).toBe(true);

        // Attachment row in DB (read in the same tx before rollback).
        expect(attRows.length).toBe(1);
        expect(attRows[0]!.filename).toBe('invoice-003.pdf');
        expect(attRows[0]!.mimeType).toBe('application/pdf');
        expect(attRows[0]!.s3Key).toBe(storedAttachment[0]);
        expect(attRows[0]!.sizeBytes).toBeGreaterThan(0);
      },
      30000,
    );

    it(
      'treats a duplicate UIDL as safe-to-drain without re-inserting (inbound index)',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');
        // First + second insert in ONE transaction so the duplicate check
        // sees the first insert's row.
        const { first, second } = await withSeededTestDb(async (db) => {
          const parsed1 = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const f = await persistInboundMessage(
            parsed1,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          const parsed2 = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const s = await persistInboundMessage(
            parsed2,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          return { first: f, second: s };
        });

        expect(first.kind).toBe('stored');
        if (first.kind !== 'stored') return;

        // Second insert with the SAME UIDL — must be reported as duplicate.
        expect(second.kind).toBe('duplicate');
        if (second.kind !== 'duplicate') return;
        expect(second.messageId).toBe(first.messageId);
      },
      30000,
    );

    it(
      'quarantines oversized attachment without leaving a partial message row',
      async () => {
        const prevAttach = process.env.INGEST_MAX_ATTACHMENT_BYTES;
        process.env.INGEST_MAX_ATTACHMENT_BYTES = '50';
        try {
          const storage = withFakeS3();
          const raw = readFixture('centurion-attachment.eml');
          const { result, msgRows, qRow } = await withSeededTestDb(async (db) => {
            const messageId = generateMessageId();
            await expect(
              parseRawMessage(raw, { messageId, storage }),
            ).rejects.toBeInstanceOf(IngestTooLargeError);

            const rawMimeS3Key =
              'raw-mime/ingest-nava-legacy/test/oversized.eml';
            const r = await quarantineOversizedMessage(
              {
                ingestMailboxId: 'ingest-nava-legacy',
                pop3Uidl: 'uidl-oversized',
              },
              rawMimeS3Key,
              { db },
            );
            const msgs = await db
              .select()
              .from(message)
              .where(eq(message.pop3Uidl, 'uidl-oversized'));
            const qs = await db
              .select()
              .from(mailIngestQuarantine)
              .where(eq(mailIngestQuarantine.id, r.quarantineId));
            return { result: r, msgRows: msgs, qRow: qs[0] };
          });

          expect(result.kind).toBe('quarantined');
          if (result.kind !== 'quarantined') return;
          expect(result.reason).toBe('message_too_large');
          expect(msgRows.length).toBe(0);
          expect(qRow).toBeDefined();
          expect(qRow!.reason).toBe('message_too_large');
          expect(qRow!.pop3Uidl).toBe('uidl-oversized');
        } finally {
          if (prevAttach === undefined) {
            delete process.env.INGEST_MAX_ATTACHMENT_BYTES;
          } else {
            process.env.INGEST_MAX_ATTACHMENT_BYTES = prevAttach;
          }
        }
      },
      30000,
    );

    it(
      'quarantine redelivery is idempotent for same ingest UIDL',
      async () => {
        const storage = withFakeS3();
        const raw = unknownToEml();
        const { first, second } = await withSeededTestDb(async (db) => {
          const parsed = await parseRawMessage(raw, {
            messageId: generateMessageId(),
            storage,
          });
          const f = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-q-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          const s = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-q-dup',
              messageId: generateMessageId(),
            },
            { db, storage },
          );
          return { first: f, second: s };
        });

        expect(first.kind).toBe('quarantined');
        expect(second.kind).toBe('quarantined');
        if (first.kind === 'quarantined' && second.kind === 'quarantined') {
          expect(second.quarantineId).toBe(first.quarantineId);
          expect(second.reason).toBe('missing_owner_header');
        }
      },
      30000,
    );

    it(
      'rawMimeKey is deterministic for ingest mailbox + UIDL',
      async () => {
        const { rawMimeKey } = await import('../src/storage/s3.js');
        const a = rawMimeKey({
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-stable',
        });
        const b = rawMimeKey({
          ingestMailboxId: 'ingest-nava-legacy',
          pop3Uidl: 'uidl-stable',
        });
        expect(a).toBe(b);
        expect(a).toBe('raw-mime/ingest-nava-legacy/uidl-stable.eml');
      },
    );
  },
);

// A pure unit test (no DB) — parse only, no persist.
describe('ingest-store Azure Luna labels', () => {
  it('enqueues inbound triage with labels from the resolved profile', () => {
    const source = readFileSync(new URL('../src/mail/ingest/store.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/triageModelLabels/);
    expect(source).not.toMatch(/modelId: DEFAULT_AI_MODEL_ID/);
    expect(source).not.toMatch(/routeId: 'azure_luna_max'/);
  });
});

describe('parseRawMessage (no DB)', () => {
  it('extracts X-Zero-Mailbox and address fields', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-stamped.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
    // fromAddress keeps the display name (parse-message.ts); bare address is Sender-override only.
    expect(parsed.fromAddress).toBe('"Guest One" <guest1@example.com>');
    expect(parsed.toAddresses).toContain('centurion@legacyhotel.com');
    expect(parsed.ccAddresses).toContain('frontdesk@legacyhotel.com');
    expect(parsed.subject).toBe('Centurion booking confirmation #4471');
    expect(parsed.messageId).toBe('centurion-001@legacyhotel.com');
    expect(parsed.attachments.length).toBe(0);
    expect(parsed.textBody).toContain('Booking #4471');
  });

  it('uses last X-Zero-Mailbox when header appears twice', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-double-stamp.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBe('centurion@legacyhotel.com');
  });

  it('returns null ownerHeaderValue when header missing', async () => {
    const storage = withFakeS3();
    const raw = readFixture('missing-owner.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.ownerHeaderValue).toBeNull();
  });

  it('decodes base64 attachment and streams to S3', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-attachment.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.attachments.length).toBe(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe('invoice-003.pdf');
    expect(att.mimeType).toBe('application/pdf');
    // S3 received a PUT under attachments/.
    const keys = storage.listKeys('attachments/');
    expect(keys.length).toBe(1);
    const stored = storage.get(keys[0]!)!;
    // Decoded PDF starts with `%PDF`.
    expect(stored.slice(0, 4).toString('latin1')).toBe('%PDF');
    expect(att.sizeBytes).toBe(stored.byteLength);
  });

  it('rejects oversized attachments via streamToBuffer limit', async () => {
    const prevAttach = process.env.INGEST_MAX_ATTACHMENT_BYTES;
    process.env.INGEST_MAX_ATTACHMENT_BYTES = '50';
    try {
      const storage = withFakeS3();
      const raw = readFixture('centurion-attachment.eml');
      await expect(
        parseRawMessage(raw, {
          messageId: generateMessageId(),
          storage,
        }),
      ).rejects.toBeInstanceOf(IngestTooLargeError);
      expect(storage.listKeys('attachments/').length).toBe(0);
    } finally {
      if (prevAttach === undefined) {
        delete process.env.INGEST_MAX_ATTACHMENT_BYTES;
      } else {
        process.env.INGEST_MAX_ATTACHMENT_BYTES = prevAttach;
      }
    }
  });

  it('prefers Sender over From when they differ (Outlook calendar FW)', async () => {
    const storage = withFakeS3();
    const raw = readFixture('outlook-calendar-fw-sender.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.fromAddress).toBe('kdouglas@legacyhotels.co.za');
  });

  it('keeps From when Sender absent', async () => {
    const storage = withFakeS3();
    const raw = readFixture('centurion-stamped.eml');
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.fromAddress).toBe('"Guest One" <guest1@example.com>');
  });

  it('keeps From when Sender equals From', async () => {
    const storage = withFakeS3();
    const base = readFixture('centurion-stamped.eml').toString('utf-8');
    const raw = Buffer.from(
      base.replace(
        'From: Guest One <guest1@example.com>',
        'From: Guest One <guest1@example.com>\r\nSender: Guest One <guest1@example.com>',
      ),
      'utf-8',
    );
    const parsed = await parseRawMessage(raw, {
      messageId: generateMessageId(),
      storage,
    });
    expect(parsed.fromAddress).toBe('"Guest One" <guest1@example.com>');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'hotel-sent ingest auto-read',
  () => {
    it('marks joined thread read when hotel-sent outbound is stored', async () => {
      const storage = withFakeS3();
      await withSeededTestDb(async (db) => {
        await seedCenturionAliases(db);
        const threadId = 'thread-hotel-sent-autoread-1';
        const inboundHeader = 'guest-inbound-autoread@example.com';
        await db.insert(mailThread).values({
          id: threadId,
          transportId: 'transport-centurion',
          threadRootId: 'root-hotel-sent-autoread-1',
          subject: 'Guest ask',
          snippet: 'need room',
          isArchived: false,
          isStarred: false,
          isRead: false,
          labelIds: [],
          latestMessageAt: new Date(),
        });
        await db.insert(message).values({
          id: 'msg-hotel-sent-inbound-1',
          transportId: 'transport-centurion',
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['centurion@legacyhotel.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'Guest ask',
          textBody: 'need room',
          messageIdHeader: inboundHeader,
          references: [],
          isRead: false,
          isStarred: false,
          receivedAt: new Date(),
        });

        const raw = Buffer.from(
          [
            'From: Centurion Reservations <centurion@legacyhotel.com>',
            'To: guest@example.com',
            'Subject: Re: Guest ask',
            'Date: Thu, 09 Jul 2026 12:00:00 +0000',
            `Message-ID: <hotel-sent-autoread-001@legacyhotel.com>`,
            `In-Reply-To: <${inboundHeader}>`,
            `References: <${inboundHeader}>`,
            'X-Zero-Mailbox: centurion@legacyhotel.com',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'We can help.',
          ].join('\r\n'),
          'utf-8',
        );
        const messageId = generateMessageId();
        const parsed = await parseRawMessage(raw, { messageId, storage });
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `uidl-hotel-sent-${messageId}`,
            messageId,
          },
          { db, storage },
        );
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;
        expect(result.threadId).toBe(threadId);

        const [threadRow] = await db
          .select({ isRead: mailThread.isRead })
          .from(mailThread)
          .where(eq(mailThread.id, threadId));
        expect(threadRow?.isRead).toBe(true);

        const msgs = await db
          .select({ isRead: message.isRead, direction: message.direction })
          .from(message)
          .where(eq(message.threadId, threadId));
        expect(msgs.some((m) => m.direction === 'outbound')).toBe(true);
        expect(msgs.every((m) => m.isRead)).toBe(true);
      });
    }, 30000);

    it('keeps inbound-only thread unread', async () => {
      const storage = withFakeS3();
      await withSeededTestDb(async (db) => {
        await seedCenturionAliases(db);
        const raw = readFixture('centurion-stamped.eml');
        const messageId = generateMessageId();
        const parsed = await parseRawMessage(raw, { messageId, storage });
        const result = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `uidl-inbound-unread-${messageId}`,
            messageId,
          },
          { db, storage },
        );
        expect(result.kind).toBe('stored');
        if (result.kind !== 'stored') return;

        const [threadRow] = await db
          .select({ isRead: mailThread.isRead })
          .from(mailThread)
          .where(eq(mailThread.id, result.threadId));
        expect(threadRow?.isRead).toBe(false);

        const [msgRow] = await db
          .select({ isRead: message.isRead, direction: message.direction })
          .from(message)
          .where(eq(message.id, result.messageId));
        expect(msgRow?.direction).toBe('inbound');
        expect(msgRow?.isRead).toBe(false);
      });
    }, 30000);
  },
);
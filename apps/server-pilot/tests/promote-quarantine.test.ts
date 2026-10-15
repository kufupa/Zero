import {
  assertPromoteEnv,
  formatPromoteSummary,
  parsePromoteCliArgs,
  promoteMissingOwnerHeaderQuarantine,
  PromoteEnvError,
} from '../src/mail/ingest/promote-quarantine';
import {
  aiWorkflowRun,
  mailIngestQuarantine,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import * as ingestStore from '../src/mail/ingest/store';
import { describe, expect, it, vi } from 'vitest';
import { rawMimeKey } from '../src/storage/s3';
import type { DB } from '../src/db/client';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

function withIngestOwnerHeaderEnv(value: string, run: () => Promise<void>): Promise<void> {
  const prev = process.env.INGEST_REQUIRE_OWNER_HEADER;
  process.env.INGEST_REQUIRE_OWNER_HEADER = value;
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

function configuredMailboxOutboundEml(): Buffer {
  return Buffer.from(
    [
      'From: centurion@legacyhotels.co.za',
      'To: guest@example.com',
      'Subject: promote configured mailbox sender',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Synthetic configured mailbox message.',
    ].join('\r\n'),
    'utf-8',
  );
}

function centurionInboundWithAttachmentEml(): Buffer {
  return Buffer.from(
    [
      'From: centurion@legacyhotels.co.za',
      'To: guest@example.com',
      'Subject: promote cleanup retry',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="promote-boundary"',
      '',
      '--promote-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'ReserveCloud staff copy for promote cleanup.',
      '--promote-boundary',
      'Content-Type: application/octet-stream; name="promote.bin"',
      'Content-Disposition: attachment; filename="promote.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'cHJvbW90ZQ==',
      '--promote-boundary--',
    ].join('\r\n'),
    'utf-8',
  );
}

function unmatchedAddressEml(): Buffer {
  return Buffer.from(
    [
      'From: unknown@example.invalid',
      'To: unrelated@example.invalid',
      'Subject: unconfigured mailbox',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Synthetic unconfigured message.',
    ].join('\r\n'),
    'utf-8',
  );
}

function ambiguousMailboxEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.invalid',
      'To: centurion@legacyhotels.co.za, navaai@legacyhotels.co.za',
      'Subject: ambiguous configured mailboxes',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Synthetic ambiguous message.',
    ].join('\r\n'),
    'utf-8',
  );
}

function dbWithFailedCleanupRegistration(db: DB): DB {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async () => {
          throw new Error('injected cleanup registration failure');
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DB;
}

async function seedMissingOwnerQuarantine(args: {
  db: DB;
  storage: FakeS3Storage;
  pop3Uidl: string;
  raw: Buffer;
  quarantineId?: string;
  reason?: string;
}): Promise<{ quarantineId: string; rawMimeS3Key: string }> {
  const ingestMailboxId = 'ingest-nava-legacy';
  const rawMimeS3Key = rawMimeKey({
    ingestMailboxId,
    pop3Uidl: args.pop3Uidl,
  });
  await args.storage.putObject({
    key: rawMimeS3Key,
    body: args.raw,
    contentType: 'message/rfc822',
  });
  const quarantineId = args.quarantineId ?? randomUUID();
  await args.db.insert(mailIngestQuarantine).values({
    id: quarantineId,
    ingestMailboxId,
    pop3Uidl: args.pop3Uidl,
    rawMimeS3Key,
    reason: args.reason ?? 'missing_owner_header',
    ownerHeaderValue: null,
    parsedHeaders: { subject: 'promote AE5 inbound' },
  });
  return { quarantineId, rawMimeS3Key };
}

describe('promote-quarantine cli helpers', () => {
  it('routes a configured mailbox sender before normal persistence routing', async () => {
    const storage = withFakeS3();
    const raw = configuredMailboxOutboundEml();
    const row = {
      id: 'q-u11-route',
      ingestMailboxId: 'ingest-other-mailbox',
      pop3Uidl: 'uidl-u11-route',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-other-mailbox',
        pop3Uidl: 'uidl-u11-route',
      }),
    };
    await storage.putObject({
      key: row.rawMimeS3Key,
      body: raw,
      contentType: 'message/rfc822',
    });

    const configuredTransport = {
      id: 'transport-centurion',
      email: 'centurion@legacyhotels.co.za',
      isActive: true,
      sendFromConfig: { aliases: ['centurion@legacyhotels.com'] },
    };
    const db = {
      select: () => {
        let source: unknown;
        const query = {
          from: (table: unknown) => {
            source = table;
            return query;
          },
          where: () => (source === mailboxTransport ? Promise.resolve([configuredTransport]) : query),
          orderBy: () => Promise.resolve([row]),
          limit: () => Promise.resolve([]),
        };
        return query;
      },
    } as unknown as DB;
    const persistSpy = vi
      .spyOn(ingestStore, 'persistInboundMessage')
      .mockImplementation(async (_parsed, _raw, meta, options) => {
        const transportOverride = (options as { transportOverride?: string }).transportOverride;
        if (transportOverride !== 'transport-centurion') {
          return {
            kind: 'quarantined',
            quarantineId: row.id,
            reason: 'missing_owner_header',
            rawMimeS3Key: row.rawMimeS3Key,
            candidateAttachmentCleanupFailureCount: 0,
          };
        }
        return {
          kind: 'stored',
          transportId: 'transport-centurion',
          messageId: meta.messageId,
          threadId: 'thread-u11-route',
          rawMimeS3Key: row.rawMimeS3Key,
          attachmentCount: 0,
        };
      });

    try {
      const result = await withIngestOwnerHeaderEnv('false', () =>
        promoteMissingOwnerHeaderQuarantine({ db, storage }),
      );

      expect(result.stored).toBe(1);
      expect(result.quarantined).toBe(0);
      expect(persistSpy).toHaveBeenCalledWith(
        expect.anything(),
        raw,
        expect.objectContaining({
          ingestMailboxId: row.ingestMailboxId,
          pop3Uidl: row.pop3Uidl,
        }),
        expect.objectContaining({
          promoteQuarantineId: row.id,
          directionOverride: 'outbound',
          transportOverride: 'transport-centurion',
        }),
      );
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('parses dry-run and limit flags', () => {
    expect(parsePromoteCliArgs(['--dry-run', '--limit', '5'])).toEqual({
      dryRun: true,
      limit: 5,
    });
    expect(parsePromoteCliArgs(['--limit=3'])).toEqual({
      dryRun: false,
      limit: 3,
    });
  });

  it('rejects promote when owner-header toggle strict', () => {
    const prev = process.env.INGEST_REQUIRE_OWNER_HEADER;
    process.env.INGEST_REQUIRE_OWNER_HEADER = 'true';
    try {
      expect(() => assertPromoteEnv()).toThrow(PromoteEnvError);
    } finally {
      if (prev === undefined) delete process.env.INGEST_REQUIRE_OWNER_HEADER;
      else process.env.INGEST_REQUIRE_OWNER_HEADER = prev;
    }
  });

  it('formats promote summary', () => {
    expect(
      formatPromoteSummary({
        scanned: 2,
        stored: 1,
        duplicate: 0,
        quarantined: 0,
        errors: 1,
        skipped: 0,
        errorIds: ['q-err'],
        dryRunIds: [],
      }),
    ).toBe('scanned=2 stored=1 duplicate=0 quarantined=0 errors=1 skipped=0 error_ids=q-err');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'promote missing_owner_header quarantine (seeded, rollback)',
  () => {
    it('promotes configured mailbox senders to outbound and deletes quarantine', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-ae5';
      const raw = configuredMailboxOutboundEml();
      const prevGate = process.env.AI_WRITE_GATE_ENABLED;
      process.env.AI_WRITE_GATE_ENABLED = 'true';

      try {
        await withIngestOwnerHeaderEnv('false', async () => {
          const outcome = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const { quarantineId } = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl,
              raw,
            });

            const result = await promoteMissingOwnerHeaderQuarantine({
              db,
              storage,
            });

            const quarantineRows = await db
              .select()
              .from(mailIngestQuarantine)
              .where(eq(mailIngestQuarantine.id, quarantineId));
            const messages = await db.select().from(message).where(eq(message.pop3Uidl, pop3Uidl));
            const triageRuns =
              messages.length > 0
                ? await db
                    .select()
                    .from(aiWorkflowRun)
                    .where(eq(aiWorkflowRun.triggerMessageId, messages[0]!.id))
                : [];

            return { result, quarantineRows, messages, triageRuns };
          });

          expect(outcome.result.stored).toBe(1);
          expect(outcome.result.errors).toBe(0);
          expect(outcome.quarantineRows).toHaveLength(0);
          expect(outcome.messages).toHaveLength(1);
          expect(outcome.messages[0]!.transportId).toBe('transport-centurion');
          expect(outcome.messages[0]!.direction).toBe('outbound');
          expect(outcome.triageRuns).toHaveLength(1);
          expect(outcome.triageRuns[0]!.idempotencyKey).toBe(
            `external-sent-baseline:${outcome.messages[0]!.id}`,
          );
        });
      } finally {
        if (prevGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
        else process.env.AI_WRITE_GATE_ENABLED = prevGate;
      }
    }, 30000);

    it('clears quarantine when same UIDL already stored outbound without duplicate row', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-dup-outbound';
      const raw = configuredMailboxOutboundEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl,
            raw,
          });

          const existingMessageId = randomUUID();
          const threadId = randomUUID();
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: '<existing-outbound@example.com>',
            subject: 'already stored outbound',
            snippet: 'sent copy',
            isArchived: false,
            isStarred: false,
            isRead: false,
            labelIds: [],
            latestMessageAt: new Date(),
          });
          await db.insert(message).values({
            id: existingMessageId,
            transportId: 'transport-centurion',
            threadId,
            ingestMailboxId: 'ingest-nava-legacy',
            direction: 'outbound',
            pop3Uidl,
            ownerHeaderValue: null,
            messageIdHeader: '<existing-outbound@example.com>',
            inReplyTo: null,
            references: [],
            fromAddress: 'centurion@legacyhotels.co.za',
            toAddresses: ['guest@example.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'already stored outbound',
            textBody: 'sent copy',
            htmlBody: null,
            rawMimeS3Key: rawMimeKey({
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl,
            }),
            receivedAt: new Date(),
            sentAt: new Date(),
          });

          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
          });
          const quarantineRows = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          const messages = await db.select().from(message).where(eq(message.pop3Uidl, pop3Uidl));

          return { result, quarantineRows, messages, existingMessageId };
        });

        expect(outcome.result.duplicate).toBe(1);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.quarantineRows).toHaveLength(0);
        expect(outcome.messages).toHaveLength(1);
        expect(outcome.messages[0]!.id).toBe(outcome.existingMessageId);
      });
    }, 30000);

    it('keeps quarantine row when S3 object missing and counts error', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-missing-s3';

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const quarantineId = randomUUID();
          const rawMimeS3Key = 'raw-mime/missing/object.eml';
          await db.insert(mailIngestQuarantine).values({
            id: quarantineId,
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
            rawMimeS3Key,
            reason: 'missing_owner_header',
            ownerHeaderValue: null,
            parsedHeaders: null,
          });

          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
          });
          const quarantineRows = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));

          return { result, quarantineRows, quarantineId };
        });

        expect(outcome.result.errors).toBe(1);
        expect(outcome.result.errorIds).toContain(outcome.quarantineId);
        expect(outcome.quarantineRows).toHaveLength(1);
      });
    }, 30000);

    it('skips unmatched, ambiguous, and rows with another quarantine reason', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          const wrapper = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-wrapper',
            raw: unmatchedAddressEml(),
          });
          const noreply = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-noreply',
            raw: ambiguousMailboxEml(),
          });
          const otherReason = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-other-reason',
            raw: configuredMailboxOutboundEml(),
            reason: 'unknown_transport',
          });

          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
          });
          const rows = await db.select().from(mailIngestQuarantine);
          const messages = await db.select().from(message);
          return {
            result,
            rows,
            messages,
            ids: [wrapper.quarantineId, noreply.quarantineId, otherReason.quarantineId],
          };
        });

        expect(outcome.result.scanned).toBe(2);
        expect(outcome.result.skipped).toBe(2);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.result.errors).toBe(0);
        expect(outcome.rows.map((row) => row.id)).toEqual(expect.arrayContaining(outcome.ids));
        expect(outcome.messages).toHaveLength(0);
      });
    }, 30000);

    it('dry-run lists quarantine ids without writes', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-dry-run';
      const raw = configuredMailboxOutboundEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl,
            raw,
          });

          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
          });
          const quarantineRows = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          const messages = await db.select().from(message).where(eq(message.pop3Uidl, pop3Uidl));

          return { result, quarantineRows, messages, quarantineId };
        });

        expect(outcome.result.dryRunIds).toEqual([outcome.quarantineId]);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.quarantineRows).toHaveLength(1);
        expect(outcome.messages).toHaveLength(0);
      });
    }, 30000);

    it('reuses an attachment key after cleanup registration fails before a retry', async () => {
      const storage = withFakeS3();
      const pop3Uidl = `uidl-promote-cleanup-${randomUUID()}`;
      const raw = centurionInboundWithAttachmentEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          await seedMissingOwnerQuarantine({ db, storage, pop3Uidl, raw });
          const persistSpy = vi
            .spyOn(ingestStore, 'persistInboundMessage')
            .mockRejectedValueOnce(new Error('injected persist failure'));
          let failed;
          try {
            failed = await promoteMissingOwnerHeaderQuarantine({
              db: dbWithFailedCleanupRegistration(db),
              storage,
            });
          } finally {
            persistSpy.mockRestore();
          }
          const firstAttachmentKeys = storage.listKeys('attachments/');
          const retried = await promoteMissingOwnerHeaderQuarantine({ db, storage });
          return {
            failed,
            firstAttachmentKeys,
            retried,
            retryAttachmentKeys: storage.listKeys('attachments/'),
          };
        });

        expect(outcome.failed.errors).toBe(1);
        expect(outcome.retried.stored).toBe(1);
        expect(outcome.firstAttachmentKeys).toHaveLength(1);
        expect(outcome.retryAttachmentKeys).toEqual(outcome.firstAttachmentKeys);
      });
    }, 30000);

    it('cleans uploaded attachments after promotion persistence fails', async () => {
      const storage = withFakeS3();
      const pop3Uidl = `uidl-promote-persist-failure-${randomUUID()}`;
      const raw = centurionInboundWithAttachmentEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          await seedMissingOwnerQuarantine({ db, storage, pop3Uidl, raw });
          const persistSpy = vi
            .spyOn(ingestStore, 'persistInboundMessage')
            .mockRejectedValueOnce(new Error('injected persist failure'));
          try {
            return await promoteMissingOwnerHeaderQuarantine({ db, storage });
          } finally {
            persistSpy.mockRestore();
          }
        });

        expect(outcome.errors).toBe(1);
        expect(storage.listKeys('attachments/')).toEqual([]);
      });
    }, 30000);
  },
);

import {
  assertPromoteEnv,
  formatPromoteSummary,
  isCenturionIngestMailboxId,
  isPromotableReserveCloudStaff,
  parsePromoteCliArgs,
  promoteCliIsDryRun,
  promoteMissingOwnerHeaderQuarantine,
  PromoteEnvError,
} from '../src/mail/ingest/promote-quarantine';
import {
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  FAITH_TRANSPORT_EMAIL,
  FAITH_TRANSPORT_ID,
  TRANSPORT_EMAIL,
  TRANSPORT_ID,
} from '../src/db/seed';
import * as ingestFanout from '../src/mail/ingest/fanout';
import {
  aiWorkflowRun,
  mailIngestCandidateAttachmentCleanup,
  mailIngestQuarantine,
  mailIngestUidlClaim,
  mailThread,
  mailboxTransport,
  message,
} from '../src/db/schema/mail';
import { candidateMessageIdForPop3Uidl } from '../src/mail/ingest/parse-message';
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

function centurionInboundEml(): Buffer {
  return Buffer.from(
    [
      'From: pmbobo@eu.mail.reservecloud.com',
      'To: centurion@legacyhotels.co.za, guest@example.com',
      'Subject: promote ReserveCloud staff',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'ReserveCloud staff copy for promote.',
    ].join('\r\n'),
    'utf-8',
  );
}

function centurionInboundWithAttachmentEml(): Buffer {
  return Buffer.from(
    [
      'From: pmbobo@eu.mail.reservecloud.com',
      'To: centurion@legacyhotels.co.za, guest@example.com',
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

function reserveCloudWrapperEml(): Buffer {
  return Buffer.from(
    [
      'From: pmbobo@eu.mail.reservecloud.com',
      'To: pmbobo@legacyhotels.co.za',
      'Subject: ReserveCloud wrapper',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Wrapper copy.',
    ].join('\r\n'),
    'utf-8',
  );
}

function twoHotelBoxEml(): Buffer {
  return Buffer.from(
    [
      `From: guest@example.test`,
      `To: ${DAVINCI_TRANSPORT_EMAIL}, ${FAITH_TRANSPORT_EMAIL}`,
      'Subject: two hotel boxes',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Promote two mailbox copies.',
    ].join('\r\n'),
    'utf-8',
  );
}

function unroutablePromoteEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.test',
      'To: guest-copy@example.test',
      'Subject: no hotel mailbox',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'No hotel identity in To/Cc/Bcc/From.',
    ].join('\r\n'),
    'utf-8',
  );
}

function centurionGuestInboundEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.test',
      `To: ${TRANSPORT_EMAIL}`,
      'Subject: centurion only guest',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Centurion-only inbound for mailbox filter.',
    ].join('\r\n'),
    'utf-8',
  );
}

function davinciInboundEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.test',
      `To: ${DAVINCI_TRANSPORT_EMAIL}`,
      'Subject: davinci only guest',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Da Vinci inbound for mailbox filter.',
    ].join('\r\n'),
    'utf-8',
  );
}

function davinciAndCenturionEml(): Buffer {
  return Buffer.from(
    [
      'From: guest@example.test',
      `To: ${DAVINCI_TRANSPORT_EMAIL}, ${TRANSPORT_EMAIL}`,
      'Subject: davinci plus centurion',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Mixed Da Vinci and Centurion inbound.',
    ].join('\r\n'),
    'utf-8',
  );
}

function davinciSenderCalendarForwardEml(): Buffer {
  return Buffer.from(
    [
      'From: organizer@example.test',
      `Sender: ${DAVINCI_TRANSPORT_EMAIL}`,
      'To: guest@example.test',
      'Subject: outlook calendar forward',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Organizer in From, hotel box in Sender.',
    ].join('\r\n'),
    'utf-8',
  );
}

function centurionToDavinciSenderEml(): Buffer {
  return Buffer.from(
    [
      'From: organizer@example.test',
      `Sender: ${DAVINCI_TRANSPORT_EMAIL}`,
      `To: ${TRANSPORT_EMAIL}`,
      'Subject: centurion to davinci sender',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'To wins over Sender for owner filter.',
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
  createdAt?: Date;
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
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
  });
  return { quarantineId, rawMimeS3Key };
}

describe('promote-quarantine cli helpers', () => {
  it('allows promotion only from explicitly owned Centurion ingest mailbox', () => {
    expect(isCenturionIngestMailboxId('ingest-nava-legacy')).toBe(true);
    expect(isCenturionIngestMailboxId('ingest-other-mailbox')).toBe(false);
    expect(isCenturionIngestMailboxId('')).toBe(false);
  });

  it('routes true ReserveCloud staff promotion to Centurion before normal routing', async () => {
    const storage = withFakeS3();
    const raw = centurionInboundEml();
    const row = {
      id: 'q-u11-route',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: 'uidl-u11-route',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-u11-route',
      }),
    };
    await storage.putObject({
      key: row.rawMimeS3Key,
      body: raw,
      contentType: 'message/rfc822',
    });

    const db = {
      select: () => {
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => Promise.resolve([row]),
          limit: () => Promise.resolve([]),
        };
        return query;
      },
    } as unknown as DB;
    const claimSpy = vi.spyOn(ingestStore, 'claimIngestUidl').mockResolvedValue('claim-u11');
    const releaseSpy = vi.spyOn(ingestStore, 'releaseIngestUidlClaim').mockResolvedValue();
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
          activeIngestUidlClaimToken: 'claim-u11',
        }),
      );
    } finally {
      persistSpy.mockRestore();
      claimSpy.mockRestore();
      releaseSpy.mockRestore();
    }
  });

  it('promotes only exact ReserveCloud staff with a non-wrapper recipient', () => {
    expect(
      isPromotableReserveCloudStaff({
        fromAddress: 'pmbobo@eu.mail.reservecloud.com',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
      }),
    ).toBe(true);
  });

  it('skips Penny Legacy-only wrappers', () => {
    expect(
      isPromotableReserveCloudStaff({
        fromAddress: 'pmbobo@eu.mail.reservecloud.com',
        toAddresses: ['pmbobo@legacyhotels.co.za'],
        ccAddresses: [],
        bccAddresses: [],
      }),
    ).toBe(false);
  });

  it('skips noreply, other ReserveCloud senders, and empty recipients', () => {
    const base = {
      toAddresses: ['guest@example.com'],
      ccAddresses: [],
      bccAddresses: [],
    };
    expect(
      isPromotableReserveCloudStaff({
        ...base,
        fromAddress: 'noreply@noreply.reservecloud.com',
      }),
    ).toBe(false);
    expect(
      isPromotableReserveCloudStaff({
        ...base,
        fromAddress: 'other@eu.mail.reservecloud.com',
      }),
    ).toBe(false);
    expect(
      isPromotableReserveCloudStaff({
        fromAddress: 'pmbobo@eu.mail.reservecloud.com',
        toAddresses: [],
        ccAddresses: [],
        bccAddresses: [],
      }),
    ).toBe(false);
  });

  it('parses dry-run and limit flags', () => {
    expect(parsePromoteCliArgs(['--dry-run', '--limit', '5'])).toEqual({
      dryRun: true,
      apply: false,
      limit: 5,
      reason: undefined,
      mailboxes: [],
    });
    expect(parsePromoteCliArgs(['--limit=3'])).toEqual({
      dryRun: false,
      apply: false,
      limit: 3,
      reason: undefined,
      mailboxes: [],
    });
  });

  it('parses repeatable --mailbox flags', () => {
    expect(
      parsePromoteCliArgs([
        '--mailbox',
        'davinci@legacyhotels.co.za',
        '--mailbox=fkhumalo@legacyhotels.co.za',
      ]),
    ).toEqual({
      dryRun: false,
      apply: false,
      limit: undefined,
      reason: undefined,
      mailboxes: ['davinci@legacyhotels.co.za', 'fkhumalo@legacyhotels.co.za'],
    });
    expect(() => parsePromoteCliArgs(['--mailbox'])).toThrow(/--mailbox requires an email address/);
    expect(() => parsePromoteCliArgs(['--mailbox='])).toThrow(/--mailbox requires an email address/);
  });

  it('defaults the script to dry-run unless --apply is explicit', () => {
    expect(promoteCliIsDryRun(parsePromoteCliArgs([]))).toBe(true);
    expect(promoteCliIsDryRun(parsePromoteCliArgs(['--dry-run']))).toBe(true);
    expect(promoteCliIsDryRun(parsePromoteCliArgs(['--apply', '--limit', '2']))).toBe(false);
    expect(parsePromoteCliArgs(['--apply', '--reason', 'multi_transport'])).toEqual({
      dryRun: false,
      apply: true,
      reason: 'multi_transport',
      limit: undefined,
      mailboxes: [],
    });
    expect(() => parsePromoteCliArgs(['--apply', '--dry-run'])).toThrow(
      /--apply and --dry-run cannot be combined/,
    );
    expect(() => parsePromoteCliArgs(['--reason', 'parse_failure'])).toThrow(
      /--reason requires missing_owner_header or multi_transport/,
    );
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
        skippedMailboxFilter: 3,
        errorIds: ['q-err'],
        dryRunIds: [],
      }),
    ).toBe(
      'scanned=2 stored=1 duplicate=0 quarantined=0 errors=1 skipped=0 skipped_mailbox_filter=3 error_ids=q-err',
    );
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'promote missing_owner_header quarantine (seeded, rollback)',
  () => {
    it('promotes true ReserveCloud staff to outbound + deletes quarantine', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-ae5';
      const raw = centurionInboundEml();
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
      const raw = centurionInboundEml();

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

    it('keeps unroutable rows quarantined and ignores other quarantine reasons', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          const wrapper = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-wrapper',
            raw: reserveCloudWrapperEml(),
          });
          const unroutable = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-unroutable',
            raw: unroutablePromoteEml(),
          });
          const otherReason = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-promote-other-reason',
            raw: centurionInboundEml(),
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
            ids: [wrapper.quarantineId, unroutable.quarantineId, otherReason.quarantineId],
          };
        });

        expect(outcome.result.scanned).toBe(2);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.result.quarantined).toBe(2);
        expect(outcome.result.errors).toBe(0);
        expect(outcome.rows.map((row) => row.id)).toEqual(expect.arrayContaining(outcome.ids));
        expect(outcome.messages).toHaveLength(0);
      });
    }, 30000);

    it('dry-run lists quarantine ids without writes', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-dry-run';
      const raw = centurionInboundEml();

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

    it('promotes a two-mailbox row to two messages and enqueues no AI runs', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-two-boxes';
      const raw = twoHotelBoxEml();
      const prevGate = process.env.AI_WRITE_GATE_ENABLED;
      process.env.AI_WRITE_GATE_ENABLED = 'true';

      try {
        await withIngestOwnerHeaderEnv('false', async () => {
          const outcome = await withSeededTestDb(async (db) => {
            const { quarantineId } = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl,
              raw,
              reason: 'multi_transport',
            });

            const result = await promoteMissingOwnerHeaderQuarantine({
              db,
              storage,
            });
            const quarantineRows = await db
              .select()
              .from(mailIngestQuarantine)
              .where(eq(mailIngestQuarantine.id, quarantineId));
            const messages = await db.select().from(message);
            const triageRuns =
              messages.length > 0
                ? await db.select().from(aiWorkflowRun)
                : [];

            return { result, quarantineRows, messages, triageRuns };
          });

          expect(outcome.result.stored).toBe(1);
          expect(outcome.result.errors).toBe(0);
          expect(outcome.quarantineRows).toHaveLength(0);
          expect(outcome.messages).toHaveLength(2);
          expect(outcome.messages.map((row) => row.transportId).sort()).toEqual([
            DAVINCI_TRANSPORT_ID,
            FAITH_TRANSPORT_ID,
          ]);
          expect(outcome.triageRuns).toHaveLength(0);
        });
      } finally {
        if (prevGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
        else process.env.AI_WRITE_GATE_ENABLED = prevGate;
      }
    }, 30000);

    it('dry-run of a two-mailbox row writes nothing', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-two-boxes-dry';
      const raw = twoHotelBoxEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl,
            raw,
            reason: 'multi_transport',
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
          const messages = await db.select().from(message);

          return { result, quarantineRows, messages, quarantineId };
        });

        expect(outcome.result.dryRunIds).toEqual([outcome.quarantineId]);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.quarantineRows).toHaveLength(1);
        expect(outcome.messages).toHaveLength(0);
      });
    }, 30000);

    it('keeps the quarantine row when a mailbox copy fails', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-copy-fail';
      const raw = twoHotelBoxEml();
      const copiesSpy = vi.spyOn(ingestFanout, 'completeFanoutAfterPrimary').mockResolvedValue(false);

      try {
        await withIngestOwnerHeaderEnv('false', async () => {
          const outcome = await withSeededTestDb(async (db) => {
            const { quarantineId } = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl,
              raw,
              reason: 'multi_transport',
            });

            const result = await promoteMissingOwnerHeaderQuarantine({
              db,
              storage,
            });
            const quarantineRows = await db
              .select()
              .from(mailIngestQuarantine)
              .where(eq(mailIngestQuarantine.id, quarantineId));
            const messages = await db.select().from(message);

            return { result, quarantineRows, messages };
          });

          expect(outcome.result.errors).toBe(1);
          expect(outcome.result.stored).toBe(0);
          expect(outcome.quarantineRows).toHaveLength(1);
          expect(outcome.messages).toHaveLength(1);
        });
      } finally {
        copiesSpy.mockRestore();
      }
    }, 30000);

    it('keeps quarantine when the UIDL claim is already held', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-claim-held';
      const raw = twoHotelBoxEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl,
            raw,
            reason: 'multi_transport',
          });
          await db.insert(mailIngestUidlClaim).values({
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
            claimToken: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          });

          const result = await promoteMissingOwnerHeaderQuarantine({ db, storage });
          const quarantineRows = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          const messages = await db.select().from(message);
          return { result, quarantineRows, messages, quarantineId };
        });

        expect(outcome.result.errors).toBe(1);
        expect(outcome.result.errorIds).toEqual([outcome.quarantineId]);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.quarantineRows).toHaveLength(1);
        expect(outcome.messages).toHaveLength(0);
      });
    }, 30000);

    it('keeps quarantine and skips parse upload when attachment cleanup is pending', async () => {
      const storage = withFakeS3();
      const pop3Uidl = 'uidl-promote-cleanup-pending';
      const raw = centurionInboundWithAttachmentEml();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl,
            raw,
          });
          const messageId = candidateMessageIdForPop3Uidl('ingest-nava-legacy', pop3Uidl);
          await db.insert(mailIngestCandidateAttachmentCleanup).values({
            s3Key: `attachments/${messageId}/stale.bin`,
            candidateMessageId: messageId,
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl,
          });

          const result = await promoteMissingOwnerHeaderQuarantine({ db, storage });
          const quarantineRows = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          const messages = await db.select().from(message);
          return { result, quarantineRows, messages, quarantineId };
        });

        expect(outcome.result.errors).toBe(1);
        expect(outcome.result.errorIds).toEqual([outcome.quarantineId]);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.quarantineRows).toHaveLength(1);
        expect(outcome.messages).toHaveLength(0);
        expect(storage.listKeys('attachments/')).toEqual([]);
      });
    }, 30000);

    it('mailbox filter skips centurion-only and neither, promotes Da Vinci and mixed fan-out', async () => {
      const storage = withFakeS3();
      const prevGate = process.env.AI_WRITE_GATE_ENABLED;
      process.env.AI_WRITE_GATE_ENABLED = 'true';

      try {
        await withIngestOwnerHeaderEnv('false', async () => {
          const outcome = await withSeededTestDb(async (db) => {
            await seedCenturionAliases(db);
            const centurion = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl: 'uidl-filter-centurion',
              raw: centurionGuestInboundEml(),
            });
            const neither = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl: 'uidl-filter-neither',
              raw: unroutablePromoteEml(),
            });
            const davinci = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl: 'uidl-filter-davinci',
              raw: davinciInboundEml(),
            });
            const mixed = await seedMissingOwnerQuarantine({
              db,
              storage,
              pop3Uidl: 'uidl-filter-mixed',
              raw: davinciAndCenturionEml(),
              reason: 'multi_transport',
            });

            const result = await promoteMissingOwnerHeaderQuarantine({
              db,
              storage,
              mailboxes: [DAVINCI_TRANSPORT_EMAIL],
            });
            const remaining = await db.select().from(mailIngestQuarantine);
            const messages = await db.select().from(message);
            const triageRuns = await db.select().from(aiWorkflowRun);
            return {
              result,
              remainingIds: remaining.map((row) => row.id).sort(),
              kept: [centurion.quarantineId, neither.quarantineId].sort(),
              promoted: [davinci.quarantineId, mixed.quarantineId],
              messages,
              triageRuns,
            };
          });

          expect(outcome.result.skippedMailboxFilter).toBe(2);
          expect(outcome.result.stored).toBe(2);
          expect(outcome.result.errors).toBe(0);
          expect(outcome.remainingIds).toEqual(outcome.kept);
          expect(outcome.messages.map((row) => row.transportId).sort()).toEqual(
            [DAVINCI_TRANSPORT_ID, DAVINCI_TRANSPORT_ID, TRANSPORT_ID].sort(),
          );
          expect(outcome.triageRuns).toHaveLength(0);
        });
      } finally {
        if (prevGate === undefined) delete process.env.AI_WRITE_GATE_ENABLED;
        else process.env.AI_WRITE_GATE_ENABLED = prevGate;
      }
    }, 30000);

    it('without --mailbox still promotes centurion-only rows', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-nofilter-centurion',
            raw: centurionGuestInboundEml(),
          });
          const result = await promoteMissingOwnerHeaderQuarantine({ db, storage });
          const remaining = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          const messages = await db.select().from(message);
          return { result, remaining, messages };
        });

        expect(outcome.result.skippedMailboxFilter ?? 0).toBe(0);
        expect(outcome.result.stored).toBe(1);
        expect(outcome.remaining).toHaveLength(0);
        expect(outcome.messages).toHaveLength(1);
        expect(outcome.messages[0]!.transportId).toBe(TRANSPORT_ID);
      });
    }, 30000);

    it('dry-run with --mailbox counts skipped_mailbox_filter and would-land matches', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const centurion = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-dry-filter-centurion',
            raw: centurionGuestInboundEml(),
          });
          const davinci = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-dry-filter-davinci',
            raw: davinciInboundEml(),
          });
          const mixed = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-dry-filter-mixed',
            raw: davinciAndCenturionEml(),
            reason: 'multi_transport',
          });
          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
            mailboxes: [DAVINCI_TRANSPORT_EMAIL],
          });
          const remaining = await db.select().from(mailIngestQuarantine);
          const messages = await db.select().from(message);
          return {
            result,
            remaining,
            messages,
            centurionId: centurion.quarantineId,
            matchIds: [davinci.quarantineId, mixed.quarantineId],
          };
        });

        expect(outcome.result.skippedMailboxFilter).toBe(1);
        expect(outcome.result.stored).toBe(0);
        expect(outcome.result.dryRunIds.sort()).toEqual(outcome.matchIds.sort());
        expect(outcome.remaining).toHaveLength(3);
        expect(outcome.messages).toHaveLength(0);
        expect(formatPromoteSummary(outcome.result)).toMatch(/skipped_mailbox_filter=1/);
      });
    }, 30000);

    it('limit counts matching rows after the mailbox filter', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const centurion = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-limit-centurion',
            raw: centurionGuestInboundEml(),
            createdAt: new Date('2026-01-01T00:00:00Z'),
          });
          const firstDavinci = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-limit-davinci-a',
            raw: davinciInboundEml(),
            createdAt: new Date('2026-01-01T00:00:01Z'),
          });
          const secondDavinci = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-limit-davinci-b',
            raw: davinciInboundEml(),
            createdAt: new Date('2026-01-01T00:00:02Z'),
          });
          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            limit: 1,
            mailboxes: [DAVINCI_TRANSPORT_EMAIL],
          });
          const remaining = await db.select().from(mailIngestQuarantine);
          const messages = await db.select().from(message);
          return {
            result,
            remainingIds: remaining.map((row) => row.id).sort(),
            kept: [centurion.quarantineId, secondDavinci.quarantineId].sort(),
            promotedId: firstDavinci.quarantineId,
            messages,
          };
        });

        expect(outcome.result.skippedMailboxFilter).toBe(1);
        expect(outcome.result.stored).toBe(1);
        expect(outcome.result.scanned).toBe(2);
        expect(outcome.remainingIds).toEqual(outcome.kept);
        expect(outcome.messages).toHaveLength(1);
        expect(outcome.messages[0]!.transportId).toBe(DAVINCI_TRANSPORT_ID);
      });
    }, 30000);

    it('mailbox filter uses Sender when it differs from From', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-filter-sender-davinci',
            raw: davinciSenderCalendarForwardEml(),
          });
          const davinci = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
            mailboxes: [DAVINCI_TRANSPORT_EMAIL],
          });
          const centurion = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
            mailboxes: [TRANSPORT_EMAIL],
          });
          const remaining = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          return { davinci, centurion, remaining, quarantineId };
        });

        expect(outcome.davinci.dryRunIds).toEqual([outcome.quarantineId]);
        expect(outcome.davinci.skippedMailboxFilter).toBe(0);
        expect(outcome.centurion.dryRunIds).toEqual([]);
        expect(outcome.centurion.skippedMailboxFilter).toBe(1);
        expect(outcome.remaining).toHaveLength(1);
      });
    }, 30000);

    it('mailbox filter skips Sender when To already names a hotel', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const { quarantineId } = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-filter-to-centurion-sender-davinci',
            raw: centurionToDavinciSenderEml(),
          });
          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
            mailboxes: [DAVINCI_TRANSPORT_EMAIL],
          });
          const remaining = await db
            .select()
            .from(mailIngestQuarantine)
            .where(eq(mailIngestQuarantine.id, quarantineId));
          return { result, remaining, quarantineId };
        });

        expect(outcome.result.dryRunIds).toEqual([]);
        expect(outcome.result.skippedMailboxFilter).toBe(1);
        expect(outcome.remaining).toHaveLength(1);
      });
    }, 30000);

    it('pre-filter missing S3 does not consume --limit matching rows', async () => {
      const storage = withFakeS3();

      await withIngestOwnerHeaderEnv('false', async () => {
        const outcome = await withSeededTestDb(async (db) => {
          await seedCenturionAliases(db);
          const missingId = randomUUID();
          await db.insert(mailIngestQuarantine).values({
            id: missingId,
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: 'uidl-limit-missing-s3',
            rawMimeS3Key: 'raw-mime/missing/limit-filter.eml',
            reason: 'missing_owner_header',
            ownerHeaderValue: null,
            parsedHeaders: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          });
          const davinci = await seedMissingOwnerQuarantine({
            db,
            storage,
            pop3Uidl: 'uidl-limit-after-missing-s3',
            raw: davinciInboundEml(),
            createdAt: new Date('2026-01-01T00:00:01Z'),
          });
          const result = await promoteMissingOwnerHeaderQuarantine({
            db,
            storage,
            dryRun: true,
            limit: 1,
            mailboxes: [DAVINCI_TRANSPORT_EMAIL],
          });
          return { result, missingId, davinciId: davinci.quarantineId };
        });

        expect(outcome.result.errors).toBe(1);
        expect(outcome.result.errorIds).toEqual([outcome.missingId]);
        expect(outcome.result.dryRunIds).toEqual([outcome.davinciId]);
        expect(outcome.result.skippedMailboxFilter).toBe(0);
      });
    }, 30000);
  },
);

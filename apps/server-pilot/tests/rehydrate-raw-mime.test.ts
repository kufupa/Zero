import {
  formatRehydrateSummary,
  parseRawMimeKey,
  parseRehydrateCliArgs,
  rehydrateRawMimeFromS3,
} from '../src/mail/ingest/rehydrate-raw-mime';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { FakeS3Storage, rawMimeKey } from '../src/storage/s3';
import * as ingestStore from '../src/mail/ingest/store';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client';

const reachable = await probeTestDb();

function candidateWithAttachment(): Buffer {
  return Buffer.from(
    [
      'X-Zero-Mailbox: centurion@legacyhotels.co.za',
      'From: guest@example.com',
      'To: centurion@legacyhotels.co.za',
      'Subject: rehydrate cleanup retry',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="rehydrate-boundary"',
      '',
      '--rehydrate-boundary',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'rehydrate cleanup retry',
      '--rehydrate-boundary',
      'Content-Type: application/octet-stream; name="rehydrate.bin"',
      'Content-Disposition: attachment; filename="rehydrate.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'cmVoeWRyYXRl',
      '--rehydrate-boundary--',
    ].join('\r\n'),
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

describe('rehydrate-raw-mime helpers', () => {
  it('parseRawMimeKey extracts ingest mailbox + uidl stem', () => {
    expect(
      parseRawMimeKey(
        'raw-mime/ingest-nava-legacy/257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_.eml',
      ),
    ).toEqual({
      key: 'raw-mime/ingest-nava-legacy/257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_.eml',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: '257.fv8YAORTGS8O7UKzzToFVCinLVAJ_ROLYEH5gLsOHWo_',
    });
  });

  it('parseRawMimeKey rejects non raw-mime keys', () => {
    expect(parseRawMimeKey('attachments/msg/001-a.pdf')).toBeNull();
    expect(parseRawMimeKey('raw-mime/only-one-segment.eml')).toBeNull();
  });

  it('parseRehydrateCliArgs accepts dry-run, triage, limit, prefix', () => {
    expect(
      parseRehydrateCliArgs([
        '--dry-run',
        '--triage',
        '--limit',
        '5',
        '--prefix',
        'raw-mime/ingest-nava-legacy/',
      ]),
    ).toEqual({
      dryRun: true,
      triage: true,
      limit: 5,
      prefix: 'raw-mime/ingest-nava-legacy/',
    });
  });

  it('formatRehydrateSummary is compact', () => {
    expect(
      formatRehydrateSummary({
        scanned: 10,
        skippedExisting: 2,
        skippedQuarantine: 1,
        stored: 5,
        duplicate: 1,
        quarantined: 0,
        errors: 1,
        errorKeys: ['raw-mime/x/a.eml'],
        dryRunKeys: [],
      }),
    ).toContain('stored=5');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('rehydrate raw MIME cleanup retry', () => {
  it('reuses an attachment key after cleanup registration fails before a retry', async () => {
    const storage = new FakeS3Storage('rehydrate-cleanup-retry');
    const ingestMailboxId = 'ingest-nava-legacy';
    const pop3Uidl = `rehydrate-cleanup-${crypto.randomUUID()}`;
    const key = rawMimeKey({ ingestMailboxId, pop3Uidl });
    const raw = candidateWithAttachment();
    const previousOwnerHeaderSetting = process.env.INGEST_REQUIRE_OWNER_HEADER;
    process.env.INGEST_REQUIRE_OWNER_HEADER = 'false';

    try {
      await storage.putObject({
        key,
        body: raw,
        contentType: 'message/rfc822',
      });
      const result = await withSeededTestDb(async (db) => {
        const persistSpy = vi
          .spyOn(ingestStore, 'persistInboundMessage')
          .mockRejectedValueOnce(new Error('injected persist failure'));
        let failed;
        try {
          failed = await rehydrateRawMimeFromS3({
            db: dbWithFailedCleanupRegistration(db),
            storage,
            keys: [{ key, ingestMailboxId, pop3Uidl }],
          });
        } finally {
          persistSpy.mockRestore();
        }
        const firstAttachmentKeys = storage.listKeys('attachments/');
        const retried = await rehydrateRawMimeFromS3({
          db,
          storage,
          keys: [{ key, ingestMailboxId, pop3Uidl }],
        });

        return {
          failed,
          firstAttachmentKeys,
          retried,
          retryAttachmentKeys: storage.listKeys('attachments/'),
        };
      });

      expect(result.failed.errors).toBe(1);
      expect(result.retried.stored).toBe(1);
      expect(result.firstAttachmentKeys).toHaveLength(1);
      expect(result.retryAttachmentKeys).toEqual(result.firstAttachmentKeys);
    } finally {
      if (previousOwnerHeaderSetting === undefined) {
        delete process.env.INGEST_REQUIRE_OWNER_HEADER;
      } else {
        process.env.INGEST_REQUIRE_OWNER_HEADER = previousOwnerHeaderSetting;
      }
    }
  }, 30000);

  it('cleans uploaded attachments after rehydrate persistence fails', async () => {
    const storage = new FakeS3Storage('rehydrate-cleanup-persist-failure');
    const ingestMailboxId = 'ingest-nava-legacy';
    const pop3Uidl = `rehydrate-persist-failure-${crypto.randomUUID()}`;
    const key = rawMimeKey({ ingestMailboxId, pop3Uidl });
    const raw = candidateWithAttachment();
    const previousOwnerHeaderSetting = process.env.INGEST_REQUIRE_OWNER_HEADER;
    process.env.INGEST_REQUIRE_OWNER_HEADER = 'false';

    try {
      await storage.putObject({
        key,
        body: raw,
        contentType: 'message/rfc822',
      });
      const result = await withSeededTestDb(async (db) => {
        const persistSpy = vi
          .spyOn(ingestStore, 'persistInboundMessage')
          .mockRejectedValueOnce(new Error('injected persist failure'));
        try {
          return await rehydrateRawMimeFromS3({
            db,
            storage,
            keys: [{ key, ingestMailboxId, pop3Uidl }],
          });
        } finally {
          persistSpy.mockRestore();
        }
      });

      expect(result.errors).toBe(1);
      expect(storage.listKeys('attachments/')).toEqual([]);
    } finally {
      if (previousOwnerHeaderSetting === undefined) {
        delete process.env.INGEST_REQUIRE_OWNER_HEADER;
      } else {
        process.env.INGEST_REQUIRE_OWNER_HEADER = previousOwnerHeaderSetting;
      }
    }
  }, 30000);
});

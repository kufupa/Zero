import { recoverParseFailureQuarantine } from '../src/mail/ingest/recover-parse-failure';
import { rawMimeKey } from '../src/storage/s3';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import * as ingestStore from '../src/mail/ingest/store';
import type { DB } from '../src/db/client';
import { describe, expect, it, vi } from 'vitest';

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

function guestCreateAskEml(): Buffer {
  return Buffer.from(
    [
      'From: agent@example.com',
      'To: centurion@legacyhotels.co.za',
      'Subject: New Booking 12 Oct',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please book a standard room.',
    ].join('\r\n'),
    'utf-8',
  );
}

describe('recover-parse-failure', () => {
  it('persists parse_failure mail without outbound override or staff filter', async () => {
    const storage = withFakeS3();
    const raw = guestCreateAskEml();
    const row = {
      id: 'q-parse-failure-guest',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: 'uidl-parse-failure-guest',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-parse-failure-guest',
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

    const persistSpy = vi
      .spyOn(ingestStore, 'persistInboundMessage')
      .mockImplementation(async (_parsed, _raw, meta) => ({
        kind: 'stored',
        transportId: 'transport-centurion',
        messageId: meta.messageId,
        threadId: 'thread-parse-failure',
        rawMimeS3Key: row.rawMimeS3Key,
        attachmentCount: 0,
      }));

    try {
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result.stored).toBe(1);
      expect(result.skipped).toBe(0);
      expect(persistSpy).toHaveBeenCalledTimes(1);
      const options = persistSpy.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(options.promoteQuarantineId).toBe(row.id);
      expect(options.directionOverride).toBeUndefined();
      expect(options.transportOverride).toBeUndefined();
      expect(options.skipAiEnqueue).toBe(true);
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('dry-run does not persist', async () => {
    const storage = withFakeS3();
    const raw = guestCreateAskEml();
    const row = {
      id: 'q-parse-failure-dry',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: 'uidl-parse-failure-dry',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-parse-failure-dry',
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
    const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage');
    try {
      const result = await recoverParseFailureQuarantine({ db, storage, dryRun: true });
      expect(result.dryRunIds).toEqual([row.id]);
      expect(persistSpy).not.toHaveBeenCalled();
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('stamps a new quarantine reason when persist cannot store the recovered row', async () => {
    const storage = withFakeS3();
    const raw = guestCreateAskEml();
    const row = {
      id: 'q-parse-failure-reroute',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: 'uidl-parse-failure-reroute',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-parse-failure-reroute',
      }),
    };
    await storage.putObject({
      key: row.rawMimeS3Key,
      body: raw,
      contentType: 'message/rfc822',
    });
    const updates: Array<Record<string, unknown>> = [];
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
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            updates.push(values);
          },
        }),
      }),
    } as unknown as DB;
    const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage').mockResolvedValue({
      kind: 'quarantined',
      quarantineId: row.id,
      reason: 'missing_owner_header',
      rawMimeS3Key: row.rawMimeS3Key,
      candidateAttachmentCleanupFailureCount: 0,
    });
    try {
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result.quarantined).toBe(1);
      expect(updates).toEqual([{ reason: 'missing_owner_header' }]);
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('falls back to quarantine-archive when raw-mime has expired', async () => {
    const storage = withFakeS3();
    const raw = guestCreateAskEml();
    const row = {
      id: 'q-parse-failure-archive',
      ingestMailboxId: 'ingest-nava-legacy',
      pop3Uidl: 'uidl-parse-failure-archive',
      rawMimeS3Key: rawMimeKey({
        ingestMailboxId: 'ingest-nava-legacy',
        pop3Uidl: 'uidl-parse-failure-archive',
      }),
    };
    await storage.putObject({
      key: `quarantine-archive/${row.ingestMailboxId}/${row.pop3Uidl}.eml`,
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
    const persistSpy = vi
      .spyOn(ingestStore, 'persistInboundMessage')
      .mockImplementation(async (_parsed, _raw, meta) => ({
        kind: 'stored',
        transportId: 'transport-centurion',
        messageId: meta.messageId,
        threadId: 'thread-parse-failure-archive',
        rawMimeS3Key: row.rawMimeS3Key,
        attachmentCount: 0,
      }));
    try {
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result.stored).toBe(1);
      expect(persistSpy).toHaveBeenCalledTimes(1);
      const meta = persistSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(meta.rawMimeS3Key).toBeUndefined();
    } finally {
      persistSpy.mockRestore();
    }
  });
});

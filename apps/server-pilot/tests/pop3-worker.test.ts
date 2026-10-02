import {
  FakeS3Storage,
  quarantineArchiveKey,
  rawMimeKey,
  resetS3Storage,
  setS3Storage,
} from '../src/storage/s3';
import { FakePop3Client, type FakePop3Message } from '../src/mail/ingest/pop3-client';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { mailIngestCandidateAttachmentCleanup } from '../src/db/schema/mail';
import { ingestOnce, POISON_MAX_RETRIES } from '../src/mail/ingest/worker';
import { mailIngestQuarantine } from '../src/db/schema/mail';
import * as ingestStore from '../src/mail/ingest/store';
import { describe, expect, it, vi } from 'vitest';
import { readFixture } from './helpers/fixtures';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const reachable = await probeTestDb();

function fixtureMessages(): FakePop3Message[] {
  return [
    { uidl: 'uidl-A', raw: readFixture('centurion-stamped.eml') },
    { uidl: 'uidl-B', raw: readFixture('missing-owner.eml') },
  ];
}

function unknownOwnerMessage(includeAttachment = false): Buffer {
  const body = includeAttachment
    ? [
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="cleanup-boundary"',
        '',
        '--cleanup-boundary',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'quarantine cleanup retry',
        '--cleanup-boundary',
        'Content-Type: application/octet-stream; name="cleanup.bin"',
        'Content-Disposition: attachment; filename="cleanup.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        'Y2xlYW51cA==',
        '--cleanup-boundary--',
      ]
    : ['', 'quarantine without attachment'];

  return Buffer.from(
    [
      'X-Zero-Mailbox: unknown-owner@zero.test',
      'From: unknown-owner@zero.test',
      'To: unknown-owner@zero.test',
      ...body,
    ].join('\r\n'),
  );
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'pop3 worker ingestOnce (seeded, transaction-rollback)',
  () => {
    it('drives UIDL -> RETR -> S3 -> PG -> DELE -> QUIT and preserves order', async () => {
      const storage = new FakeS3Storage('worker-test-bucket');
      resetS3Storage();
      setS3Storage(storage);
      const fakePop3 = new FakePop3Client({ messages: fixtureMessages() });

      const result = await withSeededTestDb(async (db) => {
        return ingestOnce({
          pop3: fakePop3,
          db,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });
      });

      // Both messages were listed + processed.
      expect(result.listed).toBe(2);
      expect(result.processed).toBe(2);
      // Both DELEd after successful persist.
      expect(result.deled).toBe(2);
      expect(result.usedFakePop3).toBe(true);
      expect(result.cycleError).toBeUndefined();

      // POP3 call order: connect, uidl, retr, dele, retr, dele, quit.
      const ops = fakePop3.callLog.map((c) => c.op);
      const uidlIdx = ops.indexOf('uidl');
      const retrIdx = ops.indexOf('retr');
      const deleIdx = ops.indexOf('dele');
      const quitIdx = ops.indexOf('quit');
      expect(uidlIdx).toBeGreaterThanOrEqual(0);
      expect(retrIdx).toBeGreaterThan(uidlIdx);
      expect(deleIdx).toBeGreaterThan(retrIdx);
      expect(quitIdx).toBeGreaterThan(deleIdx);

      // DELE log order: uidl-A then uidl-B (in the order UIDL returned).
      expect(fakePop3.deleLog).toEqual(['uidl-A', 'uidl-B']);

      // Both raw-mime objects landed in S3.
      const rawKeys = storage.listKeys('raw-mime/');
      expect(rawKeys.length).toBe(2);
      // Each stored raw MIME matches the fixture bytes.
      for (const key of rawKeys) {
        const body = storage.get(key)!;
        expect(body.length).toBeGreaterThan(0);
      }

      // Per-message outcomes.
      expect(result.items.length).toBe(2);
      const itemA = result.items.find((i) => i.uidl === 'uidl-A');
      const itemB = result.items.find((i) => i.uidl === 'uidl-B');
      expect(itemA).toBeDefined();
      expect(itemA!.status).toBe('ok');
      expect(itemB).toBeDefined();
      expect(itemB!.status).toBe('ok');
      if (itemA!.status === 'ok') {
        expect(itemA!.result.kind).toBe('stored');
        if (itemA!.result.kind === 'stored') {
          expect(itemA!.result.transportId).toBe('transport-centurion');
        }
      }
      if (itemB!.status === 'ok') {
        expect(itemB!.result.kind).toBe('stored');
        if (itemB!.result.kind === 'stored') {
          expect(itemB!.result.transportId).toBe('transport-nava');
        }
      }
    }, 30000);

    it('holds POP3 and raw MIME until every quarantined candidate attachment cleans', async () => {
      const storage = new FakeS3Storage('worker-quarantine-cleanup');
      resetS3Storage();
      setS3Storage(storage);
      const uidl = `uidl-quarantine-cleanup-${randomUUID()}`;
      const ingestMailboxId = 'ingest-nava-legacy';
      const raw = unknownOwnerMessage(true);
      const fakePop3 = new FakePop3Client({ messages: [{ uidl, raw }] });
      const failureCounts = new Map([[uidl, POISON_MAX_RETRIES - 1]]);
      const originalDeleteObject = storage.deleteObject.bind(storage);
      let failFirstAttachmentCleanup = true;
      storage.deleteObject = async (key) => {
        if (failFirstAttachmentCleanup && key.startsWith('attachments/')) {
          failFirstAttachmentCleanup = false;
          throw new Error('injected quarantine attachment cleanup failure');
        }
        await originalDeleteObject(key);
      };

      const result = await withSeededTestDb(async (db) => {
        let first: Awaited<ReturnType<typeof ingestOnce>>;
        try {
          first = await ingestOnce({
            pop3: fakePop3,
            db,
            failureCounts,
            ingestMailboxId,
          });
        } finally {
          storage.deleteObject = originalDeleteObject;
        }
        const rawMimeS3Key = rawMimeKey({ ingestMailboxId, pop3Uidl: uidl });
        const firstCandidateAttachmentKey = storage.listKeys('attachments/')[0];
        if (!firstCandidateAttachmentKey) throw new Error('missing first candidate attachment');
        const firstRawMime = storage.get(rawMimeS3Key);
        const firstArchive = storage.get(quarantineArchiveKey({ ingestMailboxId, pop3Uidl: uidl }));
        await db
          .update(mailIngestCandidateAttachmentCleanup)
          .set({ nextAttemptAt: new Date() })
          .where(eq(mailIngestCandidateAttachmentCleanup.pop3Uidl, uidl));

        const second = await ingestOnce({
          pop3: fakePop3,
          db,
          failureCounts,
          ingestMailboxId,
        });
        const quarantines = await db
          .select({ id: mailIngestQuarantine.id })
          .from(mailIngestQuarantine)
          .where(eq(mailIngestQuarantine.pop3Uidl, uidl));

        return {
          first,
          firstCandidateAttachmentKey,
          firstArchive,
          firstRawMime,
          quarantines,
          rawMimeS3Key,
          second,
          secondArchive: storage.get(quarantineArchiveKey({ ingestMailboxId, pop3Uidl: uidl })),
        };
      });

      expect(result.first.deled).toBe(0);
      expect(result.first.items[0]).toMatchObject({
        status: 'deferred',
        uidl,
        result: {
          kind: 'quarantined',
          candidateAttachmentCleanupFailureCount: 1,
        },
      });
      expect(failureCounts.has(uidl)).toBe(false);
      expect(fakePop3.deleLog).toEqual([uidl]);
      expect(result.firstRawMime).toBeDefined();
      expect(result.firstArchive).toBeUndefined();
      expect(result.second.deled).toBe(1);
      expect(result.second.items[0]).toMatchObject({ status: 'ok', uidl });
      expect(result.quarantines).toHaveLength(1);
      expect(storage.get(result.firstCandidateAttachmentKey)).toBeUndefined();
      expect(result.secondArchive).toBeDefined();
    }, 30000);

    it('drains an existing no-attachment quarantine normally', async () => {
      const storage = new FakeS3Storage('worker-no-attachment-quarantine');
      resetS3Storage();
      setS3Storage(storage);
      const uidl = `uidl-no-attachment-${randomUUID()}`;
      const ingestMailboxId = 'ingest-nava-legacy';
      const rawMimeS3Key = rawMimeKey({ ingestMailboxId, pop3Uidl: uidl });
      const fakePop3 = new FakePop3Client({
        messages: [{ uidl, raw: unknownOwnerMessage() }],
      });

      const result = await withSeededTestDb(async (db) => {
        await db.insert(mailIngestQuarantine).values({
          id: randomUUID(),
          ingestMailboxId,
          pop3Uidl: uidl,
          rawMimeS3Key,
          reason: 'unknown_transport',
          ownerHeaderValue: 'unknown-owner@zero.test',
          parsedHeaders: { subject: 'legacy no attachment quarantine' },
        });
        const cycle = await ingestOnce({
          pop3: fakePop3,
          db,
          ingestMailboxId,
        });
        return {
          archive: storage.get(quarantineArchiveKey({ ingestMailboxId, pop3Uidl: uidl })),
          cycle,
          source: storage.get(rawMimeS3Key),
        };
      });

      expect(result.cycle.deled).toBe(1);
      expect(result.cycle.items[0]).toMatchObject({
        status: 'ok',
        uidl,
        result: { kind: 'quarantined', candidateAttachmentCleanupFailureCount: 0 },
      });
      expect(fakePop3.deleLog).toEqual([uidl]);
      expect(result.source).toBeDefined();
      expect(result.archive).toBeDefined();
    }, 30000);
  },
);

describe('ingestOnce returned-copy results', () => {
  it('DELEs a reconciled returned copy after persistence succeeds', async () => {
    const storage = new FakeS3Storage('worker-reconciliation-bucket');
    resetS3Storage();
    setS3Storage(storage);
    const fakePop3 = new FakePop3Client({
      messages: [{ uidl: 'uidl-reconciled', raw: readFixture('centurion-stamped.eml') }],
    });
    const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage').mockResolvedValue({
      kind: 'reconciled',
      transportId: 'transport-centurion',
      messageId: 'reconciled-message',
      rawMimeS3Key: 'raw-mime/test.eml',
      attachmentCount: 0,
    });

    try {
      const result = await ingestOnce({
        pop3: fakePop3,
        db: {} as import('../src/db/client').DB,
        ingestMailboxId: 'ingest-nava-legacy',
      });

      expect(result.deled).toBe(1);
      expect(fakePop3.deleLog).toEqual(['uidl-reconciled']);
      expect(result.items[0]).toMatchObject({
        status: 'ok',
        uidl: 'uidl-reconciled',
        result: { kind: 'reconciled' },
      });
      expect(persistSpy.mock.calls[0]?.[3]).toMatchObject({
        ingestSource: 'live-pop3',
      });
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('leaves a deferred returned copy in POP3 without advancing poison retries', async () => {
    const storage = new FakeS3Storage('worker-reconciliation-bucket');
    resetS3Storage();
    setS3Storage(storage);
    const uidl = 'uidl-deferred';
    const fakePop3 = new FakePop3Client({
      messages: [{ uidl, raw: readFixture('centurion-stamped.eml') }],
    });
    const failureCounts = new Map([[uidl, POISON_MAX_RETRIES - 1]]);
    const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage').mockResolvedValue({
      kind: 'deferred',
      transportId: 'transport-centurion',
      messageId: 'canonical-message',
      rawMimeS3Key: 'raw-mime/test.eml',
      candidateAttachmentCleanupFailureCount: 0,
    } as unknown as Awaited<ReturnType<typeof ingestStore.persistInboundMessage>>);

    try {
      const result = await ingestOnce({
        pop3: fakePop3,
        db: {} as import('../src/db/client').DB,
        failureCounts,
        ingestMailboxId: 'ingest-nava-legacy',
      });

      expect(result.deled).toBe(0);
      expect(fakePop3.deleLog).toEqual([]);
      expect(failureCounts.has(uidl)).toBe(false);
      expect(result.items[0]).toMatchObject({
        status: 'deferred',
        uidl,
        result: { kind: 'deferred' },
      });
    } finally {
      persistSpy.mockRestore();
    }
  });

  it('warns once while draining duplicate copies with cleanup failures', async () => {
    const storage = new FakeS3Storage('worker-reconciliation-bucket');
    resetS3Storage();
    setS3Storage(storage);
    const fakePop3 = new FakePop3Client({
      messages: [{ uidl: 'uidl-duplicate', raw: readFixture('centurion-stamped.eml') }],
    });
    const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage').mockResolvedValue({
      kind: 'duplicate',
      transportId: 'transport-centurion',
      messageId: 'canonical-message',
      rawMimeS3Key: 'raw-mime/test.eml',
      candidateAttachmentCleanupFailureCount: 1,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const result = await ingestOnce({
        pop3: fakePop3,
        db: {} as import('../src/db/client').DB,
        ingestMailboxId: 'ingest-nava-legacy',
      });

      expect(result.deled).toBe(1);
      expect(result.duplicateAttachmentCleanupFailureCount).toBe(1);
      expect(fakePop3.deleLog).toEqual(['uidl-duplicate']);
      expect(warnSpy).toHaveBeenCalledWith(
        'worker: duplicate candidate attachment cleanup failures=1',
      );
    } finally {
      warnSpy.mockRestore();
      persistSpy.mockRestore();
    }
  });
});

it('rotates a bounded UIDL window past deferred items across worker cycles', async () => {
  const storage = new FakeS3Storage('worker-uidl-rotation');
  resetS3Storage();
  setS3Storage(storage);
  const fakePop3 = new FakePop3Client({
    messages: [
      { uidl: 'uidl-rotate-A', raw: readFixture('centurion-stamped.eml') },
      { uidl: 'uidl-rotate-B', raw: readFixture('centurion-stamped.eml') },
      { uidl: 'uidl-rotate-C', raw: readFixture('centurion-stamped.eml') },
      { uidl: 'uidl-rotate-D', raw: readFixture('centurion-stamped.eml') },
    ],
  });
  const uidlCursor = { lastProcessedUidl: undefined as string | undefined };
  const persistSpy = vi.spyOn(ingestStore, 'persistInboundMessage').mockResolvedValue({
    kind: 'deferred',
    transportId: 'transport-centurion',
    messageId: 'canonical-message',
    rawMimeS3Key: 'raw-mime/test.eml',
    candidateAttachmentCleanupFailureCount: 0,
  } as Awaited<ReturnType<typeof ingestStore.persistInboundMessage>>);

  try {
    const opts = {
      pop3: fakePop3,
      db: {} as import('../src/db/client').DB,
      ingestMailboxId: 'ingest-nava-legacy',
      maxMessages: 2,
      uidlCursor,
    } as unknown as Parameters<typeof ingestOnce>[0];
    await ingestOnce(opts);
    await ingestOnce(opts);

    expect(fakePop3.callLog.filter((call) => call.op === 'retr').map((call) => call.uidl)).toEqual([
      'uidl-rotate-A',
      'uidl-rotate-B',
      'uidl-rotate-C',
      'uidl-rotate-D',
    ]);
  } finally {
    persistSpy.mockRestore();
  }
});

// Unit tests (no DB) for the fake pop3 path with no real env.
describe('ingestOnce without DB-backed persist (fake pop3 only)', () => {
  it('returns a cycleError when real mode has no pop3 configured', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      MAIL_TRANSPORT_MODE: 'real',
      NODE_ENV: 'test',
      PORT: '8788',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      BETTER_AUTH_URL: 'http://localhost',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'test-bucket',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '50',
    });
    delete process.env.POP3_HOST;
    delete process.env.POP3_PORT;
    delete process.env.POP3_USER;
    delete process.env.POP3_PASSWORD;
    delete process.env.POP3_SECRET_ARN;
    try {
      const result = await ingestOnce({});
      expect(result.listed).toBe(0);
      expect(result.processed).toBe(0);
      expect(result.cycleError).toContain('no real pop3 client');
    } finally {
      process.env = saved;
    }
  });
});

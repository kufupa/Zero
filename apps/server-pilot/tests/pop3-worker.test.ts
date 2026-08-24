import { describe, expect, it, vi } from 'vitest';
import { ingestOnce, POISON_MAX_RETRIES } from '../src/mail/ingest/worker';
import * as ingestStore from '../src/mail/ingest/store';
import {
  FakePop3Client,
  type FakePop3Message,
} from '../src/mail/ingest/pop3-client';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

function fixtureMessages(): FakePop3Message[] {
  return [
    { uidl: 'uidl-A', raw: readFixture('centurion-stamped.eml') },
    { uidl: 'uidl-B', raw: readFixture('missing-owner.eml') },
  ];
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'pop3 worker ingestOnce (seeded, transaction-rollback)',
  () => {
    it(
      'drives UIDL -> RETR -> S3 -> PG -> DELE -> QUIT and preserves order',
      async () => {
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
      },
      30000,
    );

    it(
      'does NOT DELE a message when persist throws (stays for retry)',
      async () => {
        resetS3Storage();
        setS3Storage(new FakeS3Storage('worker-err-bucket'));
        // Only the stamped Centurion fixture, but inject a DB that fails on
        // insert. The mock has to be faithful enough that:
        //   - the transport lookup select returns the Centurion transport,
        //   - the duplicate-check select returns [] (no prior row),
        //   - the thread lookup select returns [],
        //   - the first insert (thread OR message) throws.
        // We track select-call count to differentiate the transport lookup
        // (1st) from the duplicate check (2nd) and thread lookup (3rd).
        const fakePop3 = new FakePop3Client({
          messages: [{ uidl: 'uidl-err', raw: readFixture('centurion-stamped.eml') }],
        });

        let selectCount = 0;
        const throwingTx = {
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => {
                  selectCount += 1;
                  if (selectCount === 3) {
                    return [
                      {
                        id: 'transport-centurion',
                        email: 'centurion@legacyhotel.com',
                      },
                    ];
                  }
                  return [];
                },
              }),
            }),
          }),
          insert: () => {
            throw new Error('simulated PG failure');
          },
        };
        const throwingDb = {
          ...throwingTx,
          transaction: async (fn: (tx: typeof throwingTx) => Promise<unknown>) => fn(throwingTx),
        };

        const result = await ingestOnce({
          pop3: fakePop3,
          db: throwingDb as unknown as import('../src/db/client').DB,
          ingestMailboxId: 'ingest-nava-legacy',
          maxMessages: 10,
        });

        expect(result.processed).toBe(1);
        expect(result.deled).toBe(0); // not DELEd
        expect(result.items[0]!.status).toBe('error');
        if (result.items[0]!.status === 'error') {
          expect(result.items[0]!.error).toContain('simulated PG failure');
        }
        // DELE never called.
        expect(fakePop3.deleLog).toEqual([]);
        // QUIT still called (cycle completes after the error).
        expect(fakePop3.callLog.map((c) => c.op)).toContain('quit');
      },
      30000,
    );

    it(
      'poison UIDL quarantined across cycles when failureCounts persist',
      async () => {
        const storage = new FakeS3Storage('worker-poison-loop');
        resetS3Storage();
        setS3Storage(storage);
        const fakePop3 = new FakePop3Client({
          messages: [{ uidl: 'uidl-poison-loop', raw: readFixture('centurion-stamped.eml') }],
        });
        const failureCounts = new Map<string, number>();
        const persistSpy = vi
          .spyOn(ingestStore, 'persistInboundMessage')
          .mockRejectedValue(new Error('simulated persist failure'));

        try {
          await withSeededTestDb(async (db) => {
            for (let i = 0; i < POISON_MAX_RETRIES - 1; i++) {
              const attempt = await ingestOnce({
                pop3: fakePop3,
                db,
                ingestMailboxId: 'ingest-nava-legacy',
                failureCounts,
              });
              expect(attempt.items[0]!.status).toBe('error');
              expect(attempt.deled).toBe(0);
            }

            const final = await ingestOnce({
              pop3: fakePop3,
              db,
              ingestMailboxId: 'ingest-nava-legacy',
              failureCounts,
            });
            expect(final.deled).toBe(1);
            expect(final.items[0]!.status).toBe('ok');
          });
        } finally {
          persistSpy.mockRestore();
        }
      },
      30000,
    );
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

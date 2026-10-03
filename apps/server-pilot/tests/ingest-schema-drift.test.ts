import { FakeS3Storage, rawMimeKey, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { assertMigrationCompatibility } from '../src/db/migration-compatibility.js';
import { ingestOnce, POISON_MAX_RETRIES } from '../src/mail/ingest/worker.js';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { randomUUID } from 'node:crypto';

function validMail(): Buffer {
  return Buffer.from(
    [
      'From: Test Guest <guest@example.com>',
      'To: centurion@legacyhotels.co.za',
      'X-Zero-Mailbox: centurion@legacyhotels.co.za',
      'Message-ID: <schema-drift-test@example.com>',
      'Date: Sat, 26 Sep 2026 10:00:00 +0200',
      'Subject: Synthetic booking question',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="incident"',
      '',
      '--incident',
      'Content-Type: text/plain',
      '',
      'Synthetic booking question.',
      '--incident',
      'Content-Type: application/pdf; name="booking.pdf"',
      'Content-Disposition: attachment; filename="booking.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'c3ludGhldGljLXBkZg==',
      '--incident--',
    ].join('\r\n'),
  );
}

afterEach(() => resetS3Storage());

describe('real PostgreSQL ingest infrastructure failures', () => {
  it.each([
    {
      name: 'missing read_request column',
      code: '42703',
      breakSql: 'ALTER TABLE ai_workflow_run RENAME COLUMN read_request TO incident_read_request',
      repairSql: 'ALTER TABLE ai_workflow_run RENAME COLUMN incident_read_request TO read_request',
    },
    {
      name: 'missing AI run table',
      code: '42P01',
      breakSql: 'ALTER TABLE ai_workflow_run RENAME TO incident_ai_workflow_run',
      repairSql: 'ALTER TABLE incident_ai_workflow_run RENAME TO ai_workflow_run',
    },
  ])(
    'retains valid mail across three cycles on $name, then stores after repair',
    async ({ code, breakSql, repairSql }) => {
      await withIngestionDb(async ({ db, sql }) => {
        const uidl = 'uidl-schema-drift';
        const ingestMailboxId = 'ingest-nava-legacy';
        const storage = new FakeS3Storage('incident-test');
        setS3Storage(storage);
        const pop3 = new FakePop3Client({ messages: [{ uidl, raw: validMail() }] });
        const failureCounts = new Map<string, number>();
        await sql.unsafe(breakSql);
        const cycles = [];
        for (let i = 0; i < POISON_MAX_RETRIES; i++) {
          cycles.push(await ingestOnce({ db, pop3, ingestMailboxId, failureCounts }));
        }
        expect(cycles.map((cycle) => cycle.deled)).toEqual([0, 0, 0]);
        expect(cycles.map((cycle) => cycle.items[0])).toEqual(
          Array.from({ length: 3 }, () => ({
            uidl,
            status: 'error',
            error: `database infrastructure failure (${code}); POP3 message retained`,
          })),
        );
        expect(pop3.remainingUidls()).toEqual([uidl]);
        expect(pop3.deleLog).toEqual([]);
        expect(failureCounts.size).toBe(0);
        expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
        expect(await sql`SELECT id FROM message`).toHaveLength(0);
        expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
        expect(await sql`SELECT * FROM mail_ingest_candidate_attachment_cleanup`).toHaveLength(0);
        expect(storage.listKeys('attachments/')).toHaveLength(0);
        expect(storage.get(rawMimeKey({ ingestMailboxId, pop3Uidl: uidl }))).toEqual(validMail());

        await sql.unsafe(repairSql);
        const repaired = await ingestOnce({ db, pop3, ingestMailboxId, failureCounts });
        expect(repaired.deled).toBe(1);
        expect(repaired.items[0]).toMatchObject({ status: 'ok', result: { kind: 'stored' } });
        expect(pop3.remainingUidls()).toEqual([]);
        expect(await sql`SELECT id FROM message`).toHaveLength(1);
        expect(await sql`SELECT id FROM attachment`).toHaveLength(1);
        expect(
          await sql`SELECT id FROM ai_workflow_run WHERE run_kind = 'inbound_triage'`,
        ).toHaveLength(1);
        expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
        // Transport fake replays its initial message on reconnect; DB identity stays idempotent.
        expect(
          (await ingestOnce({ db, pop3, ingestMailboxId, failureCounts })).items[0],
        ).toMatchObject({ result: { kind: 'duplicate' } });
        expect(await sql`SELECT id FROM message`).toHaveLength(1);
        expect(await sql`SELECT id FROM attachment`).toHaveLength(1);
        expect(
          await sql`SELECT id FROM ai_workflow_run WHERE run_kind = 'inbound_triage'`,
        ).toHaveLength(1);
      });
    },
    30000,
  );

  it('retains mail on real database permission failure without spending poison retries', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const role = `ingestion_${randomUUID().replaceAll('-', '')}`;
      await sql.unsafe(`CREATE ROLE "${role}"`);
      try {
        await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${role}"`);
        await sql.unsafe(`REVOKE INSERT ON ai_workflow_run FROM "${role}"`);
        await sql.unsafe(`SET ROLE "${role}"`);
        const uidl = 'uidl-permission';
        const pop3 = new FakePop3Client({ messages: [{ uidl, raw: validMail() }] });
        setS3Storage(new FakeS3Storage('incident-permission'));
        const failureCounts = new Map<string, number>();
        const cycles = [];
        for (let i = 0; i < POISON_MAX_RETRIES; i++)
          cycles.push(await ingestOnce({ db, pop3, failureCounts }));
        expect(cycles.map((cycle) => cycle.deled)).toEqual([0, 0, 0]);
        expect(cycles[0]?.items[0]).toMatchObject({
          status: 'error',
          error: 'database infrastructure failure (42501); POP3 message retained',
        });
        expect(failureCounts.size).toBe(0);
        expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
        expect(await sql`SELECT id FROM message`).toHaveLength(0);
        expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
      } finally {
        await sql`RESET ROLE`;
        await sql.unsafe(`DROP OWNED BY "${role}"`);
        await sql.unsafe(`DROP ROLE "${role}"`);
      }
    });
  }, 30000);

  it.each([
    {
      name: 'check constraint',
      code: '23514',
      breakSql:
        'ALTER TABLE ai_workflow_run ADD CONSTRAINT incident_reject_write CHECK (false) NOT VALID',
      repairSql: 'ALTER TABLE ai_workflow_run DROP CONSTRAINT incident_reject_write',
    },
    {
      name: 'unexpected trigger exception',
      code: 'P0001',
      breakSql: `CREATE FUNCTION incident_reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic processing failure'; END $$;
        CREATE TRIGGER incident_reject_write BEFORE INSERT ON ai_workflow_run FOR EACH ROW EXECUTE FUNCTION incident_reject_write()`,
      repairSql:
        'DROP TRIGGER incident_reject_write ON ai_workflow_run; DROP FUNCTION incident_reject_write()',
    },
  ])(
    'retains valid mail on $name even when the compatibility gate passes',
    async ({ breakSql, repairSql, code }) => {
      await withIngestionDb(async ({ db, sql }) => {
        await sql.unsafe(breakSql);
        await assertMigrationCompatibility(sql);
        const uidl = 'uidl-persistence-failure';
        const storage = new FakeS3Storage('incident-persistence');
        setS3Storage(storage);
        const pop3 = new FakePop3Client({ messages: [{ uidl, raw: validMail() }] });
        const failureCounts = new Map<string, number>();
        const warning = vi.spyOn(console, 'warn');
        for (let i = 0; i < POISON_MAX_RETRIES; i++) {
          const cycle = await ingestOnce({ db, pop3, failureCounts });
          expect(cycle.deled).toBe(0);
          expect(cycle.items[0]).toMatchObject({
            error: `ingest processing failure (persist/${code}); POP3 message retained`,
          });
        }
        expect(warning).toHaveBeenCalledWith(
          `worker: ingest processing failure (persist/${code}); POP3 message retained`,
        );
        warning.mockRestore();
        expect(pop3.deleLog).toEqual([]);
        expect(failureCounts.size).toBe(0);
        expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
        expect(await sql`SELECT id FROM message`).toHaveLength(0);
        expect(
          storage.get(rawMimeKey({ ingestMailboxId: 'ingest-nava-legacy', pop3Uidl: uidl })),
        ).toEqual(validMail());
        await sql.unsafe(repairSql);
        expect((await ingestOnce({ db, pop3, failureCounts })).deled).toBe(1);
        expect(await sql`SELECT id FROM message`).toHaveLength(1);
        expect(await sql`SELECT id FROM attachment`).toHaveLength(1);
        expect(
          await sql`SELECT id FROM ai_workflow_run WHERE run_kind = 'inbound_triage'`,
        ).toHaveLength(1);
      });
    },
    30000,
  );

  it.each(['raw-mime/', 'attachments/'])(
    'retains valid mail when %s uploads fail repeatedly',
    async (prefix) => {
      await withIngestionDb(async ({ db, sql }) => {
        let failUploads = true;
        class FailingStorage extends FakeS3Storage {
          override async putObject(input: Parameters<FakeS3Storage['putObject']>[0]) {
            if (failUploads && input.key.startsWith(prefix))
              throw Object.assign(new Error('synthetic private upload details'), {
                name: 'AccessDenied',
              });
            return super.putObject(input);
          }
        }
        const storage = new FailingStorage('incident-upload');
        setS3Storage(storage);
        const uidl = 'uidl-upload-failure';
        const pop3 = new FakePop3Client({ messages: [{ uidl, raw: validMail() }] });
        const failureCounts = new Map<string, number>();
        for (let i = 0; i < POISON_MAX_RETRIES; i++) {
          const cycle = await ingestOnce({ db, pop3, failureCounts });
          expect(cycle.deled).toBe(0);
          expect(cycle.items[0]).toMatchObject({
            error: `ingest processing failure (${prefix === 'raw-mime/' ? 'raw_upload' : 'parse_and_upload'}/AccessDenied); POP3 message retained`,
          });
        }
        expect(pop3.deleLog).toEqual([]);
        expect(failureCounts.size).toBe(0);
        expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
        expect(await sql`SELECT id FROM message`).toHaveLength(0);
        failUploads = false;
        expect((await ingestOnce({ db, pop3, failureCounts })).deled).toBe(1);
        expect(await sql`SELECT id FROM message`).toHaveLength(1);
        expect(await sql`SELECT id FROM attachment`).toHaveLength(1);
      });
    },
    30000,
  );

  it('keeps malformed MIME parser failures bounded without mocking persistence', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      // Excessive MIME header lines exceed the parser's own header bound.
      const raw = Buffer.from(
        'Content-Type: text/plain\r\n' + 'X-Test: x\r\n'.repeat(200000) + '\r\nx',
      );
      const uidl = 'uidl-malformed-headers';
      const pop3 = new FakePop3Client({ messages: [{ uidl, raw }] });
      setS3Storage(new FakeS3Storage('incident-malformed'));
      const failureCounts = new Map<string, number>();
      for (let i = 0; i < POISON_MAX_RETRIES - 1; i++) {
        expect((await ingestOnce({ db, pop3, failureCounts })).deled).toBe(0);
        expect(failureCounts.get(uidl)).toBe(i + 1);
      }
      expect((await ingestOnce({ db, pop3, failureCounts })).deled).toBe(1);
      expect(await sql`SELECT reason FROM mail_ingest_quarantine`).toEqual([
        { reason: 'parse_failure' },
      ]);
      expect(await sql`SELECT id FROM message`).toHaveLength(0);
      expect(failureCounts.size).toBe(0);
    });
  }, 30000);

  it('retains mail when PostgreSQL terminates the actual persistence session', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      await sql`CREATE FUNCTION ingestion_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$`;
      await sql`CREATE TRIGGER ingestion_disconnect BEFORE INSERT ON ai_workflow_run FOR EACH ROW EXECUTE FUNCTION ingestion_disconnect()`;
      const uidl = 'uidl-disconnect';
      const pop3 = new FakePop3Client({ messages: [{ uidl, raw: validMail() }] });
      setS3Storage(new FakeS3Storage('incident-disconnect'));
      const failureCounts = new Map<string, number>();
      const cycles = [];
      for (let i = 0; i < POISON_MAX_RETRIES; i++)
        cycles.push(await ingestOnce({ db, pop3, failureCounts }));
      expect(cycles.map((cycle) => cycle.deled)).toEqual([0, 0, 0]);
      expect(cycles[0]?.items[0]).toMatchObject({
        status: 'error',
        error: expect.stringMatching(
          /^database infrastructure failure \((?:CONNECTION_CLOSED|57P01)\); POP3 message retained$/,
        ),
      });
      expect(failureCounts.size).toBe(0);
      expect(await sql`SELECT id FROM message`).toHaveLength(0);
      expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
      expect(pop3.remainingUidls()).toEqual([uidl]);
      await sql`DROP TRIGGER ingestion_disconnect ON ai_workflow_run`;
      expect((await ingestOnce({ db, pop3, failureCounts })).deled).toBe(1);
      expect(await sql`SELECT id FROM message`).toHaveLength(1);
    });
  }, 30000);
});

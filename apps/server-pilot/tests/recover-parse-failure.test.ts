import {
  FakeS3Storage,
  rawMimeKey,
  quarantineArchiveKey,
  resetS3Storage,
} from '../src/storage/s3.js';
import { recoverParseFailureQuarantine } from '../src/mail/ingest/recover-parse-failure.js';
import { candidateMessageIdForPop3Uidl } from '../src/mail/ingest/parse-message.js';
import { mailIngestQuarantine } from '../src/db/schema/mail.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const ingestMailboxId = 'ingest-nava-legacy';
function mail(outbound = false): Buffer {
  return Buffer.from(
    [
      `From: ${outbound ? 'centurion@legacyhotels.co.za' : 'guest@example.com'}`,
      `To: ${outbound ? 'guest@example.com' : 'centurion@legacyhotels.co.za'}`,
      'X-Zero-Mailbox: centurion@legacyhotels.co.za',
      `Message-ID: <${outbound ? 'reply' : 'guest'}@recovery.test>`,
      ...(outbound
        ? ['In-Reply-To: <guest@recovery.test>', 'References: <guest@recovery.test>']
        : []),
      `Date: ${outbound ? 'Sun, 27 Sep 2026 13:00:00 +0200' : 'Sat, 26 Sep 2026 10:00:00 +0200'}`,
      'Subject: Synthetic recovery booking',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="recover"',
      '',
      '--recover',
      'Content-Type: text/plain',
      '',
      'Synthetic historical booking.',
      '--recover',
      'Content-Type: application/pdf; name="booking.pdf"',
      'Content-Disposition: attachment; filename="booking.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'c3ludGhldGljLXBkZg==',
      '--recover--',
    ].join('\r\n'),
  );
}
function quarantine(pop3Uidl: string, reason = 'parse_failure') {
  return {
    id: randomUUID(),
    ingestMailboxId,
    pop3Uidl,
    rawMimeS3Key: rawMimeKey({ ingestMailboxId, pop3Uidl }),
    reason,
  };
}

afterEach(() => resetS3Storage());

describe('parse-failure recovery through real PostgreSQL persistence', () => {
  it('restores inbound/outbound dates, thread references and attachment objects without AI; retries stay idempotent', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const storage = new FakeS3Storage('recovery-test');
      const inbound = quarantine('recover-inbound');
      const outbound = quarantine('recover-outbound');
      await db.insert(mailIngestQuarantine).values([
        { ...inbound, createdAt: new Date('2026-09-26T08:00:00Z') },
        { ...outbound, createdAt: new Date('2026-09-27T11:00:00Z') },
      ]);
      await storage.putObject({
        key: inbound.rawMimeS3Key,
        body: mail(),
        contentType: 'message/rfc822',
      });
      // Original raw-mime object expired; archive is authoritative fallback.
      await storage.putObject({
        key: quarantineArchiveKey(outbound),
        body: mail(true),
        contentType: 'message/rfc822',
      });
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result).toMatchObject({
        scanned: 2,
        stored: 2,
        duplicate: 0,
        errors: 0,
        quarantined: 0,
      });
      const messages =
        await sql`SELECT id, direction, received_at, sent_at, message_id_header, in_reply_to, "references", thread_id, raw_mime_s3_key FROM message ORDER BY received_at`;
      expect(messages).toHaveLength(2);
      expect(messages.map((row) => row.direction)).toEqual(['inbound', 'outbound']);
      expect(messages.map((row) => new Date(row.received_at).toISOString())).toEqual([
        '2026-09-26T08:00:00.000Z',
        '2026-09-27T11:00:00.000Z',
      ]);
      expect(messages.map((row) => new Date(row.sent_at).toISOString())).toEqual([
        '2026-09-26T08:00:00.000Z',
        '2026-09-27T11:00:00.000Z',
      ]);
      expect(messages[1]?.in_reply_to).toBe('guest@recovery.test');
      expect(messages[1]?.references).toEqual(['guest@recovery.test']);
      expect(messages[1]?.thread_id).toBe(messages[0]?.thread_id);
      expect(messages.map((row) => row.id)).toEqual([
        candidateMessageIdForPop3Uidl(ingestMailboxId, inbound.pop3Uidl),
        candidateMessageIdForPop3Uidl(ingestMailboxId, outbound.pop3Uidl),
      ]);
      const attachments = await sql`SELECT message_id, s3_key, filename FROM attachment`;
      expect(attachments).toHaveLength(2);
      for (const attachment of attachments) {
        expect(attachment.s3_key).toContain(`attachments/${attachment.message_id}/`);
        expect(attachment.filename).toBe('booking.pdf');
        expect(storage.get(attachment.s3_key)).toEqual(Buffer.from('synthetic-pdf'));
      }
      expect(storage.get(outbound.rawMimeS3Key)).toEqual(mail(true));
      expect(await sql`SELECT id FROM ai_workflow_run`).toHaveLength(0);
      expect(await sql`SELECT id FROM mail_ingest_quarantine`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_candidate_attachment_cleanup`).toHaveLength(0);
      const attachmentKeys = storage.listKeys('attachments/');
      // Stale quarantine retries must clear either direction without reparsing/enqueue.
      await db.insert(mailIngestQuarantine).values([inbound, outbound]);
      expect(await recoverParseFailureQuarantine({ db, storage })).toMatchObject({
        scanned: 2,
        stored: 0,
        duplicate: 2,
        errors: 0,
      });
      expect(await sql`SELECT id FROM message`).toHaveLength(2);
      expect(await sql`SELECT id FROM attachment`).toHaveLength(2);
      expect(await sql`SELECT id FROM ai_workflow_run`).toHaveLength(0);
      expect(storage.listKeys('attachments/')).toEqual(attachmentKeys);
      expect(await recoverParseFailureQuarantine({ db, storage })).toMatchObject({ scanned: 0 });
    });
  }, 30000);

  it('dry-run preserves quarantine, raw MIME and an empty message/AI ledger', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const storage = new FakeS3Storage('recovery-dry');
      const row = quarantine('recover-dry');
      await db.insert(mailIngestQuarantine).values(row);
      await storage.putObject({
        key: row.rawMimeS3Key,
        body: mail(),
        contentType: 'message/rfc822',
      });
      expect(await recoverParseFailureQuarantine({ db, storage, dryRun: true })).toMatchObject({
        dryRunIds: [row.id],
        stored: 0,
      });
      expect(await sql`SELECT id FROM mail_ingest_quarantine`).toEqual([{ id: row.id }]);
      expect(await sql`SELECT id FROM message`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai_workflow_run`).toHaveLength(0);
      expect(storage.listKeys('attachments/')).toHaveLength(0);
    });
  }, 30000);

  it('reports failed DB persistence safely, cleans candidate attachments and releases claim for repaired retry', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const storage = new FakeS3Storage('recovery-db-failure');
      const row = quarantine('recover-db-failure');
      await db.insert(mailIngestQuarantine).values(row);
      await storage.putObject({
        key: row.rawMimeS3Key,
        body: mail(),
        contentType: 'message/rfc822',
      });
      await sql`ALTER TABLE message RENAME COLUMN subject TO incident_subject`;
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result).toMatchObject({
        stored: 0,
        errors: 1,
        errorIds: [row.id],
        outcomes: [{ id: row.id, kind: 'error', reason: 'recovery_failed' }],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /guest@example|Synthetic historical|INSERT INTO|incident_subject/,
      );
      expect(await sql`SELECT id FROM mail_ingest_quarantine`).toEqual([{ id: row.id }]);
      expect(await sql`SELECT id FROM message`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_candidate_attachment_cleanup`).toHaveLength(0);
      expect(storage.listKeys('attachments/')).toHaveLength(0);
      await sql`ALTER TABLE message RENAME COLUMN incident_subject TO subject`;
      expect(await recoverParseFailureQuarantine({ db, storage })).toMatchObject({
        stored: 1,
        errors: 0,
      });
      expect(await sql`SELECT id FROM attachment`).toHaveLength(1);
      expect(await sql`SELECT id FROM ai_workflow_run`).toHaveLength(0);
    });
  }, 30000);

  it('keeps missing objects visible and reclassifies genuinely unroutable recovered mail', async () => {
    await withIngestionDb(async ({ db, sql }) => {
      const storage = new FakeS3Storage('recovery-errors');
      const missing = quarantine('recover-missing');
      const unroutable = quarantine('recover-unroutable');
      await db.insert(mailIngestQuarantine).values([missing, unroutable]);
      const raw = Buffer.from(
        'From: unknown@invalid.test\r\nTo: other@invalid.test\r\nX-Zero-Mailbox: other@invalid.test\r\n\r\nSynthetic unroutable mail.',
      );
      await storage.putObject({
        key: unroutable.rawMimeS3Key,
        body: raw,
        contentType: 'message/rfc822',
      });
      const result = await recoverParseFailureQuarantine({ db, storage });
      expect(result).toMatchObject({
        scanned: 2,
        errors: 1,
        errorIds: [missing.id],
        quarantined: 1,
      });
      expect(result.outcomes).toHaveLength(2);
      expect(result.outcomes).toEqual(
        expect.arrayContaining([
          { id: missing.id, kind: 'error', reason: 'raw_mime_missing' },
          { id: unroutable.id, kind: 'quarantined', reason: 'unknown_transport' },
        ]),
      );
      expect(await sql`SELECT reason FROM mail_ingest_quarantine WHERE id = ${missing.id}`).toEqual(
        [{ reason: 'parse_failure' }],
      );
      expect(
        await sql`SELECT reason FROM mail_ingest_quarantine WHERE id = ${unroutable.id}`,
      ).toEqual([{ reason: 'unknown_transport' }]);
      expect(await sql`SELECT id FROM message`).toHaveLength(0);
      expect(await sql`SELECT id FROM ai_workflow_run`).toHaveLength(0);
      expect(await sql`SELECT * FROM mail_ingest_uidl_claim`).toHaveLength(0);
    });
  }, 30000);
});

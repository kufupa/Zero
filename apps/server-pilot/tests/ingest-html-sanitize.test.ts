import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { message } from '../src/db/schema/mail.js';
import { generateMessageId, parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';

const reachable = await probeTestDb();

const MALICIOUS_HTML =
  '<img src=x onerror=alert(1)><script>alert(1)</script><p>booking</p>';

function centurionHtmlEml(html: string): Buffer {
  return Buffer.from(
    [
      'From: guest@example.com',
      'To: centurion@legacyhotel.com',
      'Subject: HTML persist sanitize',
      'X-Zero-Mailbox: centurion@legacyhotel.com',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].join('\r\n'),
    'utf-8',
  );
}

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'persistInboundMessage sanitizes htmlBody at storage',
  () => {
    it('stores sanitized htmlBody without script or onerror', async () => {
      const storage = withFakeS3();
      const raw = centurionHtmlEml(MALICIOUS_HTML);

      const { result, row } = await withSeededTestDb(async (db) => {
        const messageId = generateMessageId();
        const parsed = await parseRawMessage(raw, { messageId, storage });
        const r = await persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `uidl-html-${randomUUID()}`,
            messageId,
          },
          { db, storage },
        );
        if (r.kind !== 'stored') return { result: r, row: undefined };
        const rows = await db
          .select()
          .from(message)
          .where(eq(message.id, r.messageId));
        return { result: r, row: rows[0] };
      }, 30000);

      expect(result.kind).toBe('stored');
      expect(row?.htmlBody).toBeDefined();
      expect(row!.htmlBody!).not.toContain('<script');
      expect(row!.htmlBody!).not.toMatch(/onerror/i);
      expect(row!.htmlBody!).toContain('booking');
    });
  },
);

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  mailCatchupUpload,
  mailCatchupUploadStatusEnum,
} from '../src/db/schema/index.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';
import { user } from '../src/db/schema/auth.js';
import { eq } from 'drizzle-orm';

describe('mail_catchup_upload schema & migration contract', () => {
  it('exports mailCatchupUpload table with bigint sizeBytes and s3UploadId', () => {
    expect(mailCatchupUpload).toBeDefined();
    expect(mailCatchupUpload.id).toBeDefined();
    expect(mailCatchupUpload.userId).toBeDefined();
    expect(mailCatchupUpload.originalFilename).toBeDefined();
    expect(mailCatchupUpload.contentType).toBeDefined();
    expect(mailCatchupUpload.sizeBytes).toBeDefined();
    expect(mailCatchupUpload.s3Key).toBeDefined();
    expect(mailCatchupUpload.s3UploadId).toBeDefined();
    expect(mailCatchupUpload.status).toBeDefined();
    expect(mailCatchupUpload.createdAt).toBeDefined();
    expect(mailCatchupUpload.updatedAt).toBeDefined();
    expect(mailCatchupUpload.completedAt).toBeDefined();
    expect(mailCatchupUploadStatusEnum.enumValues).toEqual(['pending', 'stored', 'aborted']);
  });

  it('migration 0022_mail_catchup_upload.sql contains bigint, MPU column, and index', async () => {
    const sql = await readFile(
      new URL('../drizzle/0022_mail_catchup_upload.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "mail_catchup_upload"');
    expect(sql).toContain('"size_bytes" bigint NOT NULL');
    expect(sql).toContain('"s3_upload_id" text');
    expect(sql).toContain('mail_catchup_upload_user_created_idx');
    expect(sql).toContain('mail_catchup_upload_s3_key_unique');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE)('mail_catchup_upload persistence (disposable DB)', () => {
  it('inserts and selects 50 GiB sizeBytes without 32-bit overflow', async () => {
    await withTestDb(async (db) => {
      const testUserId = `user-${Date.now()}`;
      await db.insert(user).values({
        id: testUserId,
        name: 'Catchup Test User',
        email: `catchup-${Date.now()}@example.com`,
        emailVerified: true,
      });

      const fiftyGiB = 53687091200; // 50 * 1024 * 1024 * 1024
      const uploadId = `upload-${Date.now()}`;
      await db.insert(mailCatchupUpload).values({
        id: uploadId,
        userId: testUserId,
        originalFilename: 'sent-backup.pst',
        contentType: 'application/vnd.ms-outlook',
        sizeBytes: fiftyGiB,
        s3Key: `catchup-uploads/${testUserId}/${uploadId}/sent-backup.pst`,
        s3UploadId: 'test-mpu-id-123',
        status: 'pending',
      });

      const [row] = await db
        .select()
        .from(mailCatchupUpload)
        .where(eq(mailCatchupUpload.id, uploadId));

      expect(row).toBeDefined();
      expect(row.sizeBytes).toBe(fiftyGiB);
      expect(row.s3UploadId).toBe('test-mpu-id-123');
      expect(row.status).toBe('pending');
    });
  });
});

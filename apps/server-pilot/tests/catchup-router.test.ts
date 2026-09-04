import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { FakeS3Storage, setS3Storage } from '../src/storage/s3.js';
import { __setDbForTests } from '../src/db/client.js';
import type { MailCatchupUpload } from '../src/db/schema/mail-catchup-upload.js';

function extractParamValues(node: any): any[] {
  const values: any[] = [];
  function walk(n: any) {
    if (!n) return;
    if (typeof n === 'object') {
      if ('value' in n && (typeof n.value === 'string' || typeof n.value === 'number')) {
        values.push(n.value);
      }
      if (Array.isArray(n.queryChunks)) {
        for (const c of n.queryChunks) walk(c);
      }
    }
  }
  walk(node);
  return values;
}

describe('catchup router', () => {
  let fakeS3: FakeS3Storage;
  let mockRows: MailCatchupUpload[];
  const prevEnv = process.env.CATCHUP_UPLOAD_ENABLED;

  const user1 = { id: 'user-centurion-1', email: 'user1@centurion.co.za', name: 'User One' };

  function makeCaller(sessionUser = user1) {
    return appRouter.createCaller({
      source: 'test',
      sessionUser,
    } as never);
  }

  beforeEach(() => {
    fakeS3 = new FakeS3Storage('test-bucket');
    setS3Storage(fakeS3);
    mockRows = [];

    // Lightweight mock DB
    const mockDb = {
      insert: () => ({
        values: (row: any) => {
          mockRows.push({
            ...row,
            createdAt: new Date(),
            updatedAt: new Date(),
            completedAt: null,
          });
          return Promise.resolve();
        },
      }),
      select: () => ({
        from: () => ({
          where: (whereClause: any) => {
            const vals = extractParamValues(whereClause);
            const match = mockRows.filter((r) => vals.includes(r.id));
            const promise = Promise.resolve(match);
            return Object.assign(promise, {
              orderBy: () => {
                const filtered = vals.length > 0
                  ? mockRows.filter((r) => vals.includes(r.userId))
                  : mockRows;
                return Promise.resolve(
                  [...filtered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
                );
              },
            });
          },
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: (whereClause: any) => {
            const vals = extractParamValues(whereClause);
            const target = mockRows.find((r) => vals.includes(r.id));
            if (target) {
              Object.assign(target, patch);
            }
            return Promise.resolve();
          },
        }),
      }),
    };

    __setDbForTests({ db: mockDb as never, conn: null as never });
  });

  afterEach(() => {
    __setDbForTests(null);
    if (prevEnv === undefined) {
      delete process.env.CATCHUP_UPLOAD_ENABLED;
    } else {
      process.env.CATCHUP_UPLOAD_ENABLED = prevEnv;
    }
  });

  describe('feature gate', () => {
    it('fails closed when CATCHUP_UPLOAD_ENABLED is unset or false', async () => {
      delete process.env.CATCHUP_UPLOAD_ENABLED;
      const caller = makeCaller();

      await expect(
        caller.catchup.initUpload({ filename: 'test.pst', sizeBytes: 1024 }),
      ).rejects.toThrow(/disabled/i);

      await expect(
        caller.catchup.completeUpload({ uploadId: 'any-id' }),
      ).rejects.toThrow(/disabled/i);

      await expect(
        caller.catchup.abortUpload({ uploadId: 'any-id' }),
      ).rejects.toThrow(/disabled/i);

      await expect(caller.catchup.listMine()).rejects.toThrow(/disabled/i);
    });
  });

  describe('when CATCHUP_UPLOAD_ENABLED=true', () => {
    beforeEach(() => {
      process.env.CATCHUP_UPLOAD_ENABLED = 'true';
    });

    it('initializes single PUT for files <= 100 MiB', async () => {
      const caller = makeCaller();
      const res = await caller.catchup.initUpload({
        filename: 'sent-backup.pst',
        sizeBytes: 50 * 1024 * 1024,
      });

      expect(res.mode).toBe('single');
      expect(res.uploadId).toBeDefined();
      expect(res.putUrl).toContain('zero-fake-s3://');
      expect(res.putHeaders).toHaveProperty('Content-Type', 'application/vnd.ms-outlook');
      expect(res.key).toContain('catchup-uploads/user-centurion-1/');

      expect(mockRows).toHaveLength(1);
      expect(mockRows[0].status).toBe('pending');
      expect(mockRows[0].s3UploadId).toBeNull();
    });

    it('initializes multipart upload for files > 100 MiB', async () => {
      const caller = makeCaller();
      const res = await caller.catchup.initUpload({
        filename: 'huge-archive.zip',
        sizeBytes: 150 * 1024 * 1024,
      });

      expect(res.mode).toBe('multipart');
      expect(res.uploadId).toBeDefined();
      expect(res.s3UploadId).toBeDefined();
      expect(res.partSizeBytes).toBe(16 * 1024 * 1024);
      expect(res.parts.length).toBe(Math.ceil((150 * 1024 * 1024) / (16 * 1024 * 1024)));

      expect(mockRows).toHaveLength(1);
      expect(mockRows[0].status).toBe('pending');
      expect(mockRows[0].s3UploadId).toBe(res.s3UploadId);
    });

    it('rejects disallowed file extensions', async () => {
      const caller = makeCaller();
      await expect(
        caller.catchup.initUpload({ filename: 'script.sh', sizeBytes: 1024 }),
      ).rejects.toThrow(/Invalid catchup upload file type/);
    });

    it('completes single PUT upload once S3 object exists', async () => {
      const caller = makeCaller();
      const init = await caller.catchup.initUpload({
        filename: 'backup.msg',
        sizeBytes: 2048,
      });

      // Before file is in S3, completeUpload should fail
      await expect(
        caller.catchup.completeUpload({ uploadId: init.uploadId }),
      ).rejects.toThrow(/not found in storage/i);

      // Store object into fake S3
      await fakeS3.putObject({
        key: init.key,
        body: Buffer.alloc(2048),
        contentType: 'application/vnd.ms-outlook',
      });

      const complete = await caller.catchup.completeUpload({ uploadId: init.uploadId });
      expect(complete.ok).toBe(true);
      expect(complete.status).toBe('stored');

      const row = mockRows.find((r) => r.id === init.uploadId);
      expect(row?.status).toBe('stored');
    });

    it('completes multipart upload with parts', async () => {
      const caller = makeCaller();
      const init = await caller.catchup.initUpload({
        filename: 'dump.pst',
        sizeBytes: 120 * 1024 * 1024,
      });

      const complete = await caller.catchup.completeUpload({
        uploadId: init.uploadId,
        parts: init.parts?.map((p) => ({ partNumber: p.partNumber, etag: `"etag-${p.partNumber}"` })),
      });

      expect(complete.ok).toBe(true);
      expect(complete.status).toBe('stored');

      const row = mockRows.find((r) => r.id === init.uploadId);
      expect(row?.status).toBe('stored');
    });

    it('aborts pending upload', async () => {
      const caller = makeCaller();
      const init = await caller.catchup.initUpload({
        filename: 'cancel-me.pst',
        sizeBytes: 120 * 1024 * 1024,
      });

      const abort = await caller.catchup.abortUpload({ uploadId: init.uploadId });
      expect(abort.ok).toBe(true);
      expect(abort.status).toBe('aborted');

      const row = mockRows.find((r) => r.id === init.uploadId);
      expect(row?.status).toBe('aborted');
    });

    it('lists own uploads', async () => {
      const caller = makeCaller(user1);
      await caller.catchup.initUpload({
        filename: 'user1-file.pst',
        sizeBytes: 1024,
      });

      const list = await caller.catchup.listMine();
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list[0].originalFilename).toBe('user1-file.pst');
    });
  });
});

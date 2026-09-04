import { describe, expect, it, beforeEach } from 'vitest';
import {
  sanitizeCatchupFilename,
  assertCatchupAllowedFile,
  contentTypeForCatchupFilename,
  buildCatchupS3Key,
  presignCatchupPut,
  createCatchupMultipart,
  presignCatchupPart,
  completeCatchupMultipart,
  abortCatchupMultipart,
  headCatchupObject,
  MAX_CATCHUP_FILE_BYTES,
  SINGLE_PUT_THRESHOLD_BYTES,
} from '../src/storage/catchup-upload.js';
import { FakeS3Storage, setS3Storage } from '../src/storage/s3.js';

describe('catchup upload storage helpers', () => {
  let fakeS3: FakeS3Storage;

  beforeEach(() => {
    fakeS3 = new FakeS3Storage('test-mail-bucket');
    setS3Storage(fakeS3);
  });

  describe('sanitizeCatchupFilename', () => {
    it('preserves clean filenames', () => {
      expect(sanitizeCatchupFilename('outlook_backup.pst')).toBe('outlook_backup.pst');
      expect(sanitizeCatchupFilename('archive.zip')).toBe('archive.zip');
    });

    it('strips directory paths and traversal', () => {
      expect(sanitizeCatchupFilename('C:\\Users\\User\\Documents\\backup.pst')).toBe('backup.pst');
      expect(sanitizeCatchupFilename('../../etc/shadow.msg')).toBe('shadow.msg');
    });

    it('replaces special chars with underscores', () => {
      expect(sanitizeCatchupFilename('Sent Mail (August 2026).pst')).toBe('Sent_Mail__August_2026_.pst');
    });
  });

  describe('assertCatchupAllowedFile', () => {
    it('accepts valid .pst, .zip, .msg up to 50 GiB', () => {
      expect(() => assertCatchupAllowedFile('mail.pst', 1024)).not.toThrow();
      expect(() => assertCatchupAllowedFile('archive.ZIP', 100 * 1024 * 1024)).not.toThrow();
      expect(() => assertCatchupAllowedFile('item.msg', 5000)).not.toThrow();
      expect(() => assertCatchupAllowedFile('huge.pst', MAX_CATCHUP_FILE_BYTES)).not.toThrow();
    });

    it('rejects disallowed extensions', () => {
      expect(() => assertCatchupAllowedFile('notes.pdf', 1024)).toThrow(/Invalid catchup upload file type/);
      expect(() => assertCatchupAllowedFile('virus.exe', 1024)).toThrow(/Invalid catchup upload file type/);
    });

    it('rejects 0 bytes or negative bytes', () => {
      expect(() => assertCatchupAllowedFile('empty.pst', 0)).toThrow(/Invalid file size/);
      expect(() => assertCatchupAllowedFile('empty.pst', -5)).toThrow(/Invalid file size/);
    });

    it('rejects file larger than 50 GiB', () => {
      expect(() => assertCatchupAllowedFile('huge.pst', MAX_CATCHUP_FILE_BYTES + 1)).toThrow(/exceeds maximum 50 GB limit/);
    });

    it('defines single PUT threshold at 100 MiB', () => {
      expect(SINGLE_PUT_THRESHOLD_BYTES).toBe(100 * 1024 * 1024);
    });
  });

  describe('contentTypeForCatchupFilename', () => {
    it('maps extensions to correct mime types', () => {
      expect(contentTypeForCatchupFilename('a.pst')).toBe('application/vnd.ms-outlook');
      expect(contentTypeForCatchupFilename('b.msg')).toBe('application/vnd.ms-outlook');
      expect(contentTypeForCatchupFilename('c.zip')).toBe('application/zip');
      expect(contentTypeForCatchupFilename('unknown.ext')).toBe('application/octet-stream');
    });
  });

  describe('buildCatchupS3Key', () => {
    it('builds standard key prefix', () => {
      const key = buildCatchupS3Key('user123', 'upload456', 'My Data.pst');
      expect(key).toBe('catchup-uploads/user123/upload456/My_Data.pst');
    });
  });

  describe('single PUT presigning', () => {
    it('presigns single PUT with fake S3', async () => {
      const res = await presignCatchupPut({
        key: 'catchup-uploads/u1/up1/test.pst',
        contentType: 'application/vnd.ms-outlook',
      });
      expect(res.uploadUrl).toContain('zero-fake-s3://');
      expect(res.uploadUrl).toContain('catchup-uploads/u1/up1/test.pst');
      expect(res.headers).toEqual({
        'Content-Type': 'application/vnd.ms-outlook',
        'x-amz-server-side-encryption': 'AES256',
      });
    });
  });

  describe('multipart upload operations', () => {
    it('creates MPU, presigns part, completes MPU, and verifies via head', async () => {
      const key = 'catchup-uploads/u1/up2/large.pst';
      const contentType = 'application/vnd.ms-outlook';

      const s3UploadId = await createCatchupMultipart({ key, contentType });
      expect(s3UploadId).toBeDefined();

      const part1 = await presignCatchupPart({
        key,
        uploadId: s3UploadId,
        partNumber: 1,
      });
      expect(part1.partNumber).toBe(1);
      expect(part1.uploadUrl).toContain('zero-fake-s3://');

      await completeCatchupMultipart({
        key,
        uploadId: s3UploadId,
        parts: [{ partNumber: 1, etag: '"etag-1"' }],
        totalSizeBytes: 150 * 1024 * 1024,
      });

      const head = await headCatchupObject(key);
      expect(head).not.toBeNull();
      expect(head?.sizeBytes).toBe(150 * 1024 * 1024);
      expect(head?.contentType).toBe(contentType);
    });

    it('aborts multipart upload', async () => {
      const key = 'catchup-uploads/u1/up3/aborted.pst';
      const s3UploadId = await createCatchupMultipart({
        key,
        contentType: 'application/vnd.ms-outlook',
      });
      await abortCatchupMultipart({ key, uploadId: s3UploadId });
      const head = await headCatchupObject(key);
      expect(head).toBeNull();
    });
  });

  describe('headCatchupObject', () => {
    it('returns null for missing key', async () => {
      const head = await headCatchupObject('nonexistent-key');
      expect(head).toBeNull();
    });

    it('returns size and contentType for existing stored object', async () => {
      const key = 'test-key.pst';
      await fakeS3.putObject({
        key,
        body: Buffer.from('hello outlook'),
        contentType: 'application/vnd.ms-outlook',
      });
      const head = await headCatchupObject(key);
      expect(head).toEqual({
        sizeBytes: 13,
        contentType: 'application/vnd.ms-outlook',
        eTag: '"fake-etag"',
      });
    });
  });
});

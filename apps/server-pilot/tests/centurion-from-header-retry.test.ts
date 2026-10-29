import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateOutputParent, readFromHeader } from '../scripts/retry-centurion-from-header-evidence-live.js';
import type { RealS3Storage } from '../src/storage/s3.js';

describe('confirmation PDF retry header evidence', () => {
  it.each([
    { header: 'Subject: Synthetic\r\n\r\n', status: 'unreadable' },
    { header: 'From: <>\r\nSubject: Synthetic\r\n\r\n', status: 'unreadable' },
    { header: 'From: sender@example.test\r\n\r\n', status: 'no_match' },
  ])('handles missing and unnamed senders as $status', async ({ header, status }) => {
    const bytes = Buffer.from(header);
    const storage = {
      bucket: 'synthetic',
      client: { send: async () => ({ Body: { transformToByteArray: async () => bytes } }) },
    } as unknown as RealS3Storage;
    await expect(readFromHeader(storage, 'synthetic', 'id-a')).resolves.toEqual({
      messageDbId: 'id-a',
      status,
      headerSha256: createHash('sha256').update(header).digest('hex'),
    });
  });

  it('hashes only the first header when body uses different line endings', async () => {
    const header = 'From: Centurion at Example <sender@example.test>\nSubject: Synthetic\n\n';
    const bytes = Buffer.from(`${header}body\r\n\r\nother text`);
    const storage = {
      bucket: 'synthetic',
      client: { send: async () => ({ Body: { transformToByteArray: async () => bytes } }) },
    } as unknown as RealS3Storage;
    await expect(readFromHeader(storage, 'synthetic', 'id-a')).resolves.toEqual({
      messageDbId: 'id-a',
      status: 'match',
      headerSha256: createHash('sha256').update(header).digest('hex'),
    });
  });

  it('rejects symlink escapes from the private output root', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'centurion-retry-path-'));
    try {
      const root = path.join(dir, 'private');
      const outside = path.join(dir, 'outside');
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, path.join(root, 'escape'), 'dir');
      await expect(privateOutputParent(root, path.join(root, 'escape', 'output.jsonl'))).rejects.toThrow('output_path_invalid');
      await expect(privateOutputParent(root, path.join(root, 'output.jsonl'))).resolves.toBe(root);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

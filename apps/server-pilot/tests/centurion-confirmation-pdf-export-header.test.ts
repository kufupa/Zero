import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFromHeader, savePdfBytes } from '../scripts/export-centurion-confirmation-pdf-dataset-live.js';
import type { RealS3Storage } from '../src/storage/s3.js';

describe('confirmation PDF exporter header evidence', () => {
  it('propagates local PDF write failures without replacing existing files', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'centurion-export-'));
    const target = path.join(directory, 'existing.pdf');
    try {
      writeFileSync(target, 'original');
      await expect(savePdfBytes(target, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
      expect(readFileSync(target, 'utf8')).toBe('original');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    await expect(readFromHeader(storage, 'synthetic')).resolves.toEqual({
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
    await expect(readFromHeader(storage, 'synthetic')).resolves.toEqual({
      status: 'match',
      headerSha256: createHash('sha256').update(header).digest('hex'),
    });
  });
});

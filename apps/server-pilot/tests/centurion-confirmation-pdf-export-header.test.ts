import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFromHeader } from '../scripts/export-centurion-confirmation-pdf-dataset-live.js';
import type { RealS3Storage } from '../src/storage/s3.js';

describe('confirmation PDF exporter header evidence', () => {
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

import {
  CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY,
  cleanupCandidateAttachmentObjects,
} from '../src/mail/ingest/store.js';
import type { ParsedAttachment } from '../src/mail/ingest/parse-message.js';
import type { S3Storage } from '../src/storage/s3.js';
import { describe, expect, it } from 'vitest';

describe('duplicate attachment cleanup', () => {
  it('bounds deletion concurrency while reporting every failed cleanup', async () => {
    const candidateMessageId = 'candidate-message';
    const attachments: ParsedAttachment[] = Array.from({ length: 12 }, (_value, index) => ({
      s3Key: `attachments/${candidateMessageId}/attachment-${index}`,
      filename: `attachment-${index}.bin`,
      mimeType: 'application/octet-stream',
      sizeBytes: index + 1,
      contentId: null,
      isInline: false,
    }));
    const deletedKeys: string[] = [];
    let activeDeletes = 0;
    let peakDeletes = 0;
    const storage = {
      async deleteObject(key: string) {
        deletedKeys.push(key);
        activeDeletes += 1;
        peakDeletes = Math.max(peakDeletes, activeDeletes);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (key.endsWith('/attachment-5')) {
            throw new Error('simulated delete failure');
          }
        } finally {
          activeDeletes -= 1;
        }
      },
    } as S3Storage;

    const failureCount = await cleanupCandidateAttachmentObjects(
      storage,
      attachments,
      candidateMessageId,
      'canonical-message',
    );

    expect(deletedKeys).toHaveLength(attachments.length);
    expect(failureCount).toBe(1);
    expect(peakDeletes).toBeLessThanOrEqual(CANDIDATE_ATTACHMENT_DELETE_CONCURRENCY);
  });
});

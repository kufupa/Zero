import type { ParsedAttachment } from '../src/mail/ingest/parse-message.js';
import { ownedCandidateAttachmentKeys } from '../src/mail/ingest/store.js';
import { describe, expect, it } from 'vitest';

describe('duplicate attachment cleanup', () => {
  it('keeps every owned candidate key and excludes canonical attachments', () => {
    const candidateMessageId = 'candidate-message';
    const attachments: ParsedAttachment[] = Array.from({ length: 12 }, (_value, index) => ({
      s3Key: `attachments/${candidateMessageId}/attachment-${index}`,
      filename: `attachment-${index}.bin`,
      mimeType: 'application/octet-stream',
      sizeBytes: index + 1,
      contentId: null,
      isInline: false,
    }));
    attachments.push({
      ...attachments[0]!,
      s3Key: 'attachments/canonical-message/attachment-canonical',
    });

    expect(ownedCandidateAttachmentKeys(attachments, candidateMessageId)).toEqual(
      attachments.slice(0, 12).map((attachment) => attachment.s3Key),
    );
  });
});

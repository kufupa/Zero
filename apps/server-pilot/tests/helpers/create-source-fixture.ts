import type { CreateSourceSnapshot, HistoricalCorrection } from '../../src/ai/pane-create-source-snapshot.js';

export const sourceFixture: CreateSourceSnapshot = {
  source: {
    id: 'message-1', transportId: 'hotel', threadId: 'thread-1', direction: 'inbound', historyOnly: false,
    ownerHeaderValue: null, messageIdHeader: '<message@example.invalid>', inReplyTo: null, references: [],
    fromAddress: 'guest@example.invalid', toAddresses: ['hotel@example.invalid'], ccAddresses: [], bccAddresses: [],
    subject: 'Stay', textBody: 'A booking', htmlBody: null, originalMsgS3Key: null, rawMimeS3Key: 'mime-key',
    sourceProvenance: null, receivedAt: new Date('2026-10-01T09:00:00Z'), sentAt: null,
    createdAt: new Date('2026-10-01T09:01:00Z'),
  },
  extraction: {
    id: '5e07215a-7bf3-496d-886b-352e72a9063d', messageId: 'message-1', extractorVersion: 'v1',
    status: 'succeeded', kind: 'booking', language: 'en', payload: { stays: [{ arrival: '2027-03-01' }] },
    translation: null, attachments: null,
  },
  historicalCorrections: [],
  attachments: [
    { id: 'b', messageId: 'message-1', filename: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      sha256: 'b'.repeat(64), sourceAttachmentId: null, s3Key: 'b-key', contentId: null, isInline: false },
    { id: 'a', messageId: 'message-1', filename: 'a.xlsx', mimeType: 'application/xlsx', sizeBytes: 5,
      sha256: 'a'.repeat(64), sourceAttachmentId: null, s3Key: 'a-key', contentId: null, isInline: false },
  ],
};

export const historicalCorrectionFixture: HistoricalCorrection = {
  event: {
    id: '67272cc3-3100-4fe8-b036-c418e307fbed', workItemId: '31b44b6e-ff0a-43c1-a6eb-82aa2771a235',
    actorKind: 'user', actorUserId: 'staff-1', type: 'field.edit', fieldPath: 'stays[s1].rows[s1_row].count',
    value: 1, aiValue: null, aiSource: 'old-v1',
    evidence: { extractionId: '47e12370-cfab-4f21-bc29-7a0a338f4440', paneSeq: 1,
      paneState: { 'stays[s1].rows[s1_row].count': 1 } },
  },
  extraction: { ...sourceFixture.extraction, id: '47e12370-cfab-4f21-bc29-7a0a338f4440',
    extractorVersion: 'old-v1', payload: { stays: [] } },
};

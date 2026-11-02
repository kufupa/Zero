import { describe, expect, it } from 'vitest';
import { createSourceSnapshotDigest } from '../src/ai/pane-create-source-snapshot.js';
import { historicalCorrectionFixture as history, sourceFixture as original } from './helpers/create-source-fixture.js';

describe('create source content binding', () => {
  it('hashes the complete server snapshot in stable attachment order', () => {
    const value = createSourceSnapshotDigest(original);
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(createSourceSnapshotDigest({ ...original, attachments: [...original.attachments].reverse() })).toBe(value);
  });

  it('changes when message identity, contents, recipients or linked storage changes', () => {
    const value = createSourceSnapshotDigest(original);
    for (const patch of [
      { threadId: 'thread-2' }, { messageIdHeader: '<different@example.invalid>' },
      { subject: 'Other stay' }, { textBody: 'Changed request' }, { htmlBody: '<p>Changed</p>' },
      { fromAddress: 'other@example.invalid' }, { toAddresses: ['other@example.invalid'] },
      { ccAddresses: ['other@example.invalid'] }, { rawMimeS3Key: 'other-key' },
      { sourceProvenance: { canonicalContentVersion: '2' } },
      { receivedAt: new Date('2026-10-01T08:00:00Z') }, { sentAt: new Date('2026-10-01T08:00:00Z') },
      { createdAt: new Date('2026-10-01T08:00:00Z') },
    ]) {
      expect(createSourceSnapshotDigest({ ...original, source: { ...original.source, ...patch } })).not.toBe(value);
    }
  });

  it('binds extraction identity, payload, translation and attachment projection', () => {
    const value = createSourceSnapshotDigest(original);
    for (const patch of [
      { id: '11111111-1111-4111-8111-111111111111' }, { extractorVersion: 'v2' },
      { payload: { stays: [{ arrival: '2027-03-02' }] } }, { translation: { text: 'changed' } },
      { attachments: [{ filename: 'revised.pdf' }] },
    ]) {
      expect(createSourceSnapshotDigest({ ...original, extraction: { ...original.extraction, ...patch } })).not.toBe(value);
    }
  });

  it('binds every attachment row and refuses duplicate IDs', () => {
    const value = createSourceSnapshotDigest(original);
    for (const patch of [
      { filename: 'changed.pdf' }, { mimeType: 'text/plain' }, { sha256: 'c'.repeat(64) }, { sha256: null },
      { s3Key: 'changed-key' }, { sizeBytes: 9 }, { contentId: 'cid' }, { isInline: true },
    ]) {
      expect(createSourceSnapshotDigest({ ...original, attachments: [{ ...original.attachments[0]!, ...patch }, original.attachments[1]!] })).not.toBe(value);
    }
    expect(createSourceSnapshotDigest({ ...original, attachments: [] })).not.toBe(value);
    expect(() => createSourceSnapshotDigest({ ...original, attachments: [original.attachments[0]!, original.attachments[0]!] })).toThrow('create_source_mismatch');
  });

  it('rejects outbound, unsuccessful extraction and mismatched source relationships', () => {
    expect(() => createSourceSnapshotDigest({ ...original, source: { ...original.source, direction: 'outbound' } })).toThrow('create_source_mismatch');
    expect(() => createSourceSnapshotDigest({ ...original, extraction: { ...original.extraction, status: 'failed' } })).toThrow('create_source_mismatch');
    expect(() => createSourceSnapshotDigest({ ...original, extraction: { ...original.extraction, messageId: 'other' } })).toThrow('create_source_mismatch');
    expect(() => createSourceSnapshotDigest({ ...original, attachments: [{ ...original.attachments[0]!, messageId: 'other' }] })).toThrow('create_source_mismatch');
  });
});


describe('historical correction content binding', () => {
  it('binds the exact server-loaded event, evidence and historical extraction', () => {
    const withHistory = { ...original, historicalCorrections: [history] };
    const value = createSourceSnapshotDigest(withHistory);
    expect(value).not.toBe(createSourceSnapshotDigest(original));
    for (const changed of [
      { ...history, event: { ...history.event, actorUserId: 'staff-2' } },
      { ...history, event: { ...history.event, evidence: { ...(history.event.evidence as object), paneSeq: 2 } } },
      { ...history, extraction: { ...history.extraction, payload: { stays: [{ arrival: '2027-03-02' }] } } },
    ]) {
      expect(createSourceSnapshotDigest({ ...original, historicalCorrections: [changed] })).not.toBe(value);
    }
  });

  it('refuses missing, duplicate or inconsistent provenance', () => {
    expect(() => createSourceSnapshotDigest({ ...original, historicalCorrections: undefined as never })).toThrow('create_source_mismatch');
    expect(() => createSourceSnapshotDigest({ ...original, historicalCorrections: [history, history] })).toThrow('create_source_mismatch');
    for (const changed of [
      { ...history, event: { ...history.event, actorKind: 'system' } },
      { ...history, event: { ...history.event, type: 'field.accept' as const } },
      { ...history, event: { ...history.event, value: 2 } },
      { ...history, event: { ...history.event, aiSource: 'different' } },
      { ...history, event: { ...history.event, evidence: { extractionId: 'other', paneSeq: 1, paneState: {} } } },
      { ...history, event: { ...history.event, evidence: { extractionId: history.extraction.id, paneSeq: 0, paneState: {} } } },
      { ...history, extraction: { ...history.extraction, messageId: 'other' } },
      { ...history, extraction: { ...history.extraction, status: 'failed' } },
    ]) {
      expect(() => createSourceSnapshotDigest({ ...original, historicalCorrections: [changed] })).toThrow('create_source_mismatch');
    }
  });
});

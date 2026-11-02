import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveLinkedVoucherSnapshot, type VoucherSourceDependencies } from '../src/ai/voucher-filing-source.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const input = { transportId: 'transport', messageId: 'message', attachmentId: 'attachment' };
const hash = 'a'.repeat(64);
const key = `outlook-sync-originals/v1/${sha(JSON.stringify(['source', 'origin', 'artifact']))}/${hash}`;
const receipt = { key, bytes: 20, sha256: hash, eTag: 'etag' };
const row = { filename: 'voucher.pdf', mimeType: 'application/pdf', sizeBytes: 20, sha256: hash,
  sourceAttachmentId: '1', s3Key: key, isInline: false, contentId: null, direction: 'inbound',
  historyOnly: false, provenance: { pop3: true } };
const artifact = { id: 'artifact', observationId: 'origin', role: 'attachment:1', version: 1,
  expectedBytes: 20, sha256: hash, contentType: 'application/pdf', sealedKey: key,
  verifiedReceipt: receipt, acceptedAt: new Date(), metadata: { fileName: 'voucher.pdf' } };
const observation = { id: 'origin', sourceId: 'source', sourceObservationId: 'provider', artifactOrigin: null,
  canonicalMessageId: 'message', direction: 'inbound', ingestionState: 'committed', exportState: 'retained',
  requiredArtifactRoles: ['attachment:1'], evidence: {} };

type Results = unknown[][];
function dependencies(results: Results): VoucherSourceDependencies {
  let index = 0;
  const db = { select: () => {
    const query = { from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query,
      limit: async () => results[index++] ?? [] };
    return query;
  } };
  return { db, storage: { bucket: 'private-mail' }, signal: new AbortController().signal,
    checkAuthority: async () => true } as unknown as VoucherSourceDependencies;
}
const rows = (): Results => [[row], [{ id: input.attachmentId }], [artifact], [observation],
  [{ id: 'artifact' }], [{ id: 'source' }], [observation]];

describe('linked Outlook voucher artifact', () => {
  it('binds a unique accepted artifact to its canonical mailbox observation', async () => {
    const result = await resolveLinkedVoucherSnapshot(input, dependencies(rows()));
    expect(result?.source).toMatchObject({ ...input, filename: 'voucher.pdf', mimeType: 'application/pdf', sha256: hash });
    expect(result?.source.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.receipt).toEqual(receipt);
  });

  it('refuses missing or ambiguous attachment, artifact, source or observation', async () => {
    for (const [slot, value] of [
      [0, []], [1, []], [1, [{ id: 'attachment' }, { id: 'other' }]],
      [2, []], [2, [artifact, artifact]], [3, []], [4, [{ id: 'newer' }]],
      [5, []], [6, []], [6, [observation, observation]],
    ] as Array<[number, unknown[]]>) {
      const result = rows(); result[slot] = value;
      expect(await resolveLinkedVoucherSnapshot(input, dependencies(result))).toBeNull();
    }
  });

  it('refuses mismatched metadata, receipts, provenance and canonical identity', async () => {
    for (const [slot, value] of [
      [0, [{ ...row, provenance: { attention: 'AMBIGUOUS_IDENTITY' } }]],
      [0, [{ ...row, historyOnly: true }]],
      [0, [{ ...row, provenance: { version: 1, sourceId: 'source', observationId: 'origin', artifactOrigin: null,
        artifacts: [{ role: 'attachment:1' }, { role: 'attachment:1' }] } }]],
      [2, [{ ...artifact, acceptedAt: null }]], [2, [{ ...artifact, role: 'attachment:2' }]],
      [2, [{ ...artifact, metadata: { fileName: 'other.pdf' } }]],
      [2, [{ ...artifact, verifiedReceipt: { ...receipt, sha256: 'b'.repeat(64) } }]],
      [6, [{ ...observation, canonicalMessageId: 'other' }]],
      [6, [{ ...observation, sourceId: 'other' }]],
      [6, [{ ...observation, ingestionState: 'attention' }]],
      [6, [{ ...observation, requiredArtifactRoles: ['attachment:2'] }]],
    ] as Array<[number, unknown[]]>) {
      const result = rows(); result[slot] = value;
      expect(await resolveLinkedVoucherSnapshot(input, dependencies(result))).toBeNull();
    }
  });
});

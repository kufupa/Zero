import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readVoucherDiscoverySource, resolveLinkedVoucherSnapshot, type VoucherSourceDependencies } from '../src/ai/voucher-filing-source.js';

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

    const bytes = Buffer.from('%PDF-synthetic-sealed');
    const digest = sha(bytes.toString());
    const sealedKey = `outlook-sync-originals/v1/${sha(JSON.stringify(['source', 'origin', 'artifact']))}/${digest}`;
    const sealedReceipt = { key: sealedKey, bytes: bytes.length, sha256: digest, eTag: 'etag', versionId: 'v1' };
    const sealedRow = { ...row, s3Key: sealedKey, sizeBytes: bytes.length, sha256: digest };
    const sealedArtifact = { ...artifact, sealedKey, expectedBytes: bytes.length, sha256: digest,
      verifiedReceipt: sealedReceipt };
    const linkedRows = [[sealedRow], [{ id: input.attachmentId }], [sealedArtifact], [observation],
      [{ id: 'artifact' }], [{ id: 'source' }]];
    const makeDeps = () => {
      const deps = dependencies([[sealedRow], [sealedRow], [{ id: input.attachmentId }], ...linkedRows,
        [sealedRow], [{ id: input.attachmentId }], ...linkedRows]);
      deps.storage = { bucket: 'private-mail', readSealedBounded: async (got, cap) => {
        expect(got).toEqual(sealedReceipt);
        expect(cap).toBeGreaterThanOrEqual(bytes.length);
        return bytes;
      } };
      return deps;
    };
    const read = await readVoucherDiscoverySource(input, makeDeps());
    expect(read?.bytes).toEqual(bytes);
    expect(read?.source).toMatchObject({ sha256: digest, snapshotDigest: expect.any(String) });
    if (!read) throw new Error('expected sealed source');
    expect(await readVoucherDiscoverySource(input, makeDeps(), { ...read.source, snapshotDigest: 'b'.repeat(64) })).toBeNull();
  });

  it('accepts one committed observation reusing the same retained artifact content', async () => {
    const evidence = { contentIdentity: { sha256: hash, attachments: [{ role: 'attachment:1', stableId: 'stable',
      modifiedAt: '2026-11-02T12:00:00Z', sizeBytes: 20 }] }, semantic: { subject: 'Voucher', isRead: false, categories: [] },
      timestamps: { receivedAt: '2026-11-02T12:00:00Z', modifiedAt: '2026-11-02T12:00:00Z' },
      direction: 'inbound', requiredArtifactRoles: ['attachment:1'] };
    const origin = { ...observation, canonicalMessageId: null, evidence };
    const reused = { ...observation, id: 'reused', artifactOrigin: { sourceId: 'source', observationId: 'origin' },
      evidence: { ...evidence, semantic: { ...evidence.semantic, isRead: true } } };
    const variants = rows(); variants[3] = [origin]; variants[6] = [reused];
    const result = await resolveLinkedVoucherSnapshot(input, dependencies(variants));
    expect(result?.source).toMatchObject({ ...input, filename: 'voucher.pdf', sha256: hash });
    const original = rows(); original[3] = [{ ...origin, canonicalMessageId: input.messageId }];
    original[6] = [reused, { ...reused, id: 'another' }];
    const direct = await resolveLinkedVoucherSnapshot(input, dependencies(original));
    expect(direct?.source.snapshotDigest).toBeDefined();
    expect(result?.source.snapshotDigest).not.toEqual(direct?.source.snapshotDigest);

    for (const [changedOrigin, witnesses] of [
      [{ ...origin, exportState: 'pending' }, [reused]],
      [origin, [{ ...reused, artifactOrigin: { sourceId: 'other', observationId: 'origin' } }]],
      [origin, [{ ...reused, artifactOrigin: { sourceId: 'source', observationId: 'wrong' } }]],
      [origin, [{ ...reused, sourceObservationId: 'different' }]],
      [origin, [{ ...reused, evidence: { ...evidence, contentIdentity: { ...evidence.contentIdentity, sha256: 'b'.repeat(64) } } }]],
      [origin, []],
      [origin, [reused, { ...reused, id: 'another' }]],
    ] as Array<[typeof origin, unknown[]]>) {
      const bad = rows(); bad[3] = [changedOrigin]; bad[6] = witnesses;
      expect(await resolveLinkedVoucherSnapshot(input, dependencies(bad))).toBeNull();
    }
  });

  it('refuses missing or ambiguous attachment, artifact, source or observation', async () => {
    for (const [slot, value] of [
      [0, []], [1, []], [1, [{ id: 'attachment' }, { id: 'other' }]],
      [2, []], [2, [artifact, artifact]], [3, []], [4, [{ id: 'newer' }]],
      [5, []],
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
      [2, [{ ...artifact, observationId: 'other' }]],
      [2, [{ ...artifact, sha256: 'b'.repeat(64) }]],
      [3, [{ ...observation, sourceId: 'other' }]],
      [3, [{ ...observation, artifactOrigin: { sourceId: 'source', observationId: 'other' } }]],
      [2, [{ ...artifact, verifiedReceipt: { ...receipt, sha256: 'b'.repeat(64) } }]],
      [6, [{ ...observation, canonicalMessageId: 'other' }]],
      [6, [{ ...observation, sourceId: 'other' }]],
      [6, [{ ...observation, ingestionState: 'attention' }]],
      [6, [{ ...observation, requiredArtifactRoles: ['attachment:2'] }]],
    ] as Array<[number, unknown[]]>) {
      const result = rows(); result[slot] = value;
      if (slot === 6) result[3] = [{ ...observation, canonicalMessageId: null }];
      expect(await resolveLinkedVoucherSnapshot(input, dependencies(result))).toBeNull();
    }
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseEvidenceSnapshotJsonl } from '../scripts/centurion-evidence-jsonl.js';

const CANARY = 'SYNTHETIC-PRIVATE-CANARY-guest@example.test-/private/file';
const ref = { sourceId: 'synthetic-source', versionId: 'v1', snapshotId: 'snapshot-1' };
const schemaVersion = 'connected-mailbox-corpus-v4';
function fixture() {
  const threads = [
    { recordType: 'thread', schemaVersion, snapshotId: ref.snapshotId, threadId: 'thread-1', messages: [], body: CANARY },
    { recordType: 'thread', schemaVersion, snapshotId: ref.snapshotId, threadId: 'thread-2', messages: [], extra: { nested: ['x', null, 1] } },
  ];
  const ordered = `${threads.map((item) => JSON.stringify(item)).join('\n')}\n`;
  const metadata = { recordType: 'metadata', schemaVersion, snapshotId: ref.snapshotId,
    recordCount: threads.length, orderedRecordSha256: createHash('sha256').update(ordered).digest('hex') };
  return { records: [metadata, ...threads], text: `${JSON.stringify(metadata)}\n${ordered}` };
}

describe('private saved-snapshot JSONL parser', () => {
  it('preserves each ordered record and delegates checksum/schema verification to the adapter', () => {
    const sample = fixture();
    for (const input of [sample.text, Buffer.from(sample.text), sample.text.replaceAll('\n', '\r\n'), sample.text.slice(0, -1)]) {
      const parsed = parseEvidenceSnapshotJsonl(input);
      expect(parsed).toEqual({ ok: true, records: sample.records });
      if (!parsed.ok) throw new Error('Synthetic fixture failed');
    }
  });

  it('preserves modified and malformed records without inventing provenance', () => {
    const sample = fixture();
    const parsed = parseEvidenceSnapshotJsonl(sample.text.replace('thread-2', 'changed-thread'));
    if (!parsed.ok) throw new Error('Synthetic fixture failed');
    expect(parsed.records[0]).toEqual(sample.records[0]);
    expect(parsed.records[2]).not.toEqual(sample.records[2]);
    expect(parseEvidenceSnapshotJsonl('{"recordType":"not-metadata"}\n')).toEqual({
      ok: true, records: [{ recordType: 'not-metadata' }],
    });
  });

  it('fails closed on malformed framing, duplicate keys and lossy numeric values', () => {
    for (const input of ['', '\n', '{}\n\n{}', '{}\n\n', '{', '{}\nnot-json', '{"x":1,"x":2}',
      '{"x":1,"\\u0078":2}', '{"nested":{"x":1,"x":2}}', '{"x":9007199254740993}',
      '{"x":1e9999}', '{"x":1e-9999}', '﻿{}']) {
      expect(parseEvidenceSnapshotJsonl(input)).toEqual({ ok: false, error: { code: 'INVALID_JSONL' } });
    }
    expect(parseEvidenceSnapshotJsonl('{"a":{"x":1},"b":{"x":1.0},"list":[1e2,-0,0.5]}').ok).toBe(true);
  });

  it('never leaks source text, paths, keys, or thrown exception messages on errors', () => {
    const throwing = new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } });
    const results = [parseEvidenceSnapshotJsonl(`${CANARY}\n{`), parseEvidenceSnapshotJsonl(throwing),
      parseEvidenceSnapshotJsonl(Buffer.from([0xc3, 0x28])), parseEvidenceSnapshotJsonl('\ud800')];
    expect(results).toEqual([
      { ok: false, error: { code: 'INVALID_JSONL' } }, { ok: false, error: { code: 'INVALID_INPUT' } },
      { ok: false, error: { code: 'INVALID_UTF8' } }, { ok: false, error: { code: 'INVALID_UTF8' } },
    ]);
    expect(JSON.stringify(results)).not.toContain(CANARY);
  });
});

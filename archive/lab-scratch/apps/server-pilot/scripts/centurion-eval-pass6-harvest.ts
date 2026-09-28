#!/usr/bin/env tsx
/**
 * Pass-6 harvest: useful PDF/xlsx only. Run on approved host i-008f737974a9ba9b3.
 * Cursor box must not claim live S3 unless this host matches.
 * Writes shards of extracted text (truncated) for Luna. No PII on stdout.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPROVED = 'i-008f737974a9ba9b3';
const DEMAND = path.resolve(
  import.meta.dirname,
  '../../../.private/centurion-corpus/centurion-tool-demand-20260919',
);
const queuePath = path.join(DEMAND, 'truth/attachment-queue.json');

function instanceId(): string | null {
  try {
    return execFileSync(
      'curl',
      ['-s', '--max-time', '2', 'http://169.254.169.254/latest/meta-data/instance-id'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return null;
  }
}

const host = instanceId();
const queue = existsSync(queuePath)
  ? (JSON.parse(readFileSync(queuePath, 'utf8')) as {
      n: number;
      files: Array<{ inboundId: string; filename: string | null; contentType: string | null; byteSize: number | null; s3Key: string | null }>;
    })
  : { n: 0, files: [] };

const byInbound = new Map<string, typeof queue.files>();
for (const file of queue.files) {
  if (!byInbound.has(file.inboundId)) byInbound.set(file.inboundId, []);
  const list = byInbound.get(file.inboundId)!;
  if (list.length >= 10) continue;
  list.push(file);
}

const rows = [...byInbound.entries()].map(([inboundId, artifacts]) => ({
  inboundId,
  artifacts: artifacts.map((item) => ({
    filename: item.filename,
    contentType: item.contentType,
    byteSize: item.byteSize,
    s3Key: item.s3Key,
    textExtract: '',
    harvest: host === APPROVED ? 'pending_s3' : 'metadata_only_wrong_host',
  })),
}));

mkdirSync(path.join(DEMAND, 'shards'), { recursive: true, mode: 0o700 });
mkdirSync(path.join(DEMAND, 'truth'), { recursive: true, mode: 0o700 });

const SHARDS = 5;
const size = Math.ceil(rows.length / SHARDS) || 1;
for (let i = 0; i < SHARDS; i += 1) {
  const slice = rows.slice(i * size, (i + 1) * size);
  writeFileSync(
    path.join(DEMAND, 'shards', `pass6-${i}-bodies.jsonl`),
    slice.length ? `${slice.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
    { mode: 0o600 },
  );
}

const report = {
  host: host || 'unknown',
  approvedHost: APPROVED,
  onApprovedHost: host === APPROVED,
  queuedFiles: queue.n,
  inboundGroups: rows.length,
  mode: host === APPROVED ? 's3_harvest_required' : 'metadata_only',
  hostname: os.hostname(),
};
writeFileSync(path.join(DEMAND, 'truth/pass6-harvest.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report));

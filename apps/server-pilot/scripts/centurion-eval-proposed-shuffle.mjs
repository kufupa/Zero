#!/usr/bin/env node
/** Shuffle all lab inbounds into ≤7 proposed-action shards. Counts on stdout. No bodies. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const SHARD_COUNT = Math.min(7, Number(process.argv[2] || 7));
const labPath = path.join(DEMAND, 'lab/index.json');
const lab = JSON.parse(readFileSync(labPath, 'utf8'));
const pdfByInbound = new Map();
for (let i = 0; i < 8; i += 1) {
  const file = path.join(DEMAND, 'shards', `pass6-${i}-bodies.jsonl`);
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    const arts = row.artifacts || [];
    const pdf = arts.find((item) => item.pdfPath);
    const text = arts.map((item) => item.textExtract || '').join('\n');
    pdfByInbound.set(String(row.inboundId), {
      pdfPath: pdf?.pdfPath || null,
      attachmentText: String(text || '').replace(/^\s*%PDF[\s\S]*/, '').slice(0, 8000),
    });
  }
}

const shardDir = path.join(DEMAND, 'shards');
mkdirSync(shardDir, { mode: 0o700, recursive: true });
const rows = (lab.rows || []).map((row) => {
  const pdf = pdfByInbound.get(String(row.inboundId)) || {};
  return {
    inboundId: row.inboundId,
    threadId: row.threadId,
    threadOutcome: row.threadOutcome,
    otherDesk: row.otherDesk,
    channelAuto: row.channelAuto,
    tools: row.tools,
    needed: row.needed,
    staffUsed: row.staffUsed,
    inbound: {
      subject: row.inbound?.subject,
      textBody: String(row.inbound?.textBody || '').slice(0, 8000),
    },
    gold: row.gold
      ? { subject: row.gold.subject, textBody: String(row.gold.textBody || '').slice(0, 4000) }
      : null,
    priorInbounds: (row.priorInbounds || []).map((item) => ({
      id: item.id,
      subject: item.subject,
      textBody: String(item.textBody || '').slice(0, 2000),
    })),
    stayAsks: row.stayAsks || [],
    pdfPath: pdf.pdfPath || null,
    attachmentText: pdf.attachmentText || String(row.attachmentText || '').replace(/^\s*%PDF[\s\S]*/, '').slice(0, 8000),
  };
});
const size = Math.max(1, Math.ceil(rows.length / SHARD_COUNT));
for (let i = 0; i < SHARD_COUNT; i += 1) {
  const slice = rows.slice(i * size, (i + 1) * size);
  const dest = path.join(shardDir, `proposed-${i}-bodies.jsonl`);
  writeFileSync(dest, slice.map((row) => JSON.stringify(row)).join('\n') + (slice.length ? '\n' : ''), { mode: 0o600 });
}
console.log(JSON.stringify({ rows: rows.length, shards: SHARD_COUNT, size }));

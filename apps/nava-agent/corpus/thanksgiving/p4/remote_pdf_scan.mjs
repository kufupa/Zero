#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const requirePilot = createRequire('/home/ubuntu/repos/zero/apps/server-pilot/package.json');
const { S3Client, GetObjectCommand } = requirePilot('@aws-sdk/client-s3');
const execFileAsync = promisify(execFile);

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function cleanError(error) { return String(error?.message || error).slice(0, 300); }
async function streamObjectBody(body, maxBytes = 80 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of body) { size += chunk.length; if (size > maxBytes) throw new Error('pdf_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function main() {
  const started = Date.now();
  const inputPath = argValue('--input');
  const work = argValue('--work');
  const workers = Math.max(2, Math.min(16, Number(argValue('--workers', '8')) || 8));
  if (!inputPath || !work) throw new Error('--input and --work required');
  const rows = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const stats = { input_rows: rows.length, groups: 0, scan_ok: 0, scan_empty: 0, scan_errors: 0, doc_rows: 0, errors: [] };
  if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET missing');
  const s3 = new S3Client({ region: process.env.AWS_REGION || 'af-south-1' });
  const groups = new Map();
  for (const row of rows) {
    const key = row.sha256 ? `sha:${row.sha256}` : `id:${row.attachment_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  stats.groups = groups.size;
  const outRows = [];
  const groupList = [...groups.values()];
  let nextIndex = 0;
  async function scanGroup(members) {
    const row = members[0];
    const safe = row.attachment_id.replace(/[^A-Za-z0-9_.-]/g, '_');
    const tmpPath = path.join(work, `pdf-${safe}.bin`);
    const fetchedAt = new Date().toISOString();
    let text = null, source = 'lazy';
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.s3_key }));
      const bytes = await streamObjectBody(object.Body);
      fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
      const extracted = await execFileAsync('pdftotext', ['-layout', tmpPath, '-'], { timeout: 30000, maxBuffer: 24 * 1024 * 1024 });
      text = extracted.stdout || '';
      source = 'ec2_pdftotext';
      if (text.trim()) stats.scan_ok += 1; else stats.scan_empty += 1;
    } catch (error) {
      stats.scan_errors += 1;
      if (stats.errors.length < 20) stats.errors.push({ attachment_id: row.attachment_id, error: cleanError(error) });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    for (const member of members) {
      outRows.push({ attachment_id: member.attachment_id, text, source, fetched_at: fetchedAt });
      stats.doc_rows += 1;
    }
  }
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= groupList.length) return;
      await scanGroup(groupList[index]);
    }
  }));
  const jsonl = outRows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  const outPath = path.join(work, 'doc-text-patch.jsonl.gz');
  fs.writeFileSync(outPath, gzipSync(Buffer.from(jsonl, 'utf8'), 6), { mode: 0o600 });
  stats.output_path = outPath;
  stats.wall_s = Number(((Date.now() - started) / 1000).toFixed(3));
  console.log('P4_PATCH_SCAN_JSON ' + JSON.stringify(stats));
}

main().catch((error) => { console.error('P4_PATCH_SCAN_ERROR ' + JSON.stringify({ error: cleanError(error) })); process.exitCode = 1; });

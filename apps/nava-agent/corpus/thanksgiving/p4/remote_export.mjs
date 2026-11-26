#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const requirePilot = createRequire('/home/ubuntu/repos/zero/apps/server-pilot/package.json');
const postgres = requirePilot('postgres');
const { S3Client, GetObjectCommand } = requirePilot('@aws-sdk/client-s3');
const execFileAsync = promisify(execFile);

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function cleanError(error) {
  return String(error?.message || error).replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]').slice(0, 300);
}

function createJsonlWriter(filePath) {
  const stream = fs.createWriteStream(filePath, { mode: 0o600 });
  return {
    async write(row) {
      const line = JSON.stringify(row, jsonReplacer) + '\n';
      if (!stream.write(line)) await once(stream, 'drain');
    },
    async end() {
      stream.end();
      await once(stream, 'finish');
    },
  };
}

async function streamObjectBody(body, maxBytes = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('pdf_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const started = Date.now();
  const work = argValue('--work');
  const scanMode = argValue('--scan-mode', 'auto');
  const scanAfter = argValue('--scan-after', '2026-10-29T15:02:21.000Z');
  const workerCount = Math.max(2, Math.min(16, Number(argValue('--workers', '8')) || 8));
  if (!work) throw new Error('--work required');
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing');

  const stats = {
    started_at: new Date().toISOString(),
    scan_mode: scanMode,
    scan_after: scanAfter,
    workers: workerCount,
    messages: 0,
    attachments: 0,
    pdf_candidates: 0,
    inbound_pdf_both_uncut: 0,
    scan_enabled: false,
    scan_groups: 0,
    scan_ok: 0,
    scan_empty: 0,
    scan_errors: 0,
    doc_rows: 0,
    errors: [],
  };

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    connection: {
      application_name: 'p4-snapshot-export',
      statement_timeout: '30min',
      lock_timeout: '5s',
      idle_in_transaction_session_timeout: '30min',
    },
  });

  try {
    const messageWriter = createJsonlWriter(path.join(work, 'messages.jsonl'));
    let lastMessageId = '';
    for (;;) {
      const rows = await sql`
        SELECT
          m.id,
          m.thread_id,
          m.message_id_header,
          m.in_reply_to,
          m."references" AS references_hdr,
          m.sent_at::text AS sent_at,
          m.received_at::text AS received_at,
          m.direction::text AS direction,
          COALESCE(mt.email, im.email) AS mailbox,
          m.from_address AS from_addr,
          m.to_addresses,
          m.cc_addresses,
          m.subject,
          m.text_body,
          m.html_body,
          CASE WHEN COALESCE(tm.is_cut, false) THEN COALESCE(tm.cut_reason, 'cut') ELSE NULL END AS cut_reason
        FROM public.message m
        LEFT JOIN public.mailbox_transport mt ON mt.id = m.transport_id
        LEFT JOIN public.mail_ingest_mailbox im ON im.id = m.ingest_mailbox_id
        LEFT JOIN thanksgiving.message tm ON tm.message_id = m.id
        WHERE m.sent_at >= timestamp '2026-08-01'
          AND m.id > ${lastMessageId}
        ORDER BY m.id
        LIMIT 1500
      `;
      if (!rows.length) break;
      for (const row of rows) {
        await messageWriter.write(row);
        stats.messages += 1;
      }
      lastMessageId = rows[rows.length - 1].id;
    }
    await messageWriter.end();

    const attachmentWriter = createJsonlWriter(path.join(work, 'attachments.jsonl'));
    let lastAttachmentId = '';
    for (;;) {
      const rows = await sql`
        SELECT
          a.id,
          a.message_id,
          a.filename,
          a.mime_type,
          a.size_bytes,
          a.s3_key,
          a.sha256,
          a.is_inline,
          CASE WHEN COALESCE(ta.is_cut, false) THEN COALESCE(ta.cut_reason, 'cut') ELSE NULL END AS cut_reason
        FROM public.attachment a
        JOIN public.message m ON m.id = a.message_id
        LEFT JOIN thanksgiving.attachment ta ON ta.attachment_id = a.id
        WHERE m.sent_at >= timestamp '2026-08-01'
          AND a.id > ${lastAttachmentId}
        ORDER BY a.id
        LIMIT 2500
      `;
      if (!rows.length) break;
      for (const row of rows) {
        await attachmentWriter.write(row);
        stats.attachments += 1;
      }
      lastAttachmentId = rows[rows.length - 1].id;
    }
    await attachmentWriter.end();

    const countRows = await sql`
      SELECT count(*)::int AS count
      FROM public.attachment a
      JOIN public.message m ON m.id = a.message_id
      LEFT JOIN thanksgiving.attachment ta ON ta.attachment_id = a.id
      LEFT JOIN thanksgiving.message tm ON tm.message_id = a.message_id
      WHERE m.direction = 'inbound'
        AND COALESCE(tm.sent_at, m.sent_at, tm.received_at, m.received_at, tm.created_at, m.created_at) >= timestamp '2026-09-09'
        AND NOT COALESCE(ta.is_cut, false)
        AND NOT COALESCE(tm.is_cut, false)
        AND (a.mime_type ILIKE '%pdf%' OR a.filename ILIKE '%.pdf')
    `;
    stats.inbound_pdf_both_uncut = countRows[0]?.count || 0;
    stats.scan_enabled = scanMode === 'yes' || (scanMode === 'auto' && stats.inbound_pdf_both_uncut < 6000);

    const pdfCandidates = await sql`
      SELECT
        a.id AS attachment_id,
        a.message_id,
        a.filename,
        a.mime_type,
        a.size_bytes,
        a.s3_key,
        a.sha256,
        m.direction::text AS direction,
        m.sent_at::text AS sent_at,
        CASE WHEN COALESCE(ta.is_cut, false) THEN COALESCE(ta.cut_reason, 'cut') ELSE NULL END AS attachment_cut_reason,
        CASE WHEN COALESCE(tm.is_cut, false) THEN COALESCE(tm.cut_reason, 'cut') ELSE NULL END AS message_cut_reason
      FROM public.attachment a
      JOIN public.message m ON m.id = a.message_id
      LEFT JOIN thanksgiving.attachment ta ON ta.attachment_id = a.id
      LEFT JOIN thanksgiving.message tm ON tm.message_id = a.message_id
      WHERE m.sent_at >= timestamp '2026-08-01'
        AND (a.mime_type ILIKE '%pdf%' OR a.filename ILIKE '%.pdf')
        AND a.s3_key IS NOT NULL
        AND (
          (
            m.direction = 'inbound'
            AND COALESCE(tm.sent_at, m.sent_at, tm.received_at, m.received_at, tm.created_at, m.created_at) >= timestamp '2026-09-09'
            AND NOT COALESCE(ta.is_cut, false)
            AND NOT COALESCE(tm.is_cut, false)
          )
          OR (
            m.direction = 'outbound'
            AND m.sent_at > ${scanAfter}::timestamp
          )
        )
      ORDER BY a.id
    `;
    stats.pdf_candidates = pdfCandidates.length;

    const docWriter = createJsonlWriter(path.join(work, 'doc_text.jsonl'));
    const groups = new Map();
    for (const row of pdfCandidates) {
      const key = row.sha256 ? `sha:${row.sha256}` : `id:${row.attachment_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    stats.scan_groups = groups.size;

    if (!stats.scan_enabled) {
      const fetchedAt = new Date().toISOString();
      for (const row of pdfCandidates) {
        await docWriter.write({
          attachment_id: row.attachment_id,
          text: null,
          source: 'lazy',
          fetched_at: fetchedAt,
        });
        stats.doc_rows += 1;
      }
    } else {
      if (!process.env.S3_BUCKET) throw new Error('S3_BUCKET missing');
      const s3 = new S3Client({ region: process.env.AWS_REGION || 'af-south-1' });
      const groupList = [...groups.values()];
      let nextIndex = 0;
      const scanOneGroup = async (members) => {
        const row = members[0];
        const safe = row.attachment_id.replace(/[^A-Za-z0-9_.-]/g, '_');
        const tmpPath = path.join(work, `pdf-${safe}.bin`);
        const fetchedAt = new Date().toISOString();
        let text = null;
        let source = 'lazy';
        let error = null;
        try {
          const object = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.s3_key }));
          const bytes = await streamObjectBody(object.Body);
          fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
          const extracted = await execFileAsync('pdftotext', ['-layout', tmpPath, '-'], {
            timeout: 30000,
            maxBuffer: 24 * 1024 * 1024,
          });
          text = extracted.stdout || '';
          source = 'ec2_pdftotext';
          if (text.trim()) stats.scan_ok += 1;
          else stats.scan_empty += 1;
        } catch (err) {
          error = cleanError(err);
          stats.scan_errors += 1;
          if (stats.errors.length < 20) stats.errors.push({ attachment_id: row.attachment_id, error });
        } finally {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        for (const member of members) {
          await docWriter.write({
            attachment_id: member.attachment_id,
            text,
            source,
            fetched_at: fetchedAt,
          });
          stats.doc_rows += 1;
        }
      };
      await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= groupList.length) return;
          await scanOneGroup(groupList[index]);
        }
      }));
    }
    await docWriter.end();

    stats.finished_at = new Date().toISOString();
    stats.wall_s = Number(((Date.now() - started) / 1000).toFixed(3));
    fs.writeFileSync(path.join(work, 'remote_stats.json'), JSON.stringify(stats, null, 2), { mode: 0o600 });
    console.log('P4_REMOTE_STATS ' + JSON.stringify(stats, jsonReplacer));
  } finally {
    try { await sql.end({ timeout: 3 }); } catch {}
  }
}

main().catch((error) => {
  console.error('P4_REMOTE_ERROR ' + JSON.stringify({ error: cleanError(error) }));
  process.exitCode = 1;
});

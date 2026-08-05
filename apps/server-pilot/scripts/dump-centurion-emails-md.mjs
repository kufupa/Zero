#!/usr/bin/env node
/**
 * Dump all Centurion (transport-centurion) messages to one Markdown file.
 * Read-only. Expects DATABASE_URL (+ optional SSL CA at deploy/rds-ca-global.pem).
 *
 * Usage:
 *   node scripts/dump-centurion-emails-md.mjs [--out /path/to/out.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let out = path.join(root, 'centurion-emails-dump.md');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out = argv[++i];
    }
  }
  return { out };
}

function sslOptions() {
  const caPath = path.join(root, 'deploy', 'rds-ca-global.pem');
  if (fs.existsSync(caPath)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
  }
  return 'require';
}

function escMd(s) {
  if (s == null) return '';
  return String(s).replace(/\r\n/g, '\n');
}

function fence(body, lang = '') {
  // Avoid breaking fences if body contains ```
  const safe = escMd(body).replace(/```/g, '``\u200b`');
  return '```' + lang + '\n' + safe + (safe.endsWith('\n') ? '' : '\n') + '```\n';
}

function fmtAddrs(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toISOString();
  } catch {
    return String(d);
  }
}

const { out } = parseArgs(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const sql = postgres(url, { ssl: sslOptions(), max: 1, connect_timeout: 30 });

try {
  const rows = await sql`
    SELECT
      m.id,
      m.thread_id,
      m.direction,
      m.subject,
      m.from_address,
      m.to_addresses,
      m.cc_addresses,
      m.bcc_addresses,
      m.received_at,
      m.sent_at,
      m.created_at,
      m.text_body,
      m.html_body,
      m.pop3_uidl,
      m.raw_mime_s3_key,
      m.owner_header_value,
      m.ingest_mailbox_id
    FROM message m
    WHERE m.transport_id = 'transport-centurion'
    ORDER BY coalesce(m.received_at, m.sent_at, m.created_at) ASC NULLS LAST, m.id ASC
  `;

  const inbound = rows.filter((r) => r.direction === 'inbound').length;
  const outbound = rows.filter((r) => r.direction === 'outbound').length;
  const generatedAt = new Date().toISOString();

  const parts = [];
  parts.push('# Centurion emails dump (Nava pilot)\n');
  parts.push('');
  parts.push(`- Generated: ${generatedAt}`);
  parts.push(`- Transport: \`transport-centurion\``);
  parts.push(`- Total messages: **${rows.length}** (${inbound} inbound, ${outbound} outbound)`);
  parts.push('- Source: RDS `message` table (read-only query)');
  parts.push('');
  parts.push('## Index\n');
  parts.push('| # | Direction | Received/Sent | From | Subject |');
  parts.push('|---|-----------|---------------|------|---------|');

  rows.forEach((r, i) => {
    const when = fmtDate(r.received_at || r.sent_at || r.created_at);
    const subj = escMd(r.subject || '(no subject)').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const from = escMd(r.from_address || '').replace(/\|/g, '\\|');
    parts.push(
      `| ${i + 1} | ${r.direction} | ${when} | ${from} | [${subj}](#msg-${i + 1}) |`,
    );
  });
  parts.push('');

  rows.forEach((r, i) => {
    const n = i + 1;
    const subj = escMd(r.subject || '(no subject)');
    parts.push(`---\n`);
    parts.push(`## Message ${n}: ${subj} {#msg-${n}}\n`);
    parts.push(`- **id:** \`${r.id}\``);
    parts.push(`- **thread_id:** \`${r.thread_id || ''}\``);
    parts.push(`- **direction:** ${r.direction}`);
    parts.push(`- **from:** ${escMd(r.from_address || '')}`);
    parts.push(`- **to:** ${fmtAddrs(r.to_addresses)}`);
    parts.push(`- **cc:** ${fmtAddrs(r.cc_addresses)}`);
    parts.push(`- **bcc:** ${fmtAddrs(r.bcc_addresses)}`);
    parts.push(`- **received_at:** ${fmtDate(r.received_at)}`);
    parts.push(`- **sent_at:** ${fmtDate(r.sent_at)}`);
    parts.push(`- **created_at:** ${fmtDate(r.created_at)}`);
    parts.push(`- **owner_header_value:** ${escMd(r.owner_header_value || '')}`);
    parts.push(`- **ingest_mailbox_id:** ${escMd(r.ingest_mailbox_id || '')}`);
    parts.push(`- **pop3_uidl:** ${escMd(r.pop3_uidl || '')}`);
    parts.push(`- **raw_mime_s3_key:** ${escMd(r.raw_mime_s3_key || '')}`);
    parts.push('');
    parts.push('### Text body\n');
    if (r.text_body && String(r.text_body).trim()) {
      parts.push(fence(r.text_body, 'text'));
    } else {
      parts.push('_(empty)_\n');
    }
    parts.push('### HTML body\n');
    if (r.html_body && String(r.html_body).trim()) {
      parts.push(fence(r.html_body, 'html'));
    } else {
      parts.push('_(empty)_\n');
    }
  });

  const md = parts.join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md, 'utf8');
  console.log(JSON.stringify({ out, count: rows.length, inbound, outbound, bytes: Buffer.byteLength(md, 'utf8') }));
} finally {
  await sql.end({ timeout: 5 });
}

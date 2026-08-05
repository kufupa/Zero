#!/usr/bin/env node
/**
 * Regroup local centurion-emails-dump.md by thread_id.
 * Read-only on dump; writes centurion-emails-by-thread.md
 */
import fs from 'node:fs';

const SRC = 'centurion-emails-dump.md';
const OUT = 'centurion-emails-by-thread.md';
const md = fs.readFileSync(SRC, 'utf8');

const firstMsg = md.search(/^## Message \d+:/m);
if (firstMsg < 0) throw new Error('no messages found');
const body = md.slice(firstMsg);

const partsRaw = body.split(/(?=^## Message \d+:)/m).map((s) => s.trim()).filter(Boolean);
console.log('blocks', partsRaw.length);

function unwrap(section) {
  if (!section) return { empty: true, content: '', lang: '' };
  let s = section.trim();
  s = s.replace(/\n---\s*$/, '').trim();
  if (s === '_(empty)_') return { empty: true, content: '', lang: '' };
  const fm = s.match(/^```(\w*)\n([\s\S]*?)\n```$/);
  if (fm) return { empty: false, content: fm[2], lang: fm[1] || '' };
  return { empty: false, content: s, lang: '' };
}

function parseBlock(raw, idx) {
  const titleM = raw.match(/^## Message (\d+): (.+?) \{#msg-\d+\}/);
  if (!titleM) {
    throw new Error('bad title at block ' + idx + ': ' + JSON.stringify(raw.slice(0, 100)));
  }
  const origNum = +titleM[1];
  const subject = titleM[2];
  const meta = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^- \*\*([a-z_]+):\*\* (.*)$/);
    if (m) {
      let v = m[2].trim();
      if (v.startsWith('`') && v.endsWith('`')) v = v.slice(1, -1);
      meta[m[1]] = v;
    }
  }
  const textM = raw.match(/### Text body\n\n([\s\S]*?)(?=\n### HTML body)/);
  const htmlM = raw.match(/### HTML body\n\n([\s\S]*?)(?=\n---\s*$|\s*$)/);
  const text = unwrap(textM?.[1]);
  const html = unwrap(htmlM?.[1]);
  const when = meta.received_at || meta.sent_at || meta.created_at || '';
  return { origNum, subject, meta, text, html, when };
}

const messages = partsRaw.map(parseBlock);
console.log('parsed', messages.length);

const byThread = new Map();
for (const m of messages) {
  const tid = m.meta.thread_id || 'NO_THREAD';
  if (!byThread.has(tid)) byThread.set(tid, []);
  byThread.get(tid).push(m);
}

function ts(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

for (const arr of byThread.values()) {
  arr.sort((a, b) => ts(a.when) - ts(b.when) || a.origNum - b.origNum);
}

const threads = [...byThread.entries()].map(([tid, msgs]) => ({
  tid,
  msgs,
  start: msgs[0].when,
  end: msgs[msgs.length - 1].when,
  subject: msgs[0].subject,
  participants: [
    ...new Set(
      msgs.flatMap((m) => {
        const out = [];
        if (m.meta.from) out.push(m.meta.from);
        if (m.meta.to) {
          out.push(
            ...m.meta.to
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          );
        }
        return out;
      }),
    ),
  ],
}));
threads.sort((a, b) => ts(a.start) - ts(b.start) || a.tid.localeCompare(b.tid));

const multi = threads.filter((t) => t.msgs.length > 1);
const single = threads.filter((t) => t.msgs.length === 1);
console.log(
  JSON.stringify(
    {
      threads: threads.length,
      multi_msg_threads: multi.length,
      single_msg_threads: single.length,
      largest: Math.max(...threads.map((t) => t.msgs.length)),
      top_sizes: threads
        .map((t) => t.msgs.length)
        .sort((a, b) => b - a)
        .slice(0, 15),
      multi_subjects: multi.map((t) => ({
        n: t.msgs.length,
        subj: t.subject.slice(0, 70),
      })),
    },
    null,
    2,
  ),
);

function fence(content, lang) {
  const safe = content.replace(/```/g, '``\u200b`');
  return '```' + lang + '\n' + safe + (safe.endsWith('\n') ? '' : '\n') + '```\n';
}

function escCell(s) {
  return String(s || '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

const outParts = [];
outParts.push('# Centurion emails — grouped by thread\n');
outParts.push('');
outParts.push('- Source: local `centurion-emails-dump.md` (no DB)');
outParts.push(`- Regenerated: ${new Date().toISOString()}`);
outParts.push(`- Total messages: **${messages.length}**`);
outParts.push(
  `- Total threads: **${threads.length}** (${multi.length} multi-message, ${single.length} single-message)`,
);
outParts.push(
  '- Order: threads by first message time; messages within thread chronological (`received_at` → `sent_at` → `created_at`)',
);
outParts.push('- Each message keeps full metadata + text/HTML bodies (no attachments/PDFs)');
outParts.push('');
outParts.push('## Thread index\n');
outParts.push('| Thread # | Msgs | First | Last | Subject (first) | From / To (participants) |');
outParts.push('|----------|------|-------|------|-----------------|--------------------------|');

threads.forEach((t, i) => {
  const n = i + 1;
  const flag = t.msgs.length > 1 ? `**${t.msgs.length}**` : '1';
  outParts.push(
    `| [${n}](#thread-${n}) | ${flag} | ${t.start} | ${t.end} | ${escCell(t.subject)} | ${escCell(t.participants.join(' · '))} |`,
  );
});
outParts.push('');
outParts.push('## Multi-message threads only\n');
if (multi.length === 0) {
  outParts.push('_None — every thread has exactly one message._\n');
} else {
  outParts.push('These threads have 2+ emails — read as one conversation.\n');
  outParts.push('| Thread # | Msgs | Subject | thread_id |');
  outParts.push('|----------|------|---------|-----------|');
  threads.forEach((t, i) => {
    if (t.msgs.length < 2) return;
    outParts.push(
      `| [${i + 1}](#thread-${i + 1}) | ${t.msgs.length} | ${escCell(t.subject)} | \`${t.tid}\` |`,
    );
  });
  outParts.push('');
}

threads.forEach((t, i) => {
  const n = i + 1;
  const multiTag =
    t.msgs.length > 1 ? ` — **THREAD (${t.msgs.length} messages)**` : ' — single message';
  outParts.push('---\n');
  outParts.push(`## Thread ${n}${multiTag} {#thread-${n}}\n`);
  outParts.push(`- **thread_id:** \`${t.tid}\``);
  outParts.push(`- **message_count:** ${t.msgs.length}`);
  outParts.push(`- **span:** ${t.start} → ${t.end}`);
  outParts.push(`- **participants:** ${t.participants.join(', ')}`);
  outParts.push('');
  outParts.push('### Thread timeline (send order)\n');
  outParts.push('| # in thread | Dir | When | From | To | Subject |');
  outParts.push('|-------------|-----|------|------|----|---------|');
  t.msgs.forEach((m, j) => {
    outParts.push(
      `| ${j + 1}/${t.msgs.length} | ${m.meta.direction || ''} | ${m.when} | ${escCell(m.meta.from)} | ${escCell(m.meta.to)} | ${escCell(m.subject)} |`,
    );
  });
  outParts.push('');

  t.msgs.forEach((m, j) => {
    outParts.push(
      `### Thread ${n} · msg ${j + 1}/${t.msgs.length}: ${m.subject} {#thread-${n}-msg-${j + 1}}\n`,
    );
    outParts.push(`- **subject:** ${m.subject}`);
    outParts.push(`- **id:** \`${m.meta.id || ''}\``);
    outParts.push(`- **thread_id:** \`${m.meta.thread_id || ''}\``);
    outParts.push(`- **direction:** ${m.meta.direction || ''}`);
    outParts.push(`- **from:** ${m.meta.from || ''}`);
    outParts.push(`- **to:** ${m.meta.to || ''}`);
    outParts.push(`- **cc:** ${m.meta.cc || ''}`);
    outParts.push(`- **bcc:** ${m.meta.bcc || ''}`);
    outParts.push(`- **received_at:** ${m.meta.received_at || ''}`);
    outParts.push(`- **sent_at:** ${m.meta.sent_at || ''}`);
    outParts.push(`- **created_at:** ${m.meta.created_at || ''}`);
    outParts.push(`- **owner_header_value:** ${m.meta.owner_header_value || ''}`);
    outParts.push(`- **ingest_mailbox_id:** ${m.meta.ingest_mailbox_id || ''}`);
    outParts.push(`- **pop3_uidl:** ${m.meta.pop3_uidl || ''}`);
    outParts.push(`- **raw_mime_s3_key:** ${m.meta.raw_mime_s3_key || ''}`);
    outParts.push(`- **orig_dump_msg_num:** ${m.origNum}`);
    outParts.push('');
    outParts.push('#### Text body\n');
    if (!m.text.empty) outParts.push(fence(m.text.content, m.text.lang || 'text'));
    else outParts.push('_(empty)_\n');
    outParts.push('#### HTML body\n');
    if (!m.html.empty) outParts.push(fence(m.html.content, m.html.lang || 'html'));
    else outParts.push('_(empty)_\n');
  });
});

const out = outParts.join('\n');
fs.writeFileSync(OUT, out, 'utf8');
console.log('wrote', OUT, 'bytes', Buffer.byteLength(out), 'lines', out.split('\n').length);

const gi = fs.readFileSync('.gitignore', 'utf8');
if (!gi.includes('centurion-emails-by-thread.md')) {
  fs.appendFileSync('.gitignore', 'centurion-emails-by-thread.md\n');
  console.log('gitignore +by-thread');
}

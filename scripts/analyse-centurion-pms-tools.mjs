#!/usr/bin/env node
/**
 * Fat corpus analysis: Centurion emails → PMS tool demand for AI drafting.
 * Reads local centurion-emails-dump.md (gitignored). Writes:
 *   - docs/infor-hms/centurion-pms-tool-demand-YYYY-MM-DD.md (redacted analysis)
 *   - docs/infor-hms/centurion-outbound-index-YYYY-MM-DD.md (outbound index, subjects only)
 * Never prints full guest bodies to stdout.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'centurion-emails-dump.md';
const ANALYSIS_OUT = 'docs/infor-hms/centurion-pms-tool-demand-2026-08-04.md';
const OUTBOUND_OUT = 'docs/infor-hms/centurion-outbound-index-2026-08-04.md';
const THREAD_OUT = 'docs/infor-hms/centurion-thread-collation-summary-2026-08-04.md';

const md = fs.readFileSync(SRC, 'utf8');
const firstMsg = md.search(/^## Message \d+:/m);
if (firstMsg < 0) throw new Error('no messages');
const body = md.slice(firstMsg);
const partsRaw = body.split(/(?=^## Message \d+:)/m).map((s) => s.trim()).filter(Boolean);

function unwrap(section) {
  if (!section) return '';
  let s = section.trim().replace(/\n---\s*$/, '').trim();
  if (s === '_(empty)_') return '';
  const fm = s.match(/^```(\w*)\n([\s\S]*?)\n```$/);
  return fm ? fm[2] : s;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBlock(raw, idx) {
  const titleM = raw.match(/^## Message (\d+): (.+?) \{#msg-\d+\}/);
  if (!titleM) throw new Error('bad title ' + idx);
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
  const content = (text || stripHtml(html) || '').slice(0, 20000);
  const when = meta.received_at || meta.sent_at || meta.created_at || '';
  return {
    origNum: +titleM[1],
    subject: titleM[2],
    meta,
    content,
    when,
    direction: meta.direction || '',
    threadId: meta.thread_id || 'NO_THREAD',
  };
}

const messages = partsRaw.map(parseBlock);
console.error(JSON.stringify({ parsed: messages.length }));

// --- pattern libraries (fact types needing PMS / external systems) ---
const FACT_PATTERNS = [
  {
    id: 'confirmation_number',
    label: 'Confirmation / reservation number',
    re: /\b(?:conf(?:irmation)?(?:\s*(?:no|number|#|n[°o.]))?|booking\s*(?:ref|id|number)|reservation\s*(?:no|number|#)|n[°o]\s*\d{5,}|conf[#:\s-]*[A-Z0-9-]{5,})\b/i,
    pms: true,
  },
  {
    id: 'external_ref',
    label: 'External / channel reference (OTA, travel agent)',
    re: /\b(?:booking\.com|expedia|agoda|tripadvisor|travelstart|travelport|amadeus|sabre|voucher\s*(?:no|number|#)|external\s*(?:ref|confirmation)|channel\s*ref)\b/i,
    pms: true,
  },
  {
    id: 'guest_name',
    label: 'Guest / lead name for lookup',
    re: /\b(?:guest\s*name|surname|last\s*name|travelling\s+for|booked\s+for|reservation\s+for)\b/i,
    pms: true,
  },
  {
    id: 'stay_dates',
    label: 'Arrival / departure / nights',
    re: /\b(?:check[\s-]?in|check[\s-]?out|arrival|departure|nights?|from\s+\d{1,2}[/.-]\d{1,2}|arriving|departing)\b/i,
    pms: true,
  },
  {
    id: 'room_type',
    label: 'Room type / occupancy',
    re: /\b(?:room\s*type|twin|double|single|suite|family\s*room|executive|standard|deluxe|adults?|children|pax|occupancy)\b/i,
    pms: true,
  },
  {
    id: 'rate_quote',
    label: 'Rate / quote / BAR / package price',
    re: /\b(?:quote|quotation|rate|R\s?\d[\d\s,.]*|ZAR|BAR|rack|package|per\s*night|total\s*(?:cost|amount)|incl(?:usive)?\s*of\s*VAT)\b/i,
    pms: true,
  },
  {
    id: 'availability',
    label: 'Room availability / inventory',
    re: /\b(?:availab(?:le|ility)|rooms?\s+available|sold\s*out|no\s+rooms?|inventory|can\s+you\s+accommodate)\b/i,
    pms: true,
  },
  {
    id: 'reservation_status',
    label: 'Reservation status (confirmed/cancelled/no-show)',
    re: /\b(?:confirm(?:ed|ation)|cancell?(?:ed|ation)|no[\s-]?show|guaranteed|tentative|waitlist|amend(?:ed|ment)|modify|change\s+(?:my|the)\s+(?:booking|reservation))\b/i,
    pms: true,
  },
  {
    id: 'folio_balance',
    label: 'Folio / balance / outstanding amount',
    re: /\b(?:folio|balance|outstanding|amount\s*due|settlement|account\s*balance)\b/i,
    pms: true,
  },
  {
    id: 'invoice_tax',
    label: 'Tax invoice / VAT / pro-forma',
    re: /\b(?:tax\s*invoice|VAT|pro[\s-]?forma|invoice|receipt|credit\s*note)\b/i,
    pms: true,
  },
  {
    id: 'payment_deposit',
    label: 'Payment / deposit / refund',
    re: /\b(?:deposit|payment|paid|refund|pre[\s-]?auth|credit\s*card|EFT|proof\s*of\s*payment|POP)\b/i,
    pms: true,
  },
  {
    id: 'company_bill',
    label: 'Company / agency billing / account',
    re: /\b(?:company\s*account|bill\s*to|corporate|travel\s*agent|agency|on\s*account|purchase\s*order|PO\s*number)\b/i,
    pms: true,
  },
  {
    id: 'group_block',
    label: 'Group / allotment / rooming list',
    re: /\b(?:group|allotment|rooming\s*list|block|series|delegation|conference)\b/i,
    pms: true,
  },
  {
    id: 'event_f_and_b',
    label: 'Event / meeting / F&B',
    re: /\b(?:event|function|banquet|meeting\s*room|catering|F\s*&\s*B|dinner|lunch|breakfast\s*included)\b/i,
    pms: true,
  },
  {
    id: 'room_assignment',
    label: 'Room number / assignment',
    re: /\b(?:room\s*(?:no|number|#)\s*\d+|assigned\s+room|room\s+key)\b/i,
    pms: true,
  },
  {
    id: 'special_requests',
    label: 'Special requests / preferences',
    re: /\b(?:special\s*request|dietary|allergy|accessible|late\s*check[\s-]?out|early\s*check[\s-]?in|extra\s*bed|crib|parking)\b/i,
    pms: true,
  },
  {
    id: 'transport_airport',
    label: 'Airport transfer / shuttle',
    re: /\b(?:transfer|shuttle|airport|collect(?:ion)?|drop[\s-]?off|OR\s*Tambo|Uber)\b/i,
    pms: false,
  },
  {
    id: 'loyalty_membership',
    label: 'Loyalty / membership',
    re: /\b(?:loyalty|member(?:ship)?|frequent|rewards)\b/i,
    pms: true,
  },
  {
    id: 'document_delivery',
    label: 'Confirmation letter / voucher / PDF attach',
    re: /\b(?:confirmation\s*letter|attached|please\s*find\s*attached|voucher|PDF|proforma)\b/i,
    pms: true,
  },
  {
    id: 'sent_email_audit',
    label: 'Prior HMS-sent email / resend',
    re: /\b(?:resend|already\s+sent|did\s+not\s+receive|missing\s+(?:confirmation|invoice)|forward(?:ed)?\s+confirmation)\b/i,
    pms: true,
  },
];

const INTENT_RULES = [
  {
    id: 'quote_request',
    label: 'Stay quote / rate request',
    re: /\b(?:quote|quotation|rates?\s+for|price\s+for|how\s+much|availab).{0,40}(?:night|room|stay|from)|(?:room|stay).{0,40}(?:quote|rate|price)/i,
  },
  {
    id: 'new_booking',
    label: 'New booking request',
    re: /\b(?:book(?:ing)?|reserve|reservation\s+request|would\s+like\s+to\s+(?:book|reserve)|make\s+a\s+reservation)\b/i,
  },
  {
    id: 'amendment',
    label: 'Amend existing reservation',
    re: /\b(?:amend|change|modify|update).{0,30}(?:booking|reservation|dates|room)|(?:dates?|room).{0,20}(?:change|amend)/i,
  },
  {
    id: 'cancellation',
    label: 'Cancellation / refund',
    re: /\b(?:cancel|cancellation|refund)\b/i,
  },
  {
    id: 'confirmation_status',
    label: 'Confirm / status check',
    re: /\b(?:confirm(?:ation)?|status\s+of|do\s+you\s+have|looking\s+for\s+(?:my|the)\s+(?:booking|reservation))\b/i,
  },
  {
    id: 'invoice_docs',
    label: 'Invoice / tax / pro-forma docs',
    re: /\b(?:tax\s*invoice|pro[\s-]?forma|invoice|VAT\s*invoice|receipt)\b/i,
  },
  {
    id: 'payment_ops',
    label: 'Payment / deposit / POP',
    re: /\b(?:proof\s*of\s*payment|POP|deposit|paid|payment\s+link|EFT)\b/i,
  },
  {
    id: 'group_event',
    label: 'Group / event / conference',
    re: /\b(?:group|conference|event|rooming\s*list|allotment|showcase|banquet)\b/i,
  },
  {
    id: 'guest_service',
    label: 'In-stay / post-stay guest service',
    re: /\b(?:complaint|feedback|lost\s+and\s+found|late\s+check|early\s+check|wifi|parking|transport|transfer)\b/i,
  },
  {
    id: 'channel_ota',
    label: 'OTA / channel booking notice',
    re: /\b(?:booking\.com|expedia|agoda|channel\s*manager|new\s+booking\s+from|modification\s+from)\b/i,
  },
  {
    id: 'internal_ops',
    label: 'Internal ops / FW staff mail',
    re: /^(?:FW:|Fwd:)/i,
  },
  {
    id: 'spam_noise',
    label: 'Marketing / spam / newsletter',
    re: /\b(?:unsubscribe|newsletter|marketing|special\s+offer\s+just\s+for\s+you|viagra|crypto)\b/i,
  },
  {
    id: 'confirmation_delivery',
    label: 'Templated confirmation / voucher delivery (outbound)',
    re: /\b(?:confirmation\s*letter|your\s+booking\s+is\s+confirmed|voucher\s+for\s+travel|pro[\s-]?forma)\b/i,
  },
];

function hits(patterns, text) {
  const found = [];
  for (const p of patterns) {
    if (p.re.test(text)) found.push(p.id);
  }
  return found;
}

function classifyMessage(m) {
  const blob = `${m.subject}\n${m.content}`;
  const facts = hits(FACT_PATTERNS, blob);
  const intents = hits(INTENT_RULES, blob);
  const pmsFacts = FACT_PATTERNS.filter((f) => f.pms && facts.includes(f.id)).map((f) => f.id);
  const needsPms = pmsFacts.length > 0 || intents.some((i) =>
    ['quote_request', 'new_booking', 'amendment', 'cancellation', 'confirmation_status', 'invoice_docs', 'payment_ops', 'group_event', 'channel_ota', 'confirmation_delivery'].includes(i),
  );
  return { facts, intents, pmsFacts, needsPms };
}

const classified = messages.map((m) => ({ ...m, ...classifyMessage(m) }));

// threads
const byThread = new Map();
for (const m of classified) {
  if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
  byThread.get(m.threadId).push(m);
}
for (const arr of byThread.values()) {
  arr.sort((a, b) => Date.parse(a.when || 0) - Date.parse(b.when || 0) || a.origNum - b.origNum);
}
const threads = [...byThread.entries()].map(([tid, msgs]) => {
  const hasOut = msgs.some((m) => m.direction === 'outbound');
  const hasIn = msgs.some((m) => m.direction === 'inbound');
  const intents = [...new Set(msgs.flatMap((m) => m.intents))];
  const pmsFacts = [...new Set(msgs.flatMap((m) => m.pmsFacts))];
  const needsPms = msgs.some((m) => m.needsPms);
  return {
    tid,
    n: msgs.length,
    hasOut,
    hasIn,
    intents,
    pmsFacts,
    needsPms,
    subject: msgs[0].subject,
    dirs: msgs.map((m) => m.direction[0]).join(''),
  };
});

const inbound = classified.filter((m) => m.direction === 'inbound');
const outbound = classified.filter((m) => m.direction === 'outbound');

function countBy(arr, keyFn) {
  const c = new Map();
  for (const x of arr) {
    for (const k of keyFn(x)) c.set(k, (c.get(k) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

const msgIntentCounts = countBy(classified, (m) => m.intents);
const _msgFactCounts = countBy(classified, (m) => m.pmsFacts);
const outIntentCounts = countBy(outbound, (m) => m.intents);
const outFactCounts = countBy(outbound, (m) => m.pmsFacts);
const _inIntentCounts = countBy(inbound, (m) => m.intents);
const threadIntentCounts = countBy(threads, (t) => t.intents);
const threadFactCounts = countBy(threads, (t) => t.pmsFacts);

const _draftEligibleThreads = threads.filter((t) => {
  // exclude pure spam/noise-only if no other intents
  if (t.intents.length === 1 && t.intents[0] === 'spam_noise') return false;
  if (t.intents.includes('channel_ota') && !t.hasOut && t.n === 1) return false; // machine notice alone
  return t.hasIn || t.hasOut;
});

const _replyWorthy = threads.filter((t) => t.hasIn);
const withOutbound = threads.filter((t) => t.hasOut);
const multi = threads.filter((t) => t.n > 1);
const pmsNeeding = threads.filter((t) => t.needsPms);

// Tool portfolio inferred from outbound + inbound demand
const TOOL_CATALOG = [
  {
    id: 'hms_find_reservation',
    title: 'Find reservation (Guest Stay search)',
    covers: ['confirmation_number', 'external_ref', 'guest_name', 'stay_dates', 'reservation_status', 'room_type', 'room_assignment'],
    intents: ['confirmation_status', 'amendment', 'cancellation', 'invoice_docs', 'payment_ops', 'guest_service', 'confirmation_delivery', 'channel_ota'],
    phase: 'active_read',
    why: 'Almost every staff reply anchors on an existing stay: confirm number, guest, dates, status.',
  },
  {
    id: 'hms_quote_stay',
    title: 'Quote stay (Room Availability + Display Rates)',
    covers: ['availability', 'rate_quote', 'room_type', 'stay_dates'],
    intents: ['quote_request', 'new_booking'],
    phase: 'active_read',
    why: 'Quote/new-booking inbound needs inventory + displayed rate; never claim bookable.',
  },
  {
    id: 'hms_read_folio',
    title: 'Read folio / balance',
    covers: ['folio_balance', 'payment_deposit', 'invoice_tax'],
    intents: ['payment_ops', 'invoice_docs', 'cancellation'],
    phase: 'roadmap_read',
    why: 'Payment/refund/tax threads need authoritative balances, not guessed amounts.',
  },
  {
    id: 'hms_list_documents',
    title: 'List / fetch confirmation + pro-forma + tax invoice docs',
    covers: ['document_delivery', 'invoice_tax', 'confirmation_number', 'sent_email_audit'],
    intents: ['invoice_docs', 'confirmation_delivery', 'confirmation_status'],
    phase: 'roadmap_read',
    why: 'Outbound corpus is mostly document-delivery wrappers; drafting 100% needs doc lookup/regeneration path.',
  },
  {
    id: 'hms_sent_email_audit',
    title: 'Sent-email audit / resend check',
    covers: ['sent_email_audit', 'document_delivery'],
    intents: ['confirmation_status', 'invoice_docs'],
    phase: 'roadmap_read',
    why: 'Guests ask “did you send confirmation/invoice?” — need HMS sent-mail proof.',
  },
  {
    id: 'hms_group_block_read',
    title: 'Group / allotment / rooming-list read',
    covers: ['group_block', 'room_type', 'stay_dates', 'availability'],
    intents: ['group_event', 'quote_request', 'new_booking'],
    phase: 'roadmap_read',
    why: 'Group/conference threads need block context beyond single Guest Stay row.',
  },
  {
    id: 'hms_event_read',
    title: 'Event / F&B reservation read',
    covers: ['event_f_and_b', 'rate_quote', 'stay_dates'],
    intents: ['group_event', 'quote_request'],
    phase: 'roadmap_read',
    why: 'Showcase/event mails need event package facts separate from room rates.',
  },
  {
    id: 'hms_company_account_read',
    title: 'Company / agency account billing read',
    covers: ['company_bill', 'payment_deposit', 'invoice_tax'],
    intents: ['invoice_docs', 'payment_ops', 'new_booking', 'group_event'],
    phase: 'roadmap_read',
    why: 'Corporate / travel-agent bill-to threads need account eligibility + terms.',
  },
  {
    id: 'mail_read_artifact',
    title: 'Read inbound PDF/attachment text (no OCR)',
    covers: ['document_delivery', 'external_ref', 'confirmation_number', 'payment_deposit'],
    intents: ['payment_ops', 'channel_ota', 'invoice_docs', 'confirmation_status'],
    phase: 'active_read',
    why: 'VOUCHERS, POPs, OTA PDFs carry confirmation/external refs needed before HMS lookup.',
  },
  {
    id: 'hms_guest_preferences_read',
    title: 'Guest preferences / special requests read',
    covers: ['special_requests', 'guest_name'],
    intents: ['guest_service', 'amendment', 'new_booking'],
    phase: 'roadmap_read',
    why: 'Dietary/access/late checkout replies need stored preference facts.',
  },
];

function toolCoverageScore(tool) {
  const factHits = threadFactCounts
    .filter(([id]) => tool.covers.includes(id))
    .reduce((s, [, n]) => s + n, 0);
  const intentHits = threadIntentCounts
    .filter(([id]) => tool.intents.includes(id))
    .reduce((s, [, n]) => s + n, 0);
  return { factHits, intentHits, score: factHits * 2 + intentHits * 3 };
}

const scoredTools = TOOL_CATALOG.map((t) => ({ ...t, ...toolCoverageScore(t) })).sort(
  (a, b) => b.score - a.score,
);

// Denominators for drafting 100% of future replies
const _historicalReplyWorkflows = threads.filter((t) => t.hasOut);
const openInboundNeedingReply = threads.filter(
  (t) => t.hasIn && !t.hasOut && t.needsPms && !t.intents.every((i) => i === 'spam_noise' || i === 'channel_ota'),
);

function pct(n, d) {
  return d === 0 ? '0%' : `${((100 * n) / d).toFixed(1)}%`;
}

function labelOf(id, table) {
  return table.find((x) => x.id === id)?.label || id;
}

function mdTable(rows, headers) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n');
}

const genAt = new Date().toISOString();

// --- outbound index (subjects only; no bodies) ---
const outParts = [];
outParts.push('# Centurion outbound / response index\n');
outParts.push(`- Generated: ${genAt}`);
outParts.push(`- Source dump: local \`centurion-emails-dump.md\` (${messages.length} msgs; RDS read-only 2026-08-04)`);
outParts.push(`- Outbound messages: **${outbound.length}**`);
outParts.push(`- Threads with ≥1 outbound: **${withOutbound.length}**`);
outParts.push('- Bodies omitted here (PII). Full text in gitignored dump / by-thread file.\n');
outParts.push('## Outbound message index\n');
outParts.push(
  mdTable(
    outbound.map((m, i) => [
      String(i + 1),
      m.when.slice(0, 19),
      (m.intents[0] || 'unclassified').replace(/_/g, '\\_'),
      String(m.pmsFacts.length),
      m.subject.replace(/\|/g, '\\|').slice(0, 90),
      `\`${m.threadId.slice(0, 8)}…\``,
    ]),
    ['#', 'When', 'Top intent', 'PMS facts', 'Subject', 'Thread'],
  ),
);
outParts.push('\n## Outbound intent histogram\n');
outParts.push(
  mdTable(
    outIntentCounts.map(([id, n]) => [labelOf(id, INTENT_RULES), String(n), pct(n, outbound.length)]),
    ['Intent', 'Outbound msgs', '% of outbound'],
  ),
);
outParts.push('\n## Outbound PMS-fact histogram\n');
outParts.push(
  mdTable(
    outFactCounts.map(([id, n]) => [labelOf(id, FACT_PATTERNS), String(n), pct(n, outbound.length)]),
    ['PMS fact type', 'Outbound msgs', '% of outbound'],
  ),
);
fs.mkdirSync(path.dirname(OUTBOUND_OUT), { recursive: true });
fs.writeFileSync(OUTBOUND_OUT, outParts.join('\n') + '\n', 'utf8');

// --- thread collation summary ---
const thrParts = [];
thrParts.push('# Centurion thread collation summary\n');
thrParts.push(`- Generated: ${genAt}`);
thrParts.push(`- Messages: **${messages.length}** (${inbound.length} inbound, ${outbound.length} outbound)`);
thrParts.push(`- Threads: **${threads.length}** (${multi.length} multi-message, ${threads.length - multi.length} single)`);
thrParts.push(`- Threads with outbound: **${withOutbound.length}**`);
thrParts.push(`- Threads needing PMS facts: **${pmsNeeding.length}** (${pct(pmsNeeding.length, threads.length)})`);
thrParts.push(`- Full thread bodies: gitignored \`centurion-emails-by-thread.md\`\n`);
thrParts.push('## Size distribution\n');
const sizeHist = new Map();
for (const t of threads) sizeHist.set(t.n, (sizeHist.get(t.n) || 0) + 1);
thrParts.push(
  mdTable(
    [...sizeHist.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, c]) => [String(n), String(c), pct(c, threads.length)]),
    ['Msgs/thread', 'Threads', '%'],
  ),
);
thrParts.push('\n## Direction patterns (I=inbound, O=outbound)\n');
const dirHist = new Map();
for (const t of threads) dirHist.set(t.dirs, (dirHist.get(t.dirs) || 0) + 1);
thrParts.push(
  mdTable(
    [...dirHist.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([d, c]) => [`\`${d}\``, String(c), pct(c, threads.length)]),
    ['Pattern', 'Threads', '%'],
  ),
);
thrParts.push('\n## Top multi-message threads (subjects only)\n');
thrParts.push(
  mdTable(
    multi
      .slice()
      .sort((a, b) => b.n - a.n)
      .slice(0, 40)
      .map((t) => [
        String(t.n),
        `\`${t.dirs}\``,
        t.needsPms ? 'yes' : 'no',
        t.subject.replace(/\|/g, '\\|').slice(0, 80),
      ]),
    ['Msgs', 'Dirs', 'Needs PMS', 'Subject'],
  ),
);
fs.writeFileSync(THREAD_OUT, thrParts.join('\n') + '\n', 'utf8');

// --- main analysis ---
const a = [];
a.push('# Centurion → PMS tool demand analysis (2026-08-04)\n');
a.push('> Read-only corpus analysis. No PMS mutation. Guest bodies stay in gitignored dumps; this doc is aggregates + recommendations.\n');
a.push('## Snapshot\n');
a.push(`- Generated: ${genAt}`);
a.push('- Dump source: pilot RDS `transport-centurion` via `dump-centurion-emails-md.mjs`');
a.push(`- Messages: **${messages.length}** (${inbound.length} inbound / ${outbound.length} outbound)`);
a.push(`- Threads: **${threads.length}**`);
a.push(`- Multi-message threads: **${multi.length}**`);
a.push(`- Threads with staff outbound: **${withOutbound.length}**`);
a.push(`- Threads with ≥1 PMS-fact signal: **${pmsNeeding.length}** (${pct(pmsNeeding.length, threads.length)})`);
a.push('- Prior dumps: 223 msgs (27–29 Jul) → 526 msgs (01 Aug) → 623 msgs (03 Aug) → **812 msgs (04 Aug)**.');
a.push(`- Vs 03 Aug: **+${messages.length - 623} msgs**, +${outbound.length - 72} outbound, +${threads.length - 520} threads.\n`);

a.push('## Method\n');
a.push('1. Refresh flat dump from RDS (read-only).');
a.push('2. Regroup by `thread_id` chronological order → `centurion-emails-by-thread.md`.');
a.push('3. Index all outbound subjects + intent/fact hits.');
a.push('4. Regex-classify every message subject+body for intents and PMS fact types.');
a.push('5. Score tool candidates by thread-level fact/intent coverage.');
a.push('6. Recommend minimum tool portfolio to draft ~100% of reply-worthy Centurion mail.\n');
a.push('Caveat: regex classifiers are recall-oriented; expect some false positives. Counts are demand signals, not exact ops tickets.\n');

a.push('## 1) Artifacts on disk\n');
a.push('| File | Role | Git |');
a.push('| --- | --- | --- |');
a.push('| `centurion-emails-dump.md` | Flat message dump | gitignored |');
a.push('| `centurion-emails-by-thread.md` | Full thread collation | gitignored |');
a.push(`| \`${OUTBOUND_OUT}\` | Outbound index (subjects) | tracked |`);
a.push(`| \`${THREAD_OUT}\` | Thread size/direction summary | tracked |`);
a.push(`| \`${ANALYSIS_OUT}\` | This analysis + tool recs | tracked |\n`);

a.push('## 2) Thread collation\n');
a.push(`- ${threads.length} threads; ${multi.length} conversations (2+ msgs).`);
a.push(`- ${withOutbound.length} threads already have Centurion outbound (historical reply workflows).`);
a.push(`- ${openInboundNeedingReply.length} inbound-only threads still look PMS-reply-worthy (heuristic).`);
a.push(`- See \`${THREAD_OUT}\` for size + I/O pattern histograms.\n`);

a.push('## 3) Outbound / response view\n');
a.push(`- **${outbound.length} outbound messages** across **${withOutbound.length} threads**.`);
a.push('- Dominant pattern still document/confirmation delivery + invoice/tax language.');
a.push(`- Full outbound subject index: \`${OUTBOUND_OUT}\`.\n`);
a.push('### Outbound intent hits\n');
a.push(
  mdTable(
    outIntentCounts.map(([id, n]) => [labelOf(id, INTENT_RULES), String(n), pct(n, outbound.length)]),
    ['Intent', 'Msgs', '% outbound'],
  ),
);
a.push('\n### Outbound PMS facts\n');
a.push(
  mdTable(
    outFactCounts.map(([id, n]) => [labelOf(id, FACT_PATTERNS), String(n), pct(n, outbound.length)]),
    ['Fact', 'Msgs', '% outbound'],
  ),
);

a.push('\n## 4) Whole-corpus intent demand (all messages)\n');
a.push(
  mdTable(
    msgIntentCounts.map(([id, n]) => [labelOf(id, INTENT_RULES), String(n), pct(n, messages.length)]),
    ['Intent', 'Msgs', '% msgs'],
  ),
);
a.push('\n### Thread-level intents\n');
a.push(
  mdTable(
    threadIntentCounts.map(([id, n]) => [labelOf(id, INTENT_RULES), String(n), pct(n, threads.length)]),
    ['Intent', 'Threads', '% threads'],
  ),
);

a.push('\n## 5) PMS field / access requirements\n');
a.push('Facts an external PMS (Infor HMS) must supply if agent drafts replies without inventing numbers:\n');
a.push(
  mdTable(
    threadFactCounts.map(([id, n]) => {
      const row = FACT_PATTERNS.find((f) => f.id === id);
      return [row?.label || id, String(n), pct(n, threads.length), row?.pms ? 'PMS' : 'other'];
    }),
    ['Fact type', 'Threads', '% threads', 'Source'],
  ),
);
a.push('\n### Field groups → Infor surfaces\n');
a.push('| Needed fields | Likely Infor surface | Notes |');
a.push('| --- | --- | --- |');
a.push('| confirmation, external ref, guest, dates, status, room type | Guest Stay / OSRESS.search | Live not-found canary already proven |');
a.push('| availability counts by date/room | Room Availability | Read-only inventory; never CRS Check Availability |');
a.push('| rate amount, plan, inclusions, currency | Display Rates | Separate from inventory; `bookable=false` |');
a.push('| folio balance, deposits, settlements | Folios / Advance Deposit | Roadmap read |');
a.push('| tax invoice / pro-forma / confirmation PDF | Property documents / Sent Email | Outbound corpus is wrapper-heavy |');
a.push('| company bill-to, agency terms | Profiles / AR accounts | Corporate + TA mail |');
a.push('| group block, rooming list | Group Booking / blocks | Conference/showcase threads |');
a.push('| event package / F&B | Event Reservations | Event quote threads |');
a.push('| prior outbound proof | Sent Email audit | “Did you send…?” |');
a.push('| voucher/POP text | Mail attachment text extract | Not PMS, but blocks HMS lookup |\n');

a.push('## 6) Recommended common tools for 100% drafting coverage\n');
a.push('Goal: AI drafting agent can answer **every reply-worthy Centurion thread** with cited facts (HITL send still required).\n');
a.push('Score = `2×thread_fact_hits + 3×thread_intent_hits` from this corpus.\n');
a.push(
  mdTable(
    scoredTools.map((t, i) => [
      String(i + 1),
      `\`${t.id}\``,
      t.title,
      t.phase,
      String(t.score),
      String(t.intentHits),
      String(t.factHits),
    ]),
    ['Rank', 'Tool', 'Title', 'Phase', 'Score', 'Intent hits', 'Fact hits'],
  ),
);

a.push('\n### Must-have now (covers drafting wedge)\n');
a.push('1. **`hms_find_reservation`** — Guest Stay real search + row parse. Without this, agent cannot ground confirmations, amendments, invoices, or “where is my booking?”.');
a.push('2. **`hms_quote_stay`** — Availability + Display Rates as separate observations. Required for quote/new-booking inbound.');
a.push('3. **`mail_read_artifact`** — Already in foundation; keep. Many inbound vouchers/POPs carry the only confirmation/external ref.');
a.push('4. **`hms_list_documents` + attach path** — Outbound history shows staff replies are often confirmation/pro-forma delivery, not bespoke essays. Drafting 100% of *sent shape* needs document lookup/generation, not just prose.\n');

a.push('### Next wave (unlock invoice/payment/group)\n');
a.push('5. **`hms_read_folio`** — balances, deposits, refunds.');
a.push('6. **`hms_sent_email_audit`** — prove prior send / support resend decisions.');
a.push('7. **`hms_company_account_read`** — corporate/TA bill-to.');
a.push('8. **`hms_group_block_read`** + **`hms_event_read`** — group/conference/showcase.\n');

a.push('### Explicitly not in autonomous discovery\n');
a.push('- CRS Check Availability (creates reservation).');
a.push('- Any save/create/amend/cancel/post/settle/refund/send write.');
a.push('- Live write-form exploration.\n');

a.push('## Coverage story vs prior dumps\n');
a.push('| Metric | 27–29 Jul | 01 Aug | 03 Aug |');
a.push('| --- | --- | --- | --- |');
a.push(`| Messages | 223 | 526 | ${messages.length} |`);
a.push(`| Threads | 193 | 434 | ${threads.length} |`);
a.push(`| Outbound msgs | 26 | 68 | ${outbound.length} |`);
a.push(`| Threads w/ outbound | ~26 | 68 | ${withOutbound.length} |`);
a.push(`| Threads w/ PMS signal | n/a | 390 | ${pmsNeeding.length} |`);
a.push(`| Open inbound needing reply | n/a | 272 | ${openInboundNeedingReply.length} |`);
a.push('');
a.push('Foundation three tools (`find_reservation`, `quote_stay`, `mail_read_artifact`) still cover **lookup + quote + attachment** — the evidence core.');
a.push('They do **not** complete document-delivery outbound, folio/tax, group/event, or company billing alone.');
a.push('For “draft 100% of emails,” treat **document list/fetch** and **folio read** as equal priority after live Guest Stay adapter works.\n');

a.push('## Practical build order (aligned to live ladder)\n');
a.push('1. Live Guest Stay adapter + worker Playwright session + shadow real reads (steps 4–6).');
a.push('2. Harden quote path on live Room Availability + Display Rates (still read-only).');
a.push('3. Document list/fetch read + outbound-shaped draft templates.');
a.push('4. Folio + sent-email audit reads.');
a.push('5. Group/event/company account reads.');
a.push('6. Only then human-supervised write tools (create/amend/cancel/send docs).\n');

a.push('## Safety reminder\n');
a.push('- Analysis used mail corpus + classifiers only.');
a.push('- Live PMS: read exploration OK; **no writes / no side-effecting clicks**.');
a.push('- Do not commit gitignored dumps (PII).\n');

fs.writeFileSync(ANALYSIS_OUT, a.join('\n') + '\n', 'utf8');

/** Mutually exclusive primary-intent buckets — opaque thread IDs only (no body/subject). */
const INTENT_PRIORITY = [
  'quote_request',
  'new_booking',
  'confirmation_status',
  'amendment',
  'cancellation',
  'payment_ops',
  'invoice_docs',
  'group_event',
  'guest_service',
  'confirmation_delivery',
  'channel_ota',
  'spam_noise',
];
const membershipBuckets = Object.fromEntries(INTENT_PRIORITY.map((k) => [k, []]));
const membershipUncovered = [];
for (const t of threads) {
  const primary = INTENT_PRIORITY.find((intent) => t.intents.includes(intent));
  if (!primary) {
    membershipUncovered.push(t.tid);
    continue;
  }
  membershipBuckets[primary].push(t.tid);
}
const MEMBERSHIP_OUT = path.join(OUT_DIR, 'centurion-intent-membership-nonoverlap.json');
fs.writeFileSync(
  MEMBERSHIP_OUT,
  JSON.stringify(
    {
      schemaVersion: 1,
      note: 'Non-overlapping primary-intent membership. Opaque thread IDs only. Do not sum keyword %.',
      priority: INTENT_PRIORITY,
      totals: Object.fromEntries([
        ...INTENT_PRIORITY.map((k) => [k, membershipBuckets[k].length]),
        ['uncovered', membershipUncovered.length],
      ]),
      buckets: membershipBuckets,
      uncovered: membershipUncovered,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

const summary = {
  messages: messages.length,
  inbound: inbound.length,
  outbound: outbound.length,
  threads: threads.length,
  multiMessageThreads: multi.length,
  withOutbound: withOutbound.length,
  pmsNeeding: pmsNeeding.length,
  openInboundNeedingReply: openInboundNeedingReply.length,
  topTools: scoredTools.slice(0, 8).map((t) => ({ id: t.id, score: t.score, phase: t.phase })),
  wrote: [ANALYSIS_OUT, OUTBOUND_OUT, THREAD_OUT, MEMBERSHIP_OUT],
};
console.log(JSON.stringify(summary, null, 2));

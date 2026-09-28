/**
 * Private helper: choose the first paired corpus thread whose latest
 * inbound message contains exactly one usable reservation lookup candidate
 * (confirmation/external reference, or surname + both stay dates).
 * The resulting packet contains the actual incoming body and reply metadata;
 * it is written only to a mode-600 private path for the EC2 runner.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const corpus = process.argv[2];
const outPath = process.argv[3];
const offset = Number.parseInt(process.argv[4] ?? '0', 10);
if (!corpus || !outPath || !Number.isInteger(offset) || offset < 0) {
  throw new Error('usage: hms-connected-case-from-corpus <corpus.jsonl> <out.json> [offset]');
}

const patterns = [
  /\b(?:confirmation|conf(?:irmation)?\s*(?:#|no\.?|number)?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/gi,
  /\b(?:booking|reservation|stay)\s+reference(?:\s*(?:number|no\.?|#))?\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
  /\breference\s*(?:number|no\.?|#)\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
  /\breference\s*\([^\n)]{0,96}\)\s*[*]?\s*[:#-]\s*([A-Z0-9][A-Z0-9-]{4,31})\b/gi,
  /\b(CONF-[A-Z0-9-]{2,28})\b/gi,
  /\bn[°ºo]\s*([0-9]{6,14}(?:-\d{1,4})?)\b/gi,
];
const surnameDatesPattern =
  /\b(?:guest|mr\.?|mrs\.?|ms\.?|surname)?\s*([A-Z][a-z]{1,40})\s+(?:arriv(?:ing|al)|check[- ]?in)\s+(\d{4}-\d{2}-\d{2})\s+(?:depart(?:ing|ure)|check[- ]?out)\s+(\d{4}-\d{2}-\d{2})\b/gi;
const naturalCheckDatesPattern =
  /\bcheck[- ]?in\s*[:=-]?\s*(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?\s*,?\s*(?:and\s+)?check[- ]?out\s*[:=-]?\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/gi;
const naturalNameLinePattern =
  /^\s*>?\s*(?:\d+[.)-]\s+|(?:guest|guest\s+name|surname|name)\s*[:=-]\s+)(?:(?:[A-Z][a-z]{1,40}|[A-Z](?:\.[A-Z])?\.?)\s+){0,3}([A-Z][a-z]{2,40})\.?\s*$/i;
const monthNumbers = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

function naturalDate(day, month, year) {
  if (!year) return null;
  const monthNumber = monthNumbers[month.slice(0, 3).toUpperCase()];
  const dayNumber = Number(day);
  if (!monthNumber || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  const value = `${year}-${monthNumber}-${String(dayNumber).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function appendNaturalSurnameDates(text, output) {
  naturalCheckDatesPattern.lastIndex = 0;
  let match;
  while ((match = naturalCheckDatesPattern.exec(text))) {
    const year = match[3] ?? match[6];
    const arrival = naturalDate(match[1], match[2], year);
    const departure = naturalDate(match[4], match[5], match[6]);
    if (!arrival || !departure || departure <= arrival) continue;
    const prefix = text.slice(Math.max(0, match.index - 640), match.index);
    for (const line of prefix.split(/\r?\n/).slice(-10)) {
      const nameMatch = naturalNameLinePattern.exec(line);
      if (!nameMatch) continue;
      const candidate = `${nameMatch[1]}|${arrival}|${departure}`;
      if (!output.includes(candidate)) output.push(candidate);
    }
  }
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareRowsChronologically(left, right) {
  const leftMs = timestampMs(left.timestamp);
  const rightMs = timestampMs(right.timestamp);
  if (leftMs !== null && rightMs !== null && leftMs !== rightMs) return leftMs - rightMs;
  return left.timestamp.localeCompare(right.timestamp);
}

let selected = null;
let qualifying = 0;
for (const line of readFileSync(corpus, 'utf8').split('\n')) {
  if (!line) continue;
  const thread = JSON.parse(line);
  if (thread.recordType !== 'thread') continue;
  const rows = [];
  for (const message of thread.messages ?? []) {
    for (const sourceRow of message.sourceRows ?? []) {
      const privateMessage = sourceRow.privateMessage ?? {};
      rows.push({
        // Preserve a provider message ID only when the corpus actually has
        // one. sourceRowId is an internal row key, not incoming provenance.
        id: sourceRow.messageId ?? privateMessage.canonicalHeaders?.['Message-ID']?.[0],
        direction: privateMessage.direction,
        timestamp: sourceRow.receivedAt ?? message.timestamp,
        body: sourceRow.body ?? '',
        subject: privateMessage.subject ?? '',
        sender: privateMessage.addresses?.from?.[0] ?? '',
      });
    }
  }
  const outbound = rows
    .filter((row) => row.direction === 'outbound' && row.id && timestampMs(row.timestamp) !== null)
    .sort(compareRowsChronologically);
  if (!outbound.length) continue;
  const reply = outbound.at(-1);
  const incoming = rows
    .filter((row) => {
      const rowMs = timestampMs(row.timestamp);
      const replyMs = timestampMs(reply.timestamp);
      return row.direction === 'inbound' && rowMs !== null && replyMs !== null && rowMs <= replyMs;
    })
    .sort(compareRowsChronologically)
    .at(-1);
  if (!incoming) continue;
  const incomingMs = timestampMs(incoming.timestamp);
  const replyMs = timestampMs(reply.timestamp);
  if (incomingMs === null || replyMs === null || replyMs < incomingMs) continue;

  const values = [];
  const surnameDates = [];
  // The runner's lookup extractor receives only this incoming body. Subject
  // text and hotel reply metadata cannot become a hidden answer seed.
  const text = incoming.body;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const value = String(match[1]).toUpperCase();
      if (/\d/.test(value) && value.length >= 6 && !values.includes(value)) values.push(value);
    }
  }
  surnameDatesPattern.lastIndex = 0;
  let surnameMatch;
  while ((surnameMatch = surnameDatesPattern.exec(text))) {
    const candidate = `${surnameMatch[1]}|${surnameMatch[2]}|${surnameMatch[3]}`;
    if (!surnameDates.includes(candidate)) surnameDates.push(candidate);
  }
  appendNaturalSurnameDates(text, surnameDates);
  // Exact references win over incidental surname/date phrases. If none are
  // present, admit exactly one surname/date candidate; never guess between
  // multiple candidates.
  if (values.length > 1 || (values.length === 0 && surnameDates.length !== 1)) continue;
  if (qualifying++ < offset) continue;
  selected = {
    schemaVersion: 'connected-read-case/v1',
    caseId: `CORPUS-${thread.threadId}`,
    propertyCode: 'HRCEN',
    incoming: {
      body: incoming.body,
      subject: incoming.subject,
      sender: incoming.sender,
      timestamp: incoming.timestamp,
      ...(incoming.id ? { messageId: incoming.id } : {}),
    },
    pairedReply: { messageId: reply.id, timestamp: reply.timestamp },
  };
  break;
}

if (!selected) throw new Error('no unique connected exact candidate found');
writeFileSync(outPath, JSON.stringify(selected), { mode: 0o600 });
console.log(JSON.stringify({ status: 'selected', caseId: selected.caseId, output: outPath }));

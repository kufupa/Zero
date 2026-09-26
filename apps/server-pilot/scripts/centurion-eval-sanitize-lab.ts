/** Drop illegal spans, enum-only interesting, enrich prior inbounds + PDF text. Counts on stdout. No PII. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  coerceRequest,
  harvestStayDates,
  interestingFacts,
  isGoldFieldName,
  rewriteDateSpan,
  splitStayAsks,
  stayAskRecord,
  type SpanHit,
} from '../src/ops/centurion-eval-lab.ts';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const SNAP = path.join(
  DEMAND,
  '../../connected-mailbox-corpus/centurion-nine-day-4a8bb7ad-2d78-4d9a-92b2-9a5f31d2dd67/messages.jsonl',
);

function loadJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadJsonl(filePath: string) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isOut(row: { direction?: string; businessDirection?: string; confirmedOutbound?: boolean }) {
  return row.direction === 'outbound' || row.businessDirection === 'outbound' || row.confirmedOutbound === true;
}

const indexPath = path.join(DEMAND, 'lab/index.json');
const index = loadJson(indexPath);
const messages = loadJsonl(SNAP);
const byThread = new Map<string, typeof messages>();
for (const row of messages) {
  const threadId = String(row.threadId || '');
  if (!threadId) continue;
  if (!byThread.has(threadId)) byThread.set(threadId, []);
  byThread.get(threadId)!.push(row);
}

const attachByInbound = new Map<string, string>();
for (let i = 0; i < 5; i += 1) {
  for (const row of loadJsonl(path.join(DEMAND, 'shards', `pass6-${i}-bodies.jsonl`))) {
    const texts = (row.artifacts || [])
      .map((item: { textExtract?: string }) => item.textExtract || '')
      .join('\n')
      .trim();
    if (texts) attachByInbound.set(String(row.inboundId), texts.slice(0, 8000));
  }
}

let droppedSpans = 0;
let keptSpans = 0;
let interestingDropped = 0;
let withPrior = 0;
let withAttachText = 0;
let stayAskRows = 0;
let stayAskTotal = 0;
let roomQtyYearsDropped = 0;
let arrayDeparturesDropped = 0;

for (const row of index.rows) {
  const inboundText = String(row.inbound?.textBody || '');
  const goldText = String(row.gold?.textBody || '');
  const nextSpans: SpanHit[] = [];
  for (const span of row.spans || []) {
    if (!isGoldFieldName(span.field)) {
      droppedSpans += 1;
      continue;
    }
    const text = span.side === 'gold' ? goldText : inboundText;
    const rewritten = rewriteDateSpan(text, span);
    if (rewritten.end > text.length || rewritten.start >= rewritten.end) {
      droppedSpans += 1;
      continue;
    }
    nextSpans.push(rewritten);
    keptSpans += 1;
  }
  row.spans = nextSpans;
  const before = (row.staffFilledAbsentFromInbound || []).length;
  row.staffFilledAbsentFromInbound = interestingFacts(row.staffFilledAbsentFromInbound);
  interestingDropped += Math.max(0, before - row.staffFilledAbsentFromInbound.length);

  if (!row.request || typeof row.request !== 'object' || Array.isArray(row.request)) row.request = {};
  const used =
    row.usedResult && typeof row.usedResult === 'object' && !Array.isArray(row.usedResult)
      ? { ...(row.usedResult as Record<string, unknown>) }
      : {};
  for (const key of ['confirmationNumber', 'guestName', 'arrival', 'departure'] as const) {
    if (row.request[key] != null && used[key] != null && String(row.request[key]).trim() === String(used[key]).trim()) {
      delete used[key];
    }
  }
  row.usedResult = used;

  const threadId = String(row.threadId || '');
  const inboundId = String(row.inboundId || '');
  const eventAt = Date.parse(String(row.eventAt || '')) || 0;
  const priors = (byThread.get(threadId) || [])
    .filter((item) => !isOut(item) && String(item.id) !== inboundId)
    .filter((item) => {
      const at = Date.parse(String(item.eventAt || '')) || 0;
      return !eventAt || !at || at < eventAt;
    })
    .sort((a, b) => (Date.parse(String(a.eventAt || '')) || 0) - (Date.parse(String(b.eventAt || '')) || 0))
    .slice(-4)
    .map((item) => ({
      id: String(item.id),
      subject: item.subject ?? null,
      textBody: String(item.textBody || item.htmlBody || '').slice(0, 4000),
    }));
  row.priorInbounds = priors;
  if (priors.length) withPrior += 1;
  const attachRaw = attachByInbound.get(inboundId) || '';
  const attach = attachRaw.trimStart().startsWith('%PDF') ? '' : attachRaw;
  row.attachmentText = attach;
  if (attach) withAttachText += 1;
  const harvested = harvestStayDates(
    `${inboundText}\n${attach}\n${priors.map((item) => item.textBody || '').join('\n')}`,
  );
  if (!row.request.arrival && harvested.arrival) row.request.arrival = harvested.arrival;
  if (!row.request.departure && harvested.departure) row.request.departure = harvested.departure;
  const hay = `${inboundText}\n${attach}\n${priors.map((item) => item.textBody || '').join('\n')}`;
  const asks = splitStayAsks(hay);
  const rawQty = row.request.roomQty;
  if (rawQty != null && /^(?:19|20)\d{2}$/.test(String(rawQty).trim())) roomQtyYearsDropped += 1;
  if (Array.isArray(row.request.departure) || String(row.request.departure || '').trim().startsWith('[')) {
    arrayDeparturesDropped += 1;
  }
  row.stayAsks = asks;
  if (asks.length) stayAskRows += 1;
  stayAskTotal += asks.length;
  row.request = coerceRequest({ ...row.request, ...stayAskRecord(asks[0]) });
  const neededTools = Object.entries(row.needed || {})
    .filter(([, wanted]) => wanted)
    .map(([tool]) => tool)
    .slice(0, 4);
  const otherDesk = Boolean(row.otherDesk) || row.threadOutcome === 'other_desk';
  const skipEmpty =
    otherDesk ||
    ((row.threadOutcome === 'no_reply_owed' || row.channelAuto) && asks.length === 0 && neededTools.length === 0);
  if (skipEmpty) {
    row.proposedActions = [];
  } else if (asks.length) {
    const quotes = asks.map((ask, index) => ({
      tool: 'hms_quote_stay',
      title: 'Quote stay',
      status: 'live',
      colorIndex: index % 4,
      request: coerceRequest(stayAskRecord(ask)),
    }));
    const extras = [];
    for (const tool of ['hms_find_reservation', 'hms_read_reservation'] as const) {
      if (quotes.some((item) => item.tool === tool)) continue;
      if (row.needed?.[tool] || (row.tools || []).includes(tool)) {
        extras.push({
          tool,
          title: tool === 'hms_find_reservation' ? 'Find reservation' : 'Read reservation',
          status: 'live',
          colorIndex: 0,
          request: coerceRequest(row.request || {}),
        });
      }
    }
    row.proposedActions = [...quotes, ...extras].map((item, index) => ({ ...item, colorIndex: index % 4 }));
  } else {
    row.proposedActions = neededTools.map((tool, index) => ({
      tool,
      title: tool === 'hms_quote_stay' ? 'Quote stay' : tool.replace(/^hms_/, '').replaceAll('_', ' '),
      status: 'live',
      colorIndex: index % 4,
      request: coerceRequest(row.request || {}),
    }));
  }
}

writeFileSync(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify({
    rows: index.rows.length,
    droppedSpans,
    keptSpans,
    interestingDropped,
    withPrior,
    withAttachText,
    stayAskRows,
    stayAskTotal,
    roomQtyYearsDropped,
    arrayDeparturesDropped,
  }),
);

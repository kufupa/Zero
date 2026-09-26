/** Patch lab index with staffUsed flags + located spans. Copies public JSON. Counts on stdout. No PII. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { locateQuoteSpans, rehydrateMailText, harvestStayDates, type QuoteMissReason } from '../src/ops/centurion-eval-lab.ts';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const ROOT = path.resolve(DEMAND, '../../..');
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

function mailText(row: { textBody?: string; htmlBody?: string } | null | undefined) {
  return String(row?.textBody || row?.htmlBody || '');
}

const snapById = new Map<string, string>();
for (const row of loadJsonl(SNAP)) {
  const id = String(row.id || '');
  if (!id) continue;
  snapById.set(id, mailText(row));
}

const indexPath = path.join(DEMAND, 'lab/index.json');
const index = loadJson(indexPath);
const valueReread = new Map(
  [
    ...loadJsonl(path.join(DEMAND, 'extracts/value-reread-canonical.jsonl')),
    ...loadJsonl(path.join(DEMAND, 'extracts/value-reread2-canonical.jsonl')),
  ].map((row) => [row.inboundId, row]),
);
const gold = new Map(
  loadJsonl(path.join(DEMAND, 'extracts/gold-oracle-canonical.jsonl')).map((row) => [row.inboundId, row]),
);
const gap = new Map(
  loadJsonl(path.join(DEMAND, 'extracts/true-gap-canonical.jsonl')).map((row) => [row.inboundId, row]),
);
const staffFile = existsSync(path.join(DEMAND, 'truth/staff-used.json'))
  ? loadJson(path.join(DEMAND, 'truth/staff-used.json'))
  : { staffUsed: {}, rows: {} };

let spanned = 0;
const byReason: Record<QuoteMissReason, number> = {
  empty_quote: 0,
  empty_body: 0,
  not_in_body: 0,
  bad_field: 0,
  whole_body: 0,
};

for (const row of index.rows) {
  const extra = valueReread.get(row.inboundId) || gold.get(row.inboundId) || gap.get(row.inboundId);
  if (!extra) continue;
  if (extra.staffUsed) row.staffUsed = extra.staffUsed;
  if (extra.request && Object.keys(extra.request).length) row.request = extra.request;
  if (extra.usedResult && Object.keys(extra.usedResult).length) row.usedResult = extra.usedResult;
  if (extra.staffFilledAbsentFromInbound?.length) {
    row.staffFilledAbsentFromInbound = extra.staffFilledAbsentFromInbound;
  }
  if (!row.inbound) row.inbound = { subject: null, textBody: '' };
  if (row.gold && !row.gold.textBody) row.gold.textBody = '';
  row.inbound.textBody = rehydrateMailText(row.inbound.textBody, snapById.get(String(row.inboundId)));
  if (row.gold?.id) {
    row.gold.textBody = rehydrateMailText(row.gold.textBody, snapById.get(String(row.gold.id)));
  }
  const haystack = [
    row.inbound.textBody || '',
    row.attachmentText || '',
    ...((row.priorInbounds || []).map((item: { textBody?: string }) => item.textBody || '')),
  ].join('\n');
  const harvested = harvestStayDates(haystack);
  if (!row.request || typeof row.request !== 'object' || Array.isArray(row.request)) row.request = {};
  const quotes = [...(extra.quotes || [])];
  for (const field of ['arrival', 'departure'] as const) {
    if (row.request[field] || !harvested[field]) continue;
    row.request[field] = harvested[field];
    quotes.push({ field, side: 'inbound', quote: harvested[field] });
  }
  const inboundQuotes = quotes.filter((item: { side?: string }) => item.side !== 'gold');
  const goldQuotes = quotes.filter((item: { side?: string }) => item.side === 'gold');
  const locatedIn = locateQuoteSpans(row.inbound.textBody || '', inboundQuotes);
  const locatedGold = locateQuoteSpans(
    row.gold?.textBody || '',
    goldQuotes.map((item: object) => ({ ...item, side: 'gold' as const })),
  );
  row.spans = [...locatedIn.spans, ...locatedGold.spans];
  const misses = [...locatedIn.unresolved, ...locatedGold.unresolved];
  row.unresolvedQuoteMisses = misses;
  row.unresolvedFields = misses.map((miss) => miss.field).filter(Boolean);
  if (row.spans.length) spanned += 1;
  for (const miss of misses) byReason[miss.reason] += 1;
}

if (Array.isArray(index.neededCounts)) {
  for (const item of index.neededCounts) {
    item.staffUsedCount = staffFile.staffUsed?.[item.tool] ?? staffFile.rows?.[item.tool]?.staffUsedCount;
  }
}

writeFileSync(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
if (process.env.LAB_WRITE_PUBLIC_INDEX === '1') {
  copyFileSync(indexPath, path.join(ROOT, 'apps/mail/public/lab-centurion-index.json'));
}
const unresolved = Object.values(byReason).reduce((n, v) => n + v, 0);
console.log(
  JSON.stringify({
    rows: index.rows.length,
    spanned,
    unresolved,
    byReason,
    lunaFieldFix: byReason.bad_field,
    public: process.env.LAB_WRITE_PUBLIC_INDEX === '1',
  }),
);

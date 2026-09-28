/** Counts-only quote gate. No mail bodies on stdout. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { quoteGateFlags, routeQuoteRequest, type QuoteGateFlag } from '../../mail/lib/lab/quote-stay-route.ts';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';

const index = JSON.parse(readFileSync(path.join(DEMAND, 'lab/index.json'), 'utf8')) as {
  rows: Array<{
    inboundId?: string;
    attachmentText?: string;
    proposedActions?: Array<{ tool?: string; status?: string; request?: Record<string, unknown> }>;
  }>;
};

const pdfText = new Map<string, string>();
const shardDir = path.join(DEMAND, 'shards');
for (const name of ['0', '1', '2', '3', '4']) {
  const file = path.join(shardDir, `pass6-${name}-bodies.jsonl`);
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { inboundId?: string; artifacts?: Array<{ textExtract?: string }> };
    if (!row.inboundId) continue;
    const text = (row.artifacts || []).map((artifact) => artifact.textExtract || '').join('\n');
    if (text.trim() && !text.trimStart().startsWith('%PDF')) pdfText.set(row.inboundId, text);
  }
}
const layoutDir = path.join(DEMAND, 'review/quote-pdf-layout');
try {
  for (const name of readdirSync(layoutDir)) {
    if (!name.endsWith('.txt')) continue;
    const text = readFileSync(path.join(layoutDir, name), 'utf8');
    if (text.trim() && !text.trimStart().startsWith('%PDF')) pdfText.set(name.slice(0, -4), text);
  }
} catch {
  // layout dir optional
}

const absentPath = path.join(DEMAND, 'review/quote-pdf-source-absent.json');
let absent = new Set<string>();
try {
  const parsed = JSON.parse(readFileSync(absentPath, 'utf8')) as { inboundIds?: string[] };
  absent = new Set(parsed.inboundIds || []);
} catch {
  absent = new Set();
}

const ids: Record<QuoteGateFlag, string[]> = {
  UNREAD_PDF: [],
  BAD_ROOM: [],
  FAKE_PAX: [],
  YEAR_QTY: [],
  INVENTED_MONEY: [],
};

const blank = (): Record<QuoteGateFlag, number> => ({
  UNREAD_PDF: 0,
  BAD_ROOM: 0,
  FAKE_PAX: 0,
  YEAR_QTY: 0,
  INVENTED_MONEY: 0,
});
const stored = blank();
const withPdfCounts = blank();
const afterRoute = blank();

let quoteRows = 0;
let pdfJoined = 0;
let sourceAbsent = 0;
for (const row of index.rows || []) {
  const live = (row.proposedActions || []).some(
    (action) => action.tool === 'hms_quote_stay' && (action.status === 'live' || action.status === 'needs_human'),
  );
  if (!live) continue;
  quoteRows += 1;
  const joinedText = pdfText.get(row.inboundId || '');
  const withPdf = joinedText ? { ...row, attachmentText: row.attachmentText || joinedText } : row;
  if (joinedText) pdfJoined += 1;
  const routed = {
    ...withPdf,
    proposedActions: (withPdf.proposedActions || []).map((action) =>
      action.tool === 'hms_quote_stay' ? { ...action, request: routeQuoteRequest(action.request || {}) } : action,
    ),
  };
  for (const flag of quoteGateFlags(row)) {
    stored[flag] += 1;
    if (row.inboundId && ids[flag].length < 25) ids[flag].push(row.inboundId);
  }
  const pdfFlags = quoteGateFlags(withPdf).filter((flag) => {
    if (flag === 'UNREAD_PDF' && row.inboundId && absent.has(row.inboundId)) {
      sourceAbsent += 1;
      return false;
    }
    return true;
  });
  for (const flag of pdfFlags) withPdfCounts[flag] += 1;
  for (const flag of quoteGateFlags(routed)) {
    if (flag === 'UNREAD_PDF' && row.inboundId && absent.has(row.inboundId)) continue;
    afterRoute[flag] += 1;
  }
}

const out = {
  quoteRows,
  pdfTextRows: pdfText.size,
  pdfJoined,
  sourceAbsent,
  stored,
  withPdf: withPdfCounts,
  afterRoute,
};
console.log(JSON.stringify(out));
const review = path.join(DEMAND, 'review');
mkdirSync(review, { recursive: true });
writeFileSync(path.join(review, 'quote-gate-1.json'), `${JSON.stringify({ ...out, ids }, null, 2)}\n`);

#!/usr/bin/env node
/** Counts-only QA of Luna jsonl extracts. No PII on stdout. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ENUM = new Set([
  'confirmationNumber',
  'guestName',
  'arrival',
  'departure',
  'adults',
  'children',
  'paxTotal',
  'roomType',
  'rateCode',
  'amount',
  'attachmentName',
  'cancelReason',
  'occupancy',
  'roomQty',
  'groupName',
  'rateQuoted',
  'status',
  'docType',
]);
const FIND_KEYS = new Set(['confirmationNumber', 'guestName', 'arrival', 'departure']);
const DATE_PREFIX = /^(check[- ]?in|check[- ]?out)\s*:?\s*/i;
const GREET = /^(good\s+day|from:|-----original)/i;
const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2] || 'value-reread';
const SHARDS = Number(process.argv[3] || 7);

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _parseError: true };
      }
    });
}

const summary = {
  pass: PASS,
  shards: [],
  totals: {
    rows: 0,
    parseErrors: 0,
    illegalQuoteFields: 0,
    shortQuotes: 0,
    longQuotes: 0,
    greetQuotes: 0,
    datePrefixQuotes: 0,
    findEcho: 0,
    interestingJunk: 0,
    missingInboundId: 0,
  },
};

for (let i = 0; i < SHARDS; i += 1) {
  const rows = loadJsonl(path.join(DEMAND, 'extracts', `${PASS}-${i}.jsonl`));
  const shard = {
    shard: i,
    rows: rows.length,
    parseErrors: 0,
    illegalQuoteFields: 0,
    shortQuotes: 0,
    longQuotes: 0,
    greetQuotes: 0,
    datePrefixQuotes: 0,
    findEcho: 0,
    interestingJunk: 0,
    missingInboundId: 0,
  };
  for (const row of rows) {
    if (row._parseError) {
      shard.parseErrors += 1;
      continue;
    }
    if (!row.inboundId) shard.missingInboundId += 1;
    for (const quote of row.quotes || []) {
      const field = String(quote.field || '');
      const text = String(quote.quote || '').trim();
      if (!ENUM.has(field)) shard.illegalQuoteFields += 1;
      if (text.length < 2) shard.shortQuotes += 1;
      if (text.length > 80) shard.longQuotes += 1;
      if (GREET.test(text)) shard.greetQuotes += 1;
      if ((field === 'arrival' || field === 'departure') && DATE_PREFIX.test(text)) {
        shard.datePrefixQuotes += 1;
      }
    }
    const request = row.request && typeof row.request === 'object' ? row.request : {};
    const used = row.usedResult && typeof row.usedResult === 'object' ? row.usedResult : {};
    for (const key of FIND_KEYS) {
      if (request[key] && used[key] && String(request[key]) === String(used[key])) {
        shard.findEcho += 1;
      }
    }
    for (const tag of row.staffFilledAbsentFromInbound || []) {
      if (!ENUM.has(String(tag))) shard.interestingJunk += 1;
    }
  }
  for (const key of Object.keys(summary.totals)) {
    if (key === 'rows') summary.totals.rows += shard.rows;
    else if (key in shard) summary.totals[key] += shard[key];
  }
  summary.shards.push(shard);
}

mkdirSync(path.join(DEMAND, 'extracts'), { recursive: true, mode: 0o700 });
writeFileSync(
  path.join(DEMAND, 'extracts', `${PASS}-qa-counts.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(summary));

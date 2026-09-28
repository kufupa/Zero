#!/usr/bin/env node
/** Build per-shard QA pack: flags + extract fields only. No subjects/bodies on stdout. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const FIND_KEYS = ['confirmationNumber', 'guestName', 'arrival', 'departure'];
const DATE_PREFIX = /^(check[- ]?in|check[- ]?out)\s*:?\s*/i;
const GREET = /^(good\s+day|from:|-----original)/i;
const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const PASS = process.argv[2] || 'value-reread';
const SHARD = Number(process.argv[3]);
if (!Number.isInteger(SHARD)) throw new Error('shard index required');

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const sample = JSON.parse(readFileSync(path.join(DEMAND, 'extracts', `${PASS}-qa-sample.json`), 'utf8'));
const shardMeta = sample.shards.find((item) => item.shard === SHARD);
if (!shardMeta) throw new Error(`no sample for shard ${SHARD}`);
const extracts = new Map(
  loadJsonl(path.join(DEMAND, 'extracts', `${PASS}-${SHARD}.jsonl`)).map((row) => [String(row.inboundId), row]),
);
const shards = new Map(
  loadJsonl(path.join(DEMAND, 'shards', `${PASS}-${SHARD}-bodies.jsonl`)).map((row) => [String(row.inboundId), row]),
);
const lab = JSON.parse(readFileSync(path.join(DEMAND, 'lab/index.json'), 'utf8'));
const labBy = new Map((lab.rows || []).map((row) => [String(row.inboundId), row]));

const rows = [];
const classCounts = {
  missingExtract: 0,
  illegalQuoteFields: 0,
  datePrefixQuotes: 0,
  greetQuotes: 0,
  findEcho: 0,
  interestingJunk: 0,
  shortQuotes: 0,
  longQuotes: 0,
};
for (const id of shardMeta.sampleIds) {
  const extract = extracts.get(id);
  const shardRow = shards.get(id);
  const labRow = labBy.get(id);
  const flags = [];
  if (!extract) {
    flags.push('missingExtract');
    classCounts.missingExtract += 1;
  }
  for (const quote of extract?.quotes || []) {
    const field = String(quote.field || '');
    const text = String(quote.quote || '').trim();
    if (!ENUM.has(field)) {
      flags.push('illegalQuoteFields');
      classCounts.illegalQuoteFields += 1;
    }
    if ((field === 'arrival' || field === 'departure') && DATE_PREFIX.test(text)) {
      flags.push('datePrefixQuotes');
      classCounts.datePrefixQuotes += 1;
    }
    if (GREET.test(text)) {
      flags.push('greetQuotes');
      classCounts.greetQuotes += 1;
    }
    if (text.length < 2) {
      flags.push('shortQuotes');
      classCounts.shortQuotes += 1;
    }
    if (text.length > 80) {
      flags.push('longQuotes');
      classCounts.longQuotes += 1;
    }
  }
  const request = extract?.request || {};
  const used = extract?.usedResult || {};
  for (const key of FIND_KEYS) {
    if (request[key] && used[key] && String(request[key]) === String(used[key])) {
      flags.push('findEcho');
      classCounts.findEcho += 1;
    }
  }
  for (const tag of extract?.staffFilledAbsentFromInbound || []) {
    if (!ENUM.has(String(tag))) {
      flags.push('interestingJunk');
      classCounts.interestingJunk += 1;
    }
  }
  rows.push({
    inboundId: id,
    cited: shardMeta.citedIds.includes(id),
    primaryVerb: labRow?.primaryVerb || null,
    threadOutcome: labRow?.threadOutcome || null,
    hasPrior: Boolean(shardRow?.priorInbounds?.length),
    hasAttach: Boolean(shardRow?.attachmentText),
    goldHasFrom: /\n(?:From:\s|-----Original Message-----)/i.test(String(labRow?.gold?.textBody || '')),
    quoteCount: extract?.quotes?.length || 0,
    requestKeys: Object.keys(request),
    usedKeys: Object.keys(used),
    interesting: extract?.staffFilledAbsentFromInbound || [],
    flags: [...new Set(flags)],
  });
}

const pack = {
  pass: PASS,
  shard: SHARD,
  extractRows: extracts.size,
  sampleCount: rows.length,
  classCounts,
  rows,
};
const dir = path.join(DEMAND, 'extracts', `${PASS}-qa-pack`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(path.join(dir, `shard-${SHARD}.json`), `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ pass: PASS, shard: SHARD, extractRows: extracts.size, classCounts }));

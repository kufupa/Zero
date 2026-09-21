#!/usr/bin/env node
/**
 * Merge pass JSONL into canonical.jsonl + disagreement sidecar + lab index + counts STATUS.
 * No PII on stdout.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';

function loadJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function bump(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

const passName = process.argv[2] || 'pass0';
const shardGlob = process.argv[3]; // e.g. extracts/pass3-{0-4}.jsonl prefix

const extractsDir = path.join(DEMAND, 'extracts');
const truthDir = path.join(DEMAND, 'truth');
const labDir = path.join(DEMAND, 'lab');
mkdirSync(truthDir, { recursive: true, mode: 0o700 });
mkdirSync(labDir, { recursive: true, mode: 0o700 });

const incoming = [];
if (shardGlob) {
  const match = shardGlob.match(/^(.*-)\{(\d+)-(\d+)\}(.*)$/);
  if (!match) throw new Error(`bad shard spec ${shardGlob}`);
  const [, prefix, a, b, suffix] = match;
  for (let i = Number(a); i <= Number(b); i += 1) {
    incoming.push(...loadJsonl(path.join(DEMAND, `${prefix}${i}${suffix}`)));
  }
} else {
  incoming.push(...loadJsonl(path.join(extractsDir, 'canonical.jsonl')));
}

const prev = new Map(loadJsonl(path.join(extractsDir, 'canonical.jsonl')).map((row) => [row.inboundId, row]));
const disagreements = [];
const merged = new Map(prev);

for (const row of incoming) {
  const id = row.inboundId;
  if (!id) continue;
  const old = merged.get(id);
  if (old) {
    const keys = ['threadOutcome', 'demandFamily', 'centurionReplyNeeded', 'primaryVerb'];
    const diffs = {};
    for (const key of keys) {
      if (row[key] != null && old[key] != null && String(row[key]) !== String(old[key])) {
        diffs[key] = { from: old[key], to: row[key] };
      }
    }
    if (Object.keys(diffs).length) {
      disagreements.push({ inboundId: id, pass: passName, diffs });
    }
    merged.set(id, { ...old, ...row, pass: passName });
  } else {
    merged.set(id, { ...row, pass: passName });
  }
}

const rows = [...merged.values()];
writeFileSync(
  path.join(extractsDir, 'canonical.jsonl'),
  rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
  { mode: 0o600 },
);
writeFileSync(
  path.join(extractsDir, `disagreement-${passName}.jsonl`),
  disagreements.length ? `${disagreements.map((row) => JSON.stringify(row)).join('\n')}\n` : '',
  { mode: 0o600 },
);

const outcome = {};
const tools = {};
const families = {};
for (const row of rows) {
  if (row.threadOutcome) bump(outcome, row.threadOutcome);
  if (row.demandFamily) bump(families, row.demandFamily);
  const list = Array.isArray(row.tools) ? row.tools : Array.isArray(row.pmsTools) ? row.pmsTools : [];
  for (const tool of new Set(list)) bump(tools, tool);
}

const stratum = {
  pass: passName,
  rowCount: rows.length,
  tagCount: tools,
  threadOutcome: outcome,
  demandFamily: families,
  disagreementCount: disagreements.length,
};
writeFileSync(path.join(truthDir, 'stratum-tools.json'), `${JSON.stringify(stratum, null, 2)}\n`, { mode: 0o600 });
writeFileSync(
  path.join(truthDir, `ledger-${passName}.json`),
  `${JSON.stringify(
    {
      pass: passName,
      counts: stratum,
      nextProbe:
        (outcome.true_gap || 0) > 200
          ? passName === 'pass0' || passName === 'pass3'
            ? 'pass3_or_pairing_repair'
            : 'true_gap_hitl'
          : (outcome.true_gap || 0) > 50
            ? 'true_gap_hitl'
            : 'stop_shuffle_under_2pct',
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const labPath = path.join(labDir, 'index.json');
if (existsSync(labPath)) {
  const lab = JSON.parse(readFileSync(labPath, 'utf8'));
  const byId = new Map(rows.map((row) => [row.inboundId, row]));
  if (Array.isArray(lab.rows)) {
    for (const labRow of lab.rows) {
      const extra = byId.get(labRow.inboundId);
      if (!extra) continue;
      if (extra.threadOutcome) labRow.threadOutcome = extra.threadOutcome;
      if (extra.demandFamily) labRow.demandFamily = extra.demandFamily;
      if (extra.request) labRow.request = extra.request;
      if (extra.usedResult) labRow.usedResult = extra.usedResult;
      if (extra.staffFilledAbsentFromInbound) labRow.staffFilledAbsentFromInbound = extra.staffFilledAbsentFromInbound;
      if (extra.spans) labRow.spans = extra.spans;
      if (extra.primaryVerb) labRow.primaryVerb = extra.primaryVerb;
      if (extra.channelAuto != null) labRow.channelAuto = extra.channelAuto;
      if (extra.paxTotal != null) labRow.paxTotal = extra.paxTotal;
      if (extra.isGroupBooking != null) labRow.isGroupBooking = extra.isGroupBooking;
      const inboundSpans = extra.requestSpans || extra.spansInbound;
      const goldSpans = extra.goldSpans || extra.spansGold;
      if (Array.isArray(inboundSpans) || Array.isArray(goldSpans)) {
        labRow.spans = [...(inboundSpans || []), ...(goldSpans || [])];
      }
    }
    lab.generated = passName;
    writeFileSync(labPath, `${JSON.stringify(lab)}\n`, { mode: 0o600 });
  }
}

const mailPublic = path.join(DEMAND, '../../../apps/mail/public/lab-centurion-index.json');
if (existsSync(labPath) && process.env.LAB_WRITE_PUBLIC_INDEX === '1') {
  mkdirSync(path.dirname(mailPublic), { recursive: true });
  writeFileSync(mailPublic, readFileSync(labPath), { mode: 0o600 });
}

console.log(
  JSON.stringify({
    pass: passName,
    rows: rows.length,
    disagreements: disagreements.length,
    threadOutcome: outcome,
    demandFamily: families,
  }),
);

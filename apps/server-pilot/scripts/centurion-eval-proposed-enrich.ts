#!/usr/bin/env tsx
/** Apply HITL enrich onto lab index. Counts on stdout. No bodies. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const mailEval = path.join(import.meta.dirname, '../../mail/lib/lab/centurion-eval.ts');
const { enrichHitlProposed } = await import(pathToFileURL(mailEval).href);

const DEMAND =
  process.env.CENTURION_EVAL_DEMAND ||
  '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-corpus/centurion-tool-demand-20260919';
const indexPath = path.join(DEMAND, 'lab/index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
let withLive = 0;
let empty = 0;
let folio = 0;
let quoteDoc = 0;
let noisyDropped = 0;
for (const row of index.rows || []) {
  const before = Array.isArray(row.proposedActions) ? row.proposedActions.map((item) => item.tool) : [];
  row.proposedActions = enrichHitlProposed(row);
  const live = row.proposedActions.filter((item) => item.status === 'live' || item.status === 'needs_human');
  if (live.length) withLive += 1;
  else empty += 1;
  if (live.some((item) => item.tool === 'hms_read_folio')) folio += 1;
  if (live.some((item) => item.tool === 'hms_generate_quote_document')) quoteDoc += 1;
  if (before.includes('mail_read_artifact') && !live.some((item) => item.tool === 'mail_read_artifact')) {
    noisyDropped += 1;
  }
}
writeFileSync(indexPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ rows: index.rows.length, withLive, empty, folio, quoteDoc, noisyDropped }));

/**
 * Thin CLI replacing nava-research/runs/c-eval/aop-eval.ts.
 * Scores via evals/agent/score-row.ts (same module as Promptfoo / GEPA).
 *
 *   pnpm exec tsx evals/agent/aop-eval.ts --gold FILE [--sop PATH --export NAME] [--limit N] [--concurrency 6] [--out FILE]
 * Prints aggregate numbers only. Per-row --out is ids + labels, no mail text.
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { SnapshotRow } from '../../src/ai/agent-decision-to-ops.js';
import {
  readUnlockedRows,
  runReservationistEvalAgent,
  scoreRow,
  type EvalGoldLabel,
  type ScoreRowResult,
} from './score-row.js';

export type GoldRow = SnapshotRow & { label: EvalGoldLabel };

export function loadAopGoldRows(goldPath: string, limit?: number): GoldRow[] {
  const rows = readUnlockedRows<GoldRow>(goldPath);
  return limit != null ? rows.slice(0, limit) : rows;
}

export function writeAopEvalOut(outPath: string, results: readonly ScoreRowResult[]): void {
  writeFileSync(outPath, '');
  for (const row of results) {
    const { reason: _reason, ...rest } = row;
    appendFileSync(outPath, `${JSON.stringify(rest)}\n`, { mode: 0o600 });
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      gold: { type: 'string' },
      sop: { type: 'string' },
      export: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '6' },
      out: { type: 'string' },
      tag: { type: 'string', default: '' },
    },
  });
  if (!values.gold) throw new Error('--gold required');

  const rows = loadAopGoldRows(values.gold, values.limit ? Number(values.limit) : undefined);

  let sopsText = '';
  if (values.sop) {
    const mod = (await import(pathToFileURL(resolve(values.sop)).href)) as Record<string, unknown>;
    const picked = values.export
      ? mod[values.export]
      : Object.values(mod).find((value) => typeof value === 'string' || (value && typeof value === 'object' && 'text' in value));
    const text = typeof picked === 'string' ? picked : (picked as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`no SOP text in ${values.sop} (${values.export ?? 'auto'})`);
    }
    sopsText = text;
  }

  const results: ScoreRowResult[] = new Array(rows.length);
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const index = next;
      next += 1;
      const row = rows[index]!;
      const ran = await runReservationistEvalAgent(row, { sopsText: sopsText || undefined });
      results[index] = scoreRow(row, ran.decision, ran.error);
    }
  }
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));

  const n = results.length;
  const ok = results.filter((row) => row.ok).length;
  const fields = results.reduce((sum, row) => sum + row.fields, 0);
  const scorable = results.reduce((sum, row) => sum + row.scorable, 0);
  const errors = results.filter((row) => row.error).length;
  const misses = new Map<string, number>();
  for (const row of results.filter((item) => !item.ok)) {
    const key = row.error ? 'error' : `gold=${row.gold}(${row.goldMove}) agent=${row.workflow}`;
    misses.set(key, (misses.get(key) ?? 0) + 1);
  }
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—');
  const lines = [
    `### ${values.tag || (values.sop ? 'with SOP' : 'baseline (no SOP)')} · ${new Date().toISOString().slice(11, 16)}Z`,
    '| n | same move (op set) | fields found / scorable required | errors |',
    '|---|---|---|---|',
    `| ${n} | ${ok}/${n} (${pct(ok, n)}) | ${fields}/${scorable} (${pct(fields, scorable)}) | ${errors} |`,
    'misses by reason:',
    ...[...misses.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `- ${count} × ${key}`),
  ];
  console.log(lines.join('\n'));
  if (values.out) writeAopEvalOut(values.out, results);
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) {
  await main();
}

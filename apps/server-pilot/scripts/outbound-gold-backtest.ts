/**
 * Outbound-gold fixture harness (U11a). Dry-run / fixture mode only.
 * Safe to import without DATABASE_URL. No --apply. No network. No RDS.
 *
 * Prod replay input (U11b, not this script): readQuoteAttachments → selectionToAgentPrompt.
 * Vision parity is a reported gap, not implemented here.
 *
 *   pnpm --dir apps/server-pilot exec tsx scripts/outbound-gold-backtest.ts <fixture.jsonl>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatAggregateStdout,
  parseFixtureJsonl,
  scoreOutboundGoldFixture,
} from '../src/ai/outbound-gold-features.js';

export type OutboundGoldCli = { fixturePath: string };

export function parseOutboundGoldArgs(argv: readonly string[]): OutboundGoldCli {
  if (argv.includes('--apply')) {
    throw new Error('apply_forbidden');
  }
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') throw new Error('usage');
    if (arg.startsWith('-')) throw new Error('unknown_option');
    positional.push(arg);
  }
  const fixturePath = positional[0];
  if (!fixturePath) throw new Error('fixture_path_required');
  if (/^(postgres|postgresql|https?):\/\//i.test(fixturePath)) {
    throw new Error('local_fixture_only');
  }
  return { fixturePath };
}

export function runOutboundGoldBacktest(argv: readonly string[]): number {
  let cli: OutboundGoldCli;
  try {
    cli = parseOutboundGoldArgs(argv);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'usage';
    process.stderr.write(
      `${JSON.stringify({
        error: code,
        usage: 'outbound-gold-backtest.ts <fixture.jsonl>',
      })}\n`,
    );
    return 2;
  }

  let text: string;
  try {
    text = readFileSync(path.resolve(cli.fixturePath), 'utf8');
  } catch {
    process.stderr.write(`${JSON.stringify({ error: 'fixture_not_found' })}\n`);
    return 2;
  }

  const parsed = parseFixtureJsonl(text);
  const summary = scoreOutboundGoldFixture(parsed.rows, parsed.jsonlErrors);
  process.stdout.write(formatAggregateStdout(summary));
  return 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return (
    typeof entry === 'string' &&
    path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMainModule()) process.exitCode = runOutboundGoldBacktest(process.argv.slice(2));

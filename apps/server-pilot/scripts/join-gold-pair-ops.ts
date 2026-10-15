/**
 * Offline gold-pair join: labelled staff_move + optional claimed ops → Promptfoo ops JSONL.
 * Default --in is in-repo synthetic (no RDS). Optional --private-in for .private/ later.
 *
 *   pnpm --filter @zero/server eval:gold-pair-join
 *   pnpm --filter @zero/server eval:gold-pair-join -- --private-in .private/centurion-corpus/labels.json --out evals/same-move/joined-ops.jsonl
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseGoldPairJoinCli, runGoldPairJoin } from '../src/ai/gold-pair-join.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runGoldPairJoinCli(
  argv: readonly string[],
  serverRoot = SERVER_ROOT,
): Promise<number> {
  try {
    const args = parseGoldPairJoinCli(argv, serverRoot);
    const result = await Promise.resolve(runGoldPairJoin(args));
    process.stdout.write(
      `${JSON.stringify({
        event: 'gold_pair_join.complete',
        written: result.written,
        inPath: args.privateInPath ? 'private' : 'synthetic',
        outPath: result.outPath,
      })}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'gold_pair_join.failed', message })}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) process.exitCode = await runGoldPairJoinCli(process.argv.slice(2));

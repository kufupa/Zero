/**
 * Offline context-dataset linker. Synthetic JSON in, masked JSONL out.
 * Label is context, never gold. No RDS. No live mail.
 *
 *   pnpm --dir apps/server-pilot exec tsx scripts/mail-context-linker.ts \
 *     --in events.json --out .private/mail-context/context.jsonl
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseMailContextLinkerCli, runMailContextLinker } from '../src/ai/mail-context-link.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runMailContextLinkerCli(
  argv: readonly string[],
  serverRoot = SERVER_ROOT,
): Promise<number> {
  try {
    const args = parseMailContextLinkerCli(argv, serverRoot);
    const result = runMailContextLinker(args);
    process.stdout.write(
      `${JSON.stringify({
        event: 'mail_context_link.complete',
        written: result.written,
        label: result.label,
        outPath: result.outPath,
      })}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ event: 'mail_context_link.failed', message })}\n`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) process.exitCode = await runMailContextLinkerCli(process.argv.slice(2));

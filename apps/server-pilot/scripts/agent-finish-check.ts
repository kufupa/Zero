import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateAgentFinishCheckJson } from '../src/ai/agent-finish-check.js';

const DEFAULT_AGENT_FINISH_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/agent-finish/pass.json',
);

/** npm extra args after `--` are appended; last non-flag path wins. Empty → PASS fixture. */
export function resolveAgentFinishCheckPath(
  extraArgs: readonly string[],
  defaultPath: string = DEFAULT_AGENT_FINISH_FIXTURE,
): string {
  const paths = extraArgs.filter((arg) => arg.trim() && !arg.startsWith('--'));
  return paths.at(-1) ?? defaultPath;
}

export async function runAgentFinishCheck(path: string): Promise<{ ok: boolean; errors: string[] }> {
  return evaluateAgentFinishCheckJson(await readFile(path, 'utf8'));
}

async function main(): Promise<void> {
  const path = resolveAgentFinishCheckPath(process.argv.slice(2));
  const verdict = await runAgentFinishCheck(path);
  console.log(JSON.stringify(verdict));
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`agent-finish-check: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 2;
  });
}

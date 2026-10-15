import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evaluateAgentFinishCheckJson } from '../src/ai/agent-finish-check.js';

export async function runAgentFinishCheck(path: string): Promise<{ ok: boolean; errors: string[] }> {
  return evaluateAgentFinishCheckJson(await readFile(path, 'utf8'));
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path?.trim() || path.startsWith('--')) {
    console.error('usage: agent-finish-check <check.json>');
    process.exitCode = 2;
    return;
  }
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

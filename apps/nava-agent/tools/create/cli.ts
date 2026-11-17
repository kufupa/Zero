import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { prepare, save, type ToolContext } from './index.js';

async function journal(directory: string, executionId: string, details: unknown): Promise<void> {
  const root = resolve(directory);
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error('DISPATCH_JOURNAL_NOT_PRIVATE');
  }
  const name = createHash('sha256').update(executionId).digest('hex');
  const file = await open(join(root, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify({ version: 1, executionId, details, at: new Date().toISOString() }));
    await file.sync();
  } finally { await file.close(); }
  for (const path of [root, dirname(root)]) {
    const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || options.has(args[i])) throw new Error('INVALID_ARGUMENTS');
    options.set(args[i], args[i + 1]);
  }
  const inputPath = options.get('--input');
  const outputPath = options.get('--output');
  const mode = options.get('--mode');
  const journalPath = options.get('--journal');
  if (!['prepare', 'save'].includes(operation) || !inputPath || !outputPath ||
      !['live', 'labtest', 'historical'].includes(mode ?? '') ||
      [...options.keys()].some(key => !['--input', '--output', '--mode', '--journal'].includes(key)) ||
      (operation === 'save' && !journalPath)) throw new Error('INVALID_ARGUMENTS');
  if (mode !== 'live' && mode !== 'labtest' && mode !== 'historical') throw new Error('INVALID_MODE');
  const raw = await readFile(inputPath, 'utf8');
  if (Buffer.byteLength(raw) > 1_000_000) throw new Error('INPUT_TOO_LARGE');
  const input: unknown = JSON.parse(raw);
  const context: ToolContext = { sessionId: 'direct-create-cli', mode };
  const output = await open(outputPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const result = operation === 'prepare' ? await prepare(input, context) : await save(input, {
      ...context,
      markDispatched: async details => {
        if (!journalPath || !input || typeof input !== 'object' || !('executionId' in input) || typeof input.executionId !== 'string') {
          throw new Error('DISPATCH_JOURNAL_INPUT_INVALID');
        }
        await journal(journalPath, input.executionId, details);
      },
    });
    await output.writeFile(JSON.stringify(result));
    await output.sync();
    process.stdout.write(JSON.stringify({ ok: result.ok, code: result.error?.code ?? null, outcome: result.error?.outcome ?? 'verified' }) + '\n');
    if (!result.ok) process.exitCode = 1;
  } finally { await output.close(); }
}

main().catch(() => { process.stderr.write('CREATE_CLI_FAILED\n'); process.exitCode = 1; });

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { prepare, save, type ToolContext } from './index.js';

async function durableMarker(directory: string, executionId: string, details: unknown): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('PRIVATE_JOURNAL_REQUIRED');
  }
  const digest = createHash('sha256').update(executionId).digest('hex');
  const marker = await open(`${directory}/${digest}.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await marker.writeFile(JSON.stringify({ executionId, details, at: new Date().toISOString() }));
    await marker.sync();
  } finally { await marker.close(); }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}

async function main() {
  const [command, inputPath, journalDir] = process.argv.slice(2);
  if (!['prepare-live', 'prepare-labtest', 'save-labtest'].includes(command ?? '') || !inputPath ||
      (command === 'save-labtest' && !journalDir)) throw new Error('USAGE');
  const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  const mode: ToolContext['mode'] = command === 'prepare-live' ? 'live' : 'labtest';
  const base: ToolContext = { sessionId: `cli-${randomUUID()}`, mode, signal: AbortSignal.timeout(85_000) };
  // Operator must configure this process with the actual native admission DB on its existing box.
  if (process.env.NAVA_HMS_SHARED_ADMISSION !== '1') {
    const result = command === 'save-labtest'
      ? await save(input, { ...base, markDispatched: async () => { throw new Error('HMS_SHARED_LEASE_REQUIRED'); } })
      : await prepare(input, base);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, error: result.error })}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('HMS_CREDENTIAL_LEASE_DATABASE_REQUIRED');
  if (typeof input !== 'object' || input === null || !('booking' in input) ||
      typeof input.booking !== 'object' || input.booking === null || !('property_code' in input.booking) ||
      typeof input.booking.property_code !== 'string') throw new Error('INVALID_CANCEL_INPUT');
  const cloudUrl = new URL('../../../server-pilot/tooling/hms-cloud/cloud-session.mjs', import.meta.url);
  const cloud = await import(cloudUrl.href);
  const result = await cloud.withCloudCredentialLease(input.booking.property_code, async (credentialLease: unknown) => {
    const context: ToolContext = { ...base, credentialLease };
    if (command !== 'save-labtest') return prepare(input, context);
    if (!('executionId' in input) || typeof input.executionId !== 'string' || !journalDir) throw new Error('INVALID_CANCEL_INPUT');
    const executionId = input.executionId;
    return save(input, { ...context, markDispatched: (details) => durableMarker(journalDir, executionId, details) });
  }, { readOnly: command !== 'save-labtest', signal: base.signal });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, error: result.error,
    outcome: result.ok && typeof result.data === 'object' && result.data !== null && 'outcome' in result.data ? result.data.outcome : null })}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((cause: unknown) => {
  const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'CLI_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});

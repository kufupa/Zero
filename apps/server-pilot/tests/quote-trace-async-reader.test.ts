import { createExistingOwnerNativeQuoteReader } from '../src/ai/reservationist-evaluation-composition.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Repository root, and the private output root the reader insists on.
const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const privateRoot = join(repo, '.private', 'playwright-quote');
const requestFile = join(repo, 'apps/server-pilot/tooling/playwright-quote/examples/v2-broad.json');
const quoteContract = join(repo, 'apps/server-pilot/tooling/playwright-quote/quote-contract.mjs');

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const output = join(privateRoot, `trace-async-reader-${randomUUID()}`);
  cleanup.push(output);
  const evidence = join(output, 'run-1');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const wire = JSON.parse(await readFile(requestFile, 'utf8')) as Record<string, unknown>;
  const { normalizeQuoteRequest } = (await import(quoteContract)) as {
    normalizeQuoteRequest: (input: unknown) => { ok: boolean; request: unknown };
  };
  const normalized = normalizeQuoteRequest({ schemaVersion: 2, ...wire });
  if (!normalized.ok) throw new Error('fixture request must normalize');
  const capture = (
    audit: { status: string },
    outcome = 'quote',
    groups: unknown[] = [{ id: 'share', outcome, options: [] }],
  ) => ({
    schemaVersion: 2,
    outcome,
    propertyCode: 'HRCEN',
    requested: normalized.request,
    groups,
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    evidenceDirectory: evidence,
    audit,
  });
  const owner = {
    cdpUrl: 'http://127.0.0.1:9222',
    browserOwnership: 'borrowed' as const,
    propertyCode: 'HRCEN',
    secretPath: join(tmpdir(), 'trace-async-reader-secret.json'),
  };
  const dispatchWith = (traceFinish: 'pending' | undefined) => async () => ({
    stdout: `Evidence: ${evidence}\n`,
    ...(traceFinish ? { traceFinish } : {}),
  });
  const read = (dispatch: ReturnType<typeof dispatchWith>) =>
    createExistingOwnerNativeQuoteReader({ owner, outputDir: output, dispatch })(
      wire as never,
      new AbortController().signal,
    );
  return { evidence, capture, read, dispatchWith };
}

describe('provisional quote reads', () => {
  it('accepts a pending quote capture, reads the provisional file and binds its hash', async () => {
    const { evidence, capture, read, dispatchWith } = await fixture();
    const provisionalBytes = JSON.stringify(capture({ status: 'pending' }), null, 2) + '\n';
    await writeFile(join(evidence, 'result.provisional.json'), provisionalBytes, { mode: 0o600 });
    // A later final file must not be what the reader accepted.
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        capture({ status: 'complete' }, 'quote', [
          { id: 'final-only', outcome: 'quote', options: [] },
        ]),
      ),
      { mode: 0o600 },
    );
    const record = await read(dispatchWith('pending'));
    expect(record.result.outcome).toBe('quote');
    expect(record.result.groups).toEqual([{ id: 'share', outcome: 'quote', options: [] }]);
    expect(record.sha256).toBe(createHash('sha256').update(provisionalBytes).digest('hex'));
  });

  it('refuses a provisional capture whose outcome is not a quote', async () => {
    const { evidence, capture, read, dispatchWith } = await fixture();
    await writeFile(
      join(evidence, 'result.provisional.json'),
      JSON.stringify(capture({ status: 'pending' }, 'partial')),
      { mode: 0o600 },
    );
    await expect(read(dispatchWith('pending'))).rejects.toThrow(
      'native_quote_capture_scope_or_completeness_invalid',
    );
  });

  it('refuses a provisional capture that is already complete, so the pending path is only for pending audits', async () => {
    const { evidence, capture, read, dispatchWith } = await fixture();
    await writeFile(
      join(evidence, 'result.provisional.json'),
      JSON.stringify(capture({ status: 'complete' })),
      { mode: 0o600 },
    );
    await expect(read(dispatchWith('pending'))).rejects.toThrow(
      'native_quote_capture_scope_or_completeness_invalid',
    );
  });

  it('keeps the sequential rule when the dispatch is not provisional: pending audits are refused', async () => {
    const { evidence, capture, read, dispatchWith } = await fixture();
    await writeFile(join(evidence, 'result.json'), JSON.stringify(capture({ status: 'pending' })), {
      mode: 0o600,
    });
    await expect(read(dispatchWith(undefined))).rejects.toThrow(
      'native_quote_capture_scope_or_completeness_invalid',
    );
  });

  it('keeps accepting a complete sequential capture from result.json', async () => {
    const { evidence, capture, read, dispatchWith } = await fixture();
    await writeFile(
      join(evidence, 'result.json'),
      JSON.stringify(
        capture({ status: 'complete' }, 'quote', [
          { id: 'sequential', outcome: 'quote', options: [] },
        ]),
      ),
      { mode: 0o600 },
    );
    const record = await read(dispatchWith(undefined));
    expect(record.result.groups).toEqual([{ id: 'sequential', outcome: 'quote', options: [] }]);
  });
});

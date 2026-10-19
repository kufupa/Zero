import { createExistingOwnerNativeQuoteReader } from '../src/ai/reservationist-evaluation-composition.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Stands in for the fetch-quote process. A non-zero exit carries stdout with the evidence line, as the CLI prints it.
const cliExit = vi.hoisted(() => ({ failure: null as null | { stdout: string } }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: unknown) => void;
      if (!cliExit.failure) {
        return (actual.execFile as unknown as (...rest: unknown[]) => unknown)(...args);
      }
      callback(Object.assign(new Error('Command failed'), { code: 2, ...cliExit.failure }));
    },
  };
});

// The reader only accepts output under the repo's private quote directory.
const privateRoot = fileURLToPath(new URL('../../../.private/playwright-quote', import.meta.url));
const owner = {
  cdpUrl: 'http://127.0.0.1:9222',
  browserOwnership: 'borrowed' as const,
  propertyCode: 'HRCEN',
  secretPath: '/srv/owner/secret.json',
};
const request = {
  propertyCode: 'HRCEN',
  arrivalDate: '2026-11-12',
  departureDate: '2026-11-14',
  rooms: [{ id: 'room-1', quantity: 1, adults: 2, children: 0, childAges: [] }],
} as never;

let root = '';
afterEach(async () => {
  cliExit.failure = null;
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

// Writes the capture the CLI leaves in its evidence directory and returns the stdout line that names it.
async function savedCapture(result: Record<string, unknown>): Promise<string> {
  root = join(privateRoot, `test-${randomUUID()}`);
  const evidence = join(root, 'out', 'evidence');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result));
  return `Evidence: ${evidence}\n`;
}

describe('createExistingOwnerNativeQuoteReader default dispatch', () => {
  it('reports the saved execution failure and its phase when the CLI exits non-zero', async () => {
    cliExit.failure = {
      stdout: await savedCapture({ outcome: 'execution_failure', phase: 'hotel_availability' }),
    };
    const read = createExistingOwnerNativeQuoteReader({ owner, outputDir: join(root, 'out') });
    await expect(read(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'EXECUTION_FAILURE',
      phase: 'hotel_availability',
    });
  });

  it('carries the sanitized attach error name and message from result.json', async () => {
    cliExit.failure = {
      stdout: await savedCapture({
        outcome: 'execution_failure',
        phase: 'attach',
        error: {
          name: 'TimeoutError',
          message: 'browserType.connectOverCDP: Timeout 20000ms exceeded. http://127.0.0.1:19223',
        },
      }),
    };
    const read = createExistingOwnerNativeQuoteReader({ owner, outputDir: join(root, 'out') });
    await read(request, new AbortController().signal).then(
      () => {
        throw new Error('expected EXECUTION_FAILURE');
      },
      (error: { errorMessage?: string }) => {
        expect(error).toMatchObject({
          code: 'EXECUTION_FAILURE',
          phase: 'attach',
          errorName: 'TimeoutError',
          errorMessage: expect.stringMatching(/Timeout 20000ms exceeded/),
        });
        expect(error.errorMessage).not.toMatch(/http:|127\.0\.0\.1/);
      },
    );
  });

  it('keeps native_quote_read_unavailable when a non-zero exit saved something other than a failure', async () => {
    cliExit.failure = { stdout: await savedCapture({ outcome: 'partial', phase: 'run' }) };
    const read = createExistingOwnerNativeQuoteReader({ owner, outputDir: join(root, 'out') });
    await expect(read(request, new AbortController().signal)).rejects.toThrow(
      'native_quote_read_unavailable',
    );
  });
});

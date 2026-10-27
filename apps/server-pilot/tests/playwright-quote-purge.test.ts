import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HMS_SHOTS_MAX_AGE_MS,
  PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS,
  canWritePlaywrightTraceAtUsage,
  diskHealthAlertLine,
  purgeExpiredHmsShots,
  purgeExpiredPlaywrightQuoteZips,
} from '../src/ops/playwright-quote-purge.js';
import { createAudit } from '../tooling/playwright-quote/audit.mjs';

const { zipSync } = createRequire(new URL('../package.json', import.meta.url))('fflate') as typeof import('fflate');
const testsDir = dirname(fileURLToPath(import.meta.url));
const deployDir = join(testsDir, '../deploy');
const temporaryRoots: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function writeAgedFile(path: string, contents: string, ageMs: number) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  const mtime = new Date(Date.now() - ageMs);
  await utimes(path, mtime, mtime);
}

function browserPage(stopTrace: (...args: unknown[]) => Promise<void>) {
  const page = new EventEmitter() as EventEmitter & {
    context: () => unknown;
    locator: () => { count: () => Promise<number> };
  };
  page.context = () => ({
    storageState: async () => ({ cookies: [], origins: [] }),
    tracing: { start: async () => {}, stop: stopTrace },
  });
  page.locator = () => ({ count: async () => 0 });
  return page;
}

describe('Playwright quote disk retention', () => {
  it('deletes only trace zips at least three days old', async () => {
    const parent = await tempRoot('quote-zip-purge-');
    const root = join(parent, '.private', 'playwright-quote');
    const oldZip = join(root, 'run-old', 'trace.zip');
    const freshZip = join(root, 'run-fresh', 'trace.zip');
    const screenshot = join(root, 'run-old', 'screenshots', 'before.png');
    const metadata = join(root, 'run-old', 'result.json');
    await writeAgedFile(oldZip, 'expired trace', PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS + 1_000);
    await writeAgedFile(freshZip, 'fresh trace', PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS - 1_000);
    await writeAgedFile(screenshot, 'screenshot', PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS + 1_000);
    await writeAgedFile(metadata, '{}', PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS + 1_000);

    const result = await purgeExpiredPlaywrightQuoteZips(root);

    expect(result).toEqual({ removed: 1, bytes: Buffer.byteLength('expired trace') });
    await expect(stat(oldZip)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(freshZip)).size).toBe(Buffer.byteLength('fresh trace'));
    expect((await stat(screenshot)).size).toBe(Buffer.byteLength('screenshot'));
    expect((await stat(metadata)).size).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/run-old|trace\.zip/);
  });

  it('deletes HMS screenshot files at least 30 days old but keeps other data', async () => {
    const parent = await tempRoot('hms-shot-purge-');
    const root = join(parent, 'var', 'lib', 'nava', 'hms-shots');
    const oldShot = join(root, 'property', 'work-item', 'run-old', 'before.png');
    const freshShot = join(root, 'property', 'work-item', 'run-new', 'saved.png');
    const receipt = join(root, 'property', 'work-item', 'run-old', 'receipt.json');
    await writeAgedFile(oldShot, 'expired screenshot', HMS_SHOTS_MAX_AGE_MS + 1_000);
    await writeAgedFile(freshShot, 'fresh screenshot', HMS_SHOTS_MAX_AGE_MS - 1_000);
    await writeAgedFile(receipt, '{}', HMS_SHOTS_MAX_AGE_MS + 1_000);

    const result = await purgeExpiredHmsShots(root);

    expect(result).toEqual({ removed: 1, bytes: Buffer.byteLength('expired screenshot') });
    await expect(stat(oldShot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(freshShot)).size).toBe(Buffer.byteLength('fresh screenshot'));
    expect((await stat(receipt)).size).toBe(2);
  });

  it('does not follow symlinks when purging either retained tree', async () => {
    const parent = await tempRoot('retention-symlink-');
    const quoteRoot = join(parent, '.private', 'playwright-quote');
    const shotsRoot = join(parent, 'var', 'lib', 'nava', 'hms-shots');
    const outside = join(parent, 'outside');
    await mkdir(quoteRoot, { recursive: true });
    await mkdir(shotsRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    const oldOutsideZip = join(outside, 'trace.zip');
    const oldOutsideShot = join(outside, 'before.png');
    await writeAgedFile(oldOutsideZip, 'keep zip', PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS + 1_000);
    await writeAgedFile(oldOutsideShot, 'keep shot', HMS_SHOTS_MAX_AGE_MS + 1_000);
    await symlink(outside, join(quoteRoot, 'linked-run'));
    await symlink(outside, join(shotsRoot, 'linked-property'));

    expect(await purgeExpiredPlaywrightQuoteZips(quoteRoot)).toEqual({ removed: 0, bytes: 0 });
    expect(await purgeExpiredHmsShots(shotsRoot)).toEqual({ removed: 0, bytes: 0 });
    expect((await stat(oldOutsideZip)).size).toBe(Buffer.byteLength('keep zip'));
    expect((await stat(oldOutsideShot)).size).toBe(Buffer.byteLength('keep shot'));
  });

  it('refuses roots outside the two owned retention trees', async () => {
    const parent = await tempRoot('retention-invalid-root-');
    await expect(purgeExpiredPlaywrightQuoteZips(parent)).rejects.toThrow(/ROOT_INVALID/);
    await expect(purgeExpiredHmsShots(parent)).rejects.toThrow(/ROOT_INVALID/);
  });

  it('refuses trace writes at 75% and exposes the health alert at 85%', () => {
    expect(canWritePlaywrightTraceAtUsage(74.99)).toBe(true);
    expect(canWritePlaywrightTraceAtUsage(75)).toBe(false);
    expect(canWritePlaywrightTraceAtUsage(100)).toBe(false);
    expect(canWritePlaywrightTraceAtUsage(null)).toBe(false);
    expect(diskHealthAlertLine(84.99)).toBeNull();
    expect(diskHealthAlertLine(85)).toContain('85%');
    expect(diskHealthAlertLine(null)).toBeNull();
  });

  it('keeps successful quote traces out of disk but writes a sanitized trace on failure', async () => {
    const trace = zipSync({
      'trace.trace': Buffer.from(JSON.stringify({ type: 'log', message: 'failure details' }) + '\n'),
      'trace.network': Buffer.from(JSON.stringify({ type: 'resource-snapshot', snapshot: { request: {
        url: 'https://hotel.invalid/grid?token=private-token',
        headers: [{ name: 'Cookie', value: 'sid=cookie-value' }],
        postData: { text: 'booking-value' },
      } } }) + '\n'),
      'trace.stacks': Buffer.from('{}'),
      'screencast/page@1234-1789688535557.jpeg': Buffer.from([255, 216, 255, 224, 1, 2, 3, 4]),
    });
    const successDir = await tempRoot('quote-audit-success-');
    let successStopArgs: unknown[] = [];
    const successAudit = await createAudit(successDir, { diskUsage: async () => 10 });
    await successAudit.start(browserPage(async (...args) => { successStopArgs = args; }));
    successAudit.event('result_quote');
    const success = await successAudit.finish();
    expect(success.status).toBe('complete');
    expect(success.trace.status).toBe('not_written_success');
    expect(successStopArgs).toHaveLength(0);
    await expect(stat(join(successDir, 'trace.zip'))).rejects.toMatchObject({ code: 'ENOENT' });

    const failureDir = await tempRoot('quote-audit-failure-');
    let failureStopArgs: unknown[] = [];
    const failureAudit = await createAudit(failureDir, { diskUsage: async () => 10 });
    await failureAudit.start(browserPage(async (...args) => {
      failureStopArgs = args;
      const path = (args[0] as { path?: string } | undefined)?.path;
      if (path) await writeFile(path, trace, { mode: 0o600 });
    }));
    failureAudit.event('result_execution_failure');
    const failure = await failureAudit.finish();
    expect(failure.status).toBe('complete');
    expect(failure.trace.status).toBe('complete');
    expect(failureStopArgs).toHaveLength(1);
    expect((failureStopArgs[0] as { path: string }).path).toContain('.trace-raw.zip');
    expect((await readFile(join(failureDir, 'trace.zip'))).byteLength).toBeGreaterThan(0);
    await expect(stat(join(failureDir, '.trace-raw.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not start or persist a trace when disk is already at the refusal threshold', async () => {
    const directory = await tempRoot('quote-audit-full-disk-');
    let traceStarted = false;
    let traceStopped = false;
    const page = browserPage(async () => { traceStopped = true; });
    const context = page.context() as { tracing: { start: () => Promise<void> } };
    context.tracing.start = async () => { traceStarted = true; };
    const audit = await createAudit(directory, { diskUsage: async () => 75 });

    await audit.start(page);
    const result = await audit.finish();

    expect(traceStarted).toBe(false);
    expect(traceStopped).toBe(false);
    expect(result.trace.status).toBe('refused_disk_limit');
    await expect(stat(join(directory, 'trace.zip'))).rejects.toMatchObject({ code: 'ENOENT' });

    const pressureDir = await tempRoot('quote-audit-pressure-crossed-');
    let traceStartedBeforePressure = false;
    let traceStoppedWithoutPath = false;
    const crossingPage = browserPage(async (...args) => {
      traceStoppedWithoutPath = args.length === 0;
    });
    const crossingContext = crossingPage.context() as { tracing: { start: () => Promise<void> } };
    crossingContext.tracing.start = async () => { traceStartedBeforePressure = true; };
    const diskReadings = [10, 75];
    const crossingAudit = await createAudit(pressureDir, {
      diskUsage: async () => diskReadings.shift() ?? 75,
    });
    await crossingAudit.start(crossingPage);
    crossingAudit.event('result_execution_failure');
    const crossed = await crossingAudit.finish();

    expect(traceStartedBeforePressure).toBe(true);
    expect(traceStoppedWithoutPath).toBe(true);
    expect(crossed.trace.status).toBe('refused_disk_limit');
    await expect(stat(join(pressureDir, 'trace.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs an hourly df-logging timer for both retention roots and wires it into deploy', () => {
    const installer = readFileSync(join(deployDir, 'install-playwright-quote-purge.sh'), 'utf8');
    const deploy = readFileSync(join(deployDir, 'deploy-ec2.sh'), 'utf8');
    const main = readFileSync(join(testsDir, '../src/main.ts'), 'utf8');

    expect(installer).toContain('nava-playwright-quote-purge.timer');
    expect(installer).toContain('ExecStartPre=/usr/bin/df -P /');
    expect(installer).toContain('.private/playwright-quote');
    expect(installer).toContain('/var/lib/nava/hms-shots');
    expect(installer).toMatch(/OnUnitActiveSec=1h/);
    expect(installer).toMatch(/purgeExpiredPlaywrightQuoteZips/);
    expect(installer).toMatch(/purgeExpiredHmsShots/);
    expect(deploy).toMatch(/install-playwright-quote-purge\.sh/);
    expect(main).toContain('diskHealthAlertLine');
  });
});

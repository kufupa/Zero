import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROPERTY_REGISTRY } from '../tooling/playwright-quote/property-registry.mjs';
import { hmsShotsRoot, persistHmsShots, readStoredHmsShot } from '../src/ai/hms-shots-store.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const SHA = createHash('sha256').update(PNG).digest('hex');
const PROPERTY = PROPERTY_REGISTRY.properties.find((entry) => entry.active)?.propertyCode;
const OTHER_PROPERTY = PROPERTY_REGISTRY.properties.find(
  (entry) => entry.active && entry.propertyCode !== PROPERTY,
)?.propertyCode;

let root: string;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'hms-shots-'));
  return root;
}

describe('hms shots store', () => {
  it('stores before/filled/saved PNGs, serves them after the in-memory run is gone, and unknown property fails closed', async () => {
    expect(PROPERTY).toBeTruthy();
    const dir = await makeRoot();
    const env = { HMS_SHOTS_DIR: dir };
    expect(hmsShotsRoot(env)).toBe(dir);
    expect(hmsShotsRoot({ NODE_ENV: 'test' })).toBeNull();
    expect(hmsShotsRoot({})).toBe('/var/lib/nava/hms-shots');

    const source = await mkdtemp(join(tmpdir(), 'pane-stay-'));
    await writeFile(join(source, 'before.png'), PNG);
    await writeFile(join(source, 'filled.png'), PNG);
    await writeFile(join(source, 'saved.png'), PNG);
    const workItemId = randomUUID();
    const runId = randomUUID();
    const owner = 'user-1:transport-sample';
    const now = 1_700_000_000_000;
    const at = new Date(now).toISOString();
    const shots = await persistHmsShots({
      propertyCode: PROPERTY!,
      workItemId,
      runId,
      sourceDir: source,
      owner,
      now,
      env,
    });
    expect(shots).toEqual([
      { name: 'before.png', sha256: SHA, at },
      { name: 'filled.png', sha256: SHA, at },
      { name: 'saved.png', sha256: SHA, at },
    ]);
    const stored = join(dir, PROPERTY!, workItemId, runId);
    expect((await stat(stored)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(stored, 'before.png'))).toEqual(PNG);
    expect(await readFile(join(stored, 'filled.png'))).toEqual(PNG);
    expect(await readFile(join(stored, 'saved.png'))).toEqual(PNG);

    await expect(readStoredHmsShot({ runId, name: 'filled.png', owner, env })).resolves.toEqual(PNG);
    await expect(
      readStoredHmsShot({ runId, name: 'saved.png', owner: 'user-2:transport-sample', env }),
    ).resolves.toBeNull();
    await expect(
      persistHmsShots({
        propertyCode: 'NOHOTEL',
        workItemId,
        runId: randomUUID(),
        sourceDir: source,
        owner,
        now,
        env,
      }),
    ).resolves.toBeNull();
    if (OTHER_PROPERTY) {
      await expect(
        persistHmsShots({
          propertyCode: OTHER_PROPERTY,
          workItemId: randomUUID(),
          runId: randomUUID(),
          sourceDir: source,
          owner,
          now,
          env,
        }),
      ).resolves.toMatchObject([
        { name: 'before.png' },
        { name: 'filled.png' },
        { name: 'saved.png' },
      ]);
    }

    const amendSource = await mkdtemp(join(tmpdir(), 'pane-stay-amend-'));
    await writeFile(join(amendSource, 'before.png'), PNG);
    const amendShots = await persistHmsShots({
      propertyCode: PROPERTY!,
      workItemId: randomUUID(),
      runId: randomUUID(),
      sourceDir: amendSource,
      owner,
      now,
      env,
    });
    expect(amendShots).toEqual([{ name: 'before.png', sha256: SHA, at }]);

    await expect(
      persistHmsShots({
        propertyCode: PROPERTY!,
        workItemId: '../escape',
        runId,
        sourceDir: source,
        owner,
        now,
        env,
      }),
    ).resolves.toBeNull();
    await expect(readStoredHmsShot({ runId, name: '../saved.png', owner, env })).resolves.toBeNull();
    await rm(source, { recursive: true, force: true });
    await rm(amendSource, { recursive: true, force: true });
  });
});

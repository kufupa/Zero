import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROPERTY_REGISTRY } from '../tooling/playwright-quote/property-registry.mjs';
import { hmsShotsRoot, persistHmsShots, readStoredHmsShot, verifyStoredHmsPreview } from '../src/ai/hms-shots-store.js';

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


describe('retained preview integrity', () => {
  it('binds a structurally plausible PNG to its exact owner, hotel, work item and digest', async () => {
    const dir = await makeRoot();
    const source = await mkdtemp(join(tmpdir(), 'pane-preview-source-'));
    try {
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64');
      await writeFile(join(source, 'filled.png'), image);
      const propertyCode = PROPERTY!;
      const workItemId = randomUUID();
      const runId = randomUUID();
      const owner = 'user-1:transport-sample';
      const env = { HMS_SHOTS_DIR: dir };
      const shots = await persistHmsShots({ propertyCode, workItemId, runId, sourceDir: source, owner, now: Date.now(), env });
      const sha256 = shots?.[0]?.sha256;
      expect(sha256).toBeTruthy();
      const proof = { propertyCode, workItemId, runId, name: 'filled.png', owner, sha256: sha256!, env };
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(true);
      for (const changed of [
        { ...proof, owner: 'another-user:transport-sample' },
        { ...proof, propertyCode: 'OTHER' },
        { ...proof, workItemId: randomUUID() },
        { ...proof, name: 'saved.png' },
        { ...proof, sha256: '0'.repeat(64) },
      ]) await expect(verifyStoredHmsPreview(changed)).resolves.toBe(false);
      await writeFile(join(dir, propertyCode, workItemId, runId, 'filled.png'), Buffer.from('changed'));
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('rejects a digest-matching corrupt image and a missing run index', async () => {
    const dir = await makeRoot();
    const source = await mkdtemp(join(tmpdir(), 'pane-preview-source-'));
    try {
      const image = Buffer.from('not an image');
      await writeFile(join(source, 'filled.png'), image);
      const propertyCode = PROPERTY!;
      const workItemId = randomUUID();
      const runId = randomUUID();
      const owner = 'user-1:transport-sample';
      const env = { HMS_SHOTS_DIR: dir };
      const shots = await persistHmsShots({ propertyCode, workItemId, runId, sourceDir: source, owner, now: Date.now(), env });
      const proof = { propertyCode, workItemId, runId, name: 'filled.png', owner, sha256: shots![0]!.sha256, env };
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      const validImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64');
      await writeFile(join(dir, propertyCode, workItemId, runId, 'filled.png'), validImage);
      const validProof = { ...proof, sha256: createHash('sha256').update(validImage).digest('hex') };
      await expect(verifyStoredHmsPreview(validProof)).resolves.toBe(true);
      await rm(join(dir, 'by-run', `${runId}.json`));
      await expect(verifyStoredHmsPreview(validProof)).resolves.toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('accepts size boundaries and rejects oversized or special retained files', async () => {
    const dir = await makeRoot();
    const source = await mkdtemp(join(tmpdir(), 'pane-preview-source-'));
    try {
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64');
      await writeFile(join(source, 'filled.png'), image);
      const propertyCode = PROPERTY!;
      const workItemId = randomUUID();
      const runId = randomUUID();
      const owner = 'user-1:transport-sample';
      const env = { HMS_SHOTS_DIR: dir };
      const shots = await persistHmsShots({ propertyCode, workItemId, runId, sourceDir: source, owner, now: Date.now(), env });
      const proof = { propertyCode, workItemId, runId, name: 'filled.png', owner, sha256: shots![0]!.sha256, env };
      const indexPath = join(dir, 'by-run', `${runId}.json`);
      const imagePath = join(dir, propertyCode, workItemId, runId, 'filled.png');
      const index = await readFile(indexPath);
      const sizedIndex = Buffer.concat([index, Buffer.alloc(16 * 1024 - index.length, 0x20)]);
      await writeFile(indexPath, sizedIndex);
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(true);
      await writeFile(indexPath, Buffer.concat([sizedIndex, Buffer.from(' ')]));
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      await writeFile(indexPath, index);

      await rm(indexPath);
      await symlink(join(source, 'index.json'), indexPath);
      await writeFile(join(source, 'index.json'), index);
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      await rm(indexPath);
      await mkdir(indexPath);
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      await rm(indexPath, { recursive: true });
      await writeFile(indexPath, index);

      await rm(imagePath);
      await symlink(join(source, 'filled.png'), imagePath);
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      await rm(imagePath);
      await mkdir(imagePath);
      await expect(verifyStoredHmsPreview(proof)).resolves.toBe(false);
      await rm(imagePath, { recursive: true });

      // Add an ancillary chunk before IEND so both sizes pass the structural check.
      const paddedImage = (size: number) => {
        const chunk = Buffer.alloc(size - image.length);
        chunk.writeUInt32BE(chunk.length - 12, 0);
        chunk.write('tEXt', 4, 'ascii');
        return Buffer.concat([image.subarray(0, -12), chunk, image.subarray(-12)]);
      };
      const boundary = paddedImage(20 * 1024 * 1024);
      await writeFile(imagePath, boundary);
      await expect(verifyStoredHmsPreview({ ...proof, sha256: createHash('sha256').update(boundary).digest('hex') })).resolves.toBe(true);
      const oversized = paddedImage(20 * 1024 * 1024 + 1);
      await writeFile(imagePath, oversized);
      await expect(verifyStoredHmsPreview({ ...proof, sha256: createHash('sha256').update(oversized).digest('hex') })).resolves.toBe(false);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

});

import {
  assertSourceSnapshotStable,
  bundleStagehandTrial,
  captureSourceSnapshot,
} from '../scripts/hms-stagehand-bundle.mjs';
import { preflightKnownBuiltTrialEntries } from '../scripts/hms-stagehand-preflight.mjs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const tempRoots: string[] = [];

async function fixture(): Promise<{ root: string; outParent: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hms-stagehand-fixture-'));
  const outParent = await mkdtemp(path.join(os.tmpdir(), 'hms-stagehand-output-'));
  tempRoots.push(root, outParent);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'tiny-hms-trial', private: true, type: 'module' }) + '\n',
  );
  await writeFile(
    path.join(root, 'src-main.mjs'),
    [
      "import { answer } from './src-lib.mjs';",
      "import manifest from './request-manifest.json' with { type: 'json' };",
      'export const result = `${answer}:${manifest.kind}`;',
    ].join('\n') + '\n',
  );
  await writeFile(path.join(root, 'src-lib.mjs'), 'export const answer = 42;\n');
  await writeFile(
    path.join(root, 'request-manifest.json'),
    JSON.stringify({ kind: 'read-only', path: '/read' }) + '\n',
  );
  await writeFile(path.join(root, '.env'), 'DATABASE_URL=must-not-stage\n');
  await writeFile(path.join(root, '.private-secret'), 'do-not-stage\n');
  return { root, outParent };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('hms-stagehand-bundle', () => {
  it('builds identical deterministic fingerprints from identical dirty source', async () => {
    const { root, outParent } = await fixture();
    const first = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'first'),
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });
    const second = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'second'),
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });

    expect(second.manifest.sourceFingerprint).toBe(first.manifest.sourceFingerprint);
    expect(second.manifest.bundleFingerprint).toBe(first.manifest.bundleFingerprint);
    expect(second.manifest.files).toEqual(first.manifest.files);
  });

  it('changes source fingerprint when current dirty source changes', async () => {
    const { root, outParent } = await fixture();
    const first = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'first'),
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });
    await writeFile(path.join(root, 'src-lib.mjs'), 'export const answer = 43;\n');
    const second = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'second'),
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });

    expect(second.manifest.sourceFingerprint).not.toBe(first.manifest.sourceFingerprint);
    expect(second.manifest.bundleFingerprint).not.toBe(first.manifest.bundleFingerprint);
  });

  it('copies requested runtime assets and excludes secret-like files', async () => {
    const { root, outParent } = await fixture();
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'artifact'),
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });
    const stagedManifest = await readFile(
      path.join(result.outputDir, 'request-manifest.json'),
      'utf8',
    );

    expect(JSON.parse(stagedManifest)).toMatchObject({ kind: 'read-only' });
    expect(result.manifest.files.map((file) => file.path)).not.toContain('.env');
    expect(result.manifest.files.map((file) => file.path)).not.toContain('.private-secret');
    expect(result.manifest.files.some((file) => file.role === 'runtime-manifest')).toBe(true);
  });

  it('fails safely for missing entrypoints and missing local imports', async () => {
    const { root, outParent } = await fixture();
    await expect(
      bundleStagehandTrial({
        root,
        out: path.join(outParent, 'missing-entry'),
        entries: ['missing.mjs'],
      }),
    ).rejects.toThrow(/entrypoint.*missing/i);

    await writeFile(
      path.join(root, 'src-main.mjs'),
      "import './missing-local.mjs';\nexport const result = 'never';\n",
    );
    await expect(
      bundleStagehandTrial({
        root,
        out: path.join(outParent, 'missing-import'),
        entries: ['src-main.mjs'],
      }),
    ).rejects.toThrow(/resolve|missing-local|could not/i);
  });

  it('refuses to overwrite a different existing artifact', async () => {
    const { root, outParent } = await fixture();
    const out = path.join(outParent, 'artifact');
    const first = await bundleStagehandTrial({
      root,
      out,
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });
    await writeFile(path.join(root, 'src-lib.mjs'), 'export const answer = 99;\n');

    await expect(
      bundleStagehandTrial({
        root,
        out,
        entries: ['src-main.mjs'],
        manifests: ['request-manifest.json'],
      }),
    ).rejects.toThrow(/different|overwrite|fingerprint/i);
    expect(await readFile(path.join(out, 'bundle-manifest.json'), 'utf8')).toContain(
      first.manifest.bundleFingerprint,
    );
  });

  it('refuses reuse when an existing artifact file was tampered with', async () => {
    const { root, outParent } = await fixture();
    const out = path.join(outParent, 'artifact');
    await bundleStagehandTrial({
      root,
      out,
      entries: ['src-main.mjs'],
      manifests: ['request-manifest.json'],
    });
    await writeFile(path.join(out, 'launch.mjs'), 'tampered\n');

    await expect(
      bundleStagehandTrial({
        root,
        out,
        entries: ['src-main.mjs'],
        manifests: ['request-manifest.json'],
      }),
    ).rejects.toThrow(/integrity|tamper|different/i);
  });

  it('rejects a source edit between bundle snapshots', async () => {
    const { root } = await fixture();
    const before = await captureSourceSnapshot(root, ['src-lib.mjs']);
    await writeFile(path.join(root, 'src-lib.mjs'), 'export const answer = 44;\n');
    const after = await captureSourceSnapshot(root, ['src-lib.mjs']);

    expect(() => assertSourceSnapshotStable(before, after)).toThrow(
      /source changed during bundle/i,
    );
  });

  it('safe-smokes only the two known trial entries with live access disabled', async () => {
    const { root, outParent } = await fixture();
    const connected = 'apps/server-pilot/scripts/hms-standalone-connected-read.ts';
    const discovery = 'apps/server-pilot/scripts/hms-stagehand-read-trial.ts';
    await mkdir(path.join(root, 'apps/server-pilot/scripts'), { recursive: true });
    for (const relative of [connected, discovery]) {
      await writeFile(
        path.join(root, relative),
        "if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw Error('LIVE_DISABLED');\n",
      );
    }
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'safe-smoke'),
      entries: [connected, discovery],
    });

    await expect(preflightKnownBuiltTrialEntries(result.outputDir)).resolves.toEqual([
      { entry: discovery, status: 'LIVE_DISABLED' },
      { entry: connected, status: 'LIVE_DISABLED' },
    ]);
  });

  it('rejects a known entry that fails before its live-disabled guard', async () => {
    const { root, outParent } = await fixture();
    const connected = 'apps/server-pilot/scripts/hms-standalone-connected-read.ts';
    const discovery = 'apps/server-pilot/scripts/hms-stagehand-read-trial.ts';
    await mkdir(path.join(root, 'apps/server-pilot/scripts'), { recursive: true });
    await writeFile(
      path.join(root, connected),
      "throw new ReferenceError('main is not defined');\n",
    );
    await writeFile(
      path.join(root, discovery),
      "if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw Error('LIVE_DISABLED');\n",
    );
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'runtime-failure'),
      entries: [connected, discovery],
    });

    await expect(preflightKnownBuiltTrialEntries(result.outputDir)).rejects.toThrow(
      /import\/runtime failure/i,
    );
  });

  it('safe-smokes a connected-only artifact without requiring discovery entry', async () => {
    const { root, outParent } = await fixture();
    const connected = 'apps/server-pilot/scripts/hms-standalone-connected-read.ts';
    await mkdir(path.join(root, 'apps/server-pilot/scripts'), { recursive: true });
    await writeFile(
      path.join(root, connected),
      "if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw Error('LIVE_DISABLED');\n",
    );
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'connected-only'),
      entries: [connected],
    });

    await expect(preflightKnownBuiltTrialEntries(result.outputDir)).resolves.toEqual([
      { entry: connected, status: 'LIVE_DISABLED' },
    ]);
  });

  it('rejects an artifact with zero known trial entries before spawn', async () => {
    const { root, outParent } = await fixture();
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'zero-known-entries'),
      entries: ['src-main.mjs'],
    });

    await expect(preflightKnownBuiltTrialEntries(result.outputDir)).rejects.toThrow(
      /unknown entry|safe preflight/i,
    );
  });

  it('refuses an artifact that adds an arbitrary entry to the safe-smoke set', async () => {
    const { root, outParent } = await fixture();
    const connected = 'apps/server-pilot/scripts/hms-standalone-connected-read.ts';
    const discovery = 'apps/server-pilot/scripts/hms-stagehand-read-trial.ts';
    await mkdir(path.join(root, 'apps/server-pilot/scripts'), { recursive: true });
    for (const relative of [connected, discovery]) {
      await writeFile(
        path.join(root, relative),
        "if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw Error('LIVE_DISABLED');\n",
      );
    }
    const result = await bundleStagehandTrial({
      root,
      out: path.join(outParent, 'unknown-entry'),
      entries: [connected, discovery, 'src-main.mjs'],
    });

    await expect(preflightKnownBuiltTrialEntries(result.outputDir)).rejects.toThrow(
      /unknown entry|safe preflight/i,
    );
  });

  it('preserves complete pinned Playwright runtime assets', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const outParent = await mkdtemp(path.join(os.tmpdir(), 'hms-stagehand-playwright-output-'));
    tempRoots.push(outParent);
    const result = await bundleStagehandTrial({
      root: repoRoot,
      out: path.join(outParent, 'artifact'),
      entries: ['apps/server-pilot/scripts/hms-standalone-connected-read.ts'],
      external: ['playwright@1.52.0'],
    });
    const playwright = await import(
      pathToFileURL(path.join(result.outputDir, 'node_modules/playwright/index.mjs')).href
    );

    expect(playwright.chromium.name()).toBe('chromium');
    expect(typeof playwright.chromium.launch).toBe('function');
    expect(
      (
        await readFile(
          path.join(
            result.outputDir,
            'node_modules/playwright/node_modules/playwright-core/lib/utils/isomorphic/cssTokenizer.js',
          ),
        )
      ).byteLength,
    ).toBeGreaterThan(0);
  });
});

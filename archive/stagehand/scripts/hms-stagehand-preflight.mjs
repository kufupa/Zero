#!/usr/bin/env node

/**
 * Opt-in, no-credential smoke for one or both named Stagehand trial entries.
 * Never accepts an arbitrary artifact entry: child processes must stop at
 * their own live-disabled guard before any PMS/AWS setup.
 */
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const BUNDLE_SCHEMA_VERSION = 'hms-stagehand-bundle/v1';
export const KNOWN_TRIAL_ENTRIES = Object.freeze([
  'apps/server-pilot/scripts/hms-stagehand-read-trial.ts',
  'apps/server-pilot/scripts/hms-standalone-connected-read.ts',
]);
const PREFLIGHT_TIMEOUT_MS = 10_000;

function safeArtifactPath(artifact, relative) {
  const candidate = path.resolve(artifact, relative);
  const root = path.resolve(artifact) + path.sep;
  if (!candidate.startsWith(root)) throw new Error('artifact path escapes artifact root');
  return candidate;
}

async function readBundleManifest(artifact) {
  const manifestPath = safeArtifactPath(artifact, 'bundle-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('bundle manifest unavailable or invalid');
  }
  if (manifest?.schemaVersion !== BUNDLE_SCHEMA_VERSION || !Array.isArray(manifest.entries)) {
    throw new Error('bundle manifest is not an HMS Stagehand artifact');
  }
  const entries = new Map();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.input !== 'string' ||
      typeof entry.output !== 'string' ||
      entries.has(entry.input)
    ) {
      throw new Error('bundle manifest has invalid entry table');
    }
    entries.set(entry.input, entry.output);
  }
  if (entries.size === 0) throw new Error('safe preflight requires a known trial entry');
  for (const entry of entries.keys()) {
    if (!KNOWN_TRIAL_ENTRIES.includes(entry)) {
      throw new Error('bundle contains unknown entry; safe preflight refused');
    }
    await access(safeArtifactPath(artifact, `entrypoints/${entries.get(entry)}`));
  }
  await access(safeArtifactPath(artifact, 'launch.mjs'));
  return entries;
}

function runGuardedEntry(artifact, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [safeArtifactPath(artifact, 'launch.mjs'), '--entry', entry],
      {
        cwd: path.resolve(artifact),
        // Deliberately omit AWS/HMS/model/database credentials and all other
        // inherited environment. Entry guard must fire before setup.
        env: { PATH: process.env.PATH ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`entry preflight timed out: ${entry}`));
    }, PREFLIGHT_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`entry preflight spawn failed: ${error.code ?? 'spawn_error'}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const guard =
        /LIVE_DISABLED|live(?:\s+discovery)?\s+refused|refused:\s*set\s+HMS_DISCOVERY_ALLOW_LIVE/i.test(
          output,
        );
      if (guard) {
        resolve({
          entry,
          status: /LIVE_DISABLED/i.test(output) ? 'LIVE_DISABLED' : 'REFUSED_LIVE',
        });
        return;
      }
      if (/ReferenceError|Cannot find module|ERR_MODULE_NOT_FOUND|ECONN|ENOTFOUND/i.test(output)) {
        reject(new Error(`entry preflight import/runtime failure: ${entry}`));
        return;
      }
      reject(
        new Error(
          `entry preflight did not hit live guard: ${entry} (${signal ?? `exit ${code ?? 'unknown'}`})`,
        ),
      );
    });
  });
}

export async function preflightKnownBuiltTrialEntries(artifact) {
  if (typeof artifact !== 'string' || artifact.trim() === '') {
    throw new Error('artifact path is required');
  }
  const root = path.resolve(artifact);
  const entries = await readBundleManifest(root);
  const results = [];
  for (const entry of entries.keys()) {
    // Validate launcher mapping before each opt-in child invocation.
    results.push(await runGuardedEntry(root, entry));
  }
  return results;
}

function parseCli(argv) {
  if (argv.length !== 3 || argv[0] !== '--safe-smoke' || argv[1] !== '--artifact') {
    throw new Error('usage: node hms-stagehand-preflight.mjs --safe-smoke --artifact <path>');
  }
  const artifact = argv[2];
  if (!artifact) throw new Error('artifact path is required');
  return artifact;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const artifact = parseCli(process.argv.slice(2));
    const results = await preflightKnownBuiltTrialEntries(artifact);
    console.log(JSON.stringify({ phase: 'safe_smoke', entries: results }, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({
        phase: 'failed',
        error: error instanceof Error ? error.message : 'preflight_failed',
      }),
    );
    process.exitCode = 2;
  }
}

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPropertyRegistration } from '../../tooling/playwright-quote/property-registry.mjs';

export const HMS_SHOTS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HMS_SHOT_NAMES = ['before.png', 'saved.png'] as const;
const DEFAULT_ROOT = '/var/lib/nava/hms-shots';
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOT_NAME_PATTERN = /^(before|saved)\.png$/;

export type HmsShotMeta = { name: string; sha256: string; at: string };

type ShotEnv = NodeJS.Dict<string>;

type PersistInput = {
  propertyCode: string;
  workItemId: string;
  runId: string;
  sourceDir: string;
  owner: string;
  now: number;
  env?: ShotEnv;
};

type ReadInput = {
  runId: string;
  name: string;
  owner: string;
  env?: ShotEnv;
};

type RunIndex = {
  property: string;
  workItemId: string;
  owner: string;
  storedAt: number;
};

/** Absolute dir from HMS_SHOTS_DIR, or the default. Relative / empty / NUL → fail closed (null). */
export function hmsShotsRoot(env: ShotEnv = process.env): string | null {
  const raw = env.HMS_SHOTS_DIR;
  if (raw === undefined || raw.trim() === '') {
    if (env.NODE_ENV === 'test') return null;
    return DEFAULT_ROOT;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\0')) return null;
  return trimmed;
}

function registeredProperty(propertyCode: string): string | null {
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active) return null;
  return property.propertyCode;
}

function underRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`);
}

async function mkdirPrivate(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

function indexPath(root: string, runId: string): string {
  return join(root, 'by-run', `${runId}.json`);
}

function shotDir(root: string, index: Pick<RunIndex, 'property' | 'workItemId'>, runId: string): string {
  return join(root, index.property, index.workItemId, runId);
}

async function readIndex(root: string, runId: string): Promise<RunIndex | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const path = indexPath(root, runId);
  if (!underRoot(root, path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<RunIndex>;
    if (
      typeof raw.property !== 'string' ||
      !registeredProperty(raw.property) ||
      typeof raw.workItemId !== 'string' ||
      !RUN_ID_PATTERN.test(raw.workItemId) ||
      typeof raw.owner !== 'string' ||
      raw.owner.length === 0 ||
      raw.owner.length > 200 ||
      typeof raw.storedAt !== 'number' ||
      !Number.isFinite(raw.storedAt)
    ) {
      return null;
    }
    return {
      property: raw.property,
      workItemId: raw.workItemId,
      owner: raw.owner,
      storedAt: raw.storedAt,
    };
  } catch {
    return null;
  }
}

async function readSourceBytes(sourceDir: string, durableName: string): Promise<Buffer | null> {
  try {
    return await readFile(join(sourceDir, durableName));
  } catch {
    if (durableName === 'before.png') {
      try {
        return await readFile(join(sourceDir, 'filled.png'));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function persistHmsShots(input: PersistInput): Promise<HmsShotMeta[] | null> {
  const root = hmsShotsRoot(input.env);
  const property = registeredProperty(input.propertyCode);
  if (
    !root ||
    !property ||
    !RUN_ID_PATTERN.test(input.workItemId) ||
    !RUN_ID_PATTERN.test(input.runId) ||
    !input.owner ||
    input.owner.length > 200
  ) {
    return null;
  }
  const dest = join(root, property, input.workItemId, input.runId);
  if (!underRoot(root, dest)) {
    return null;
  }
  await mkdirPrivate(join(root, property));
  await mkdirPrivate(join(root, property, input.workItemId));
  await mkdirPrivate(dest);
  await mkdirPrivate(join(root, 'by-run'));
  const at = new Date(input.now).toISOString();
  const shots: HmsShotMeta[] = [];
  for (const name of HMS_SHOT_NAMES) {
    const bytes = await readSourceBytes(input.sourceDir, name);
    if (!bytes) continue;
    const path = join(dest, name);
    if (!underRoot(dest, path)) return null;
    await writeFile(path, bytes, { mode: 0o600 });
    shots.push({
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      at,
    });
  }
  if (shots.length === 0) return null;
  await writeFile(
    indexPath(root, input.runId),
    JSON.stringify({
      property,
      workItemId: input.workItemId,
      owner: input.owner,
      storedAt: input.now,
    } satisfies RunIndex),
    { mode: 0o600 },
  );
  return shots;
}

export async function readStoredHmsShot(input: ReadInput): Promise<Buffer | null> {
  const root = hmsShotsRoot(input.env);
  if (!root || !RUN_ID_PATTERN.test(input.runId) || !SHOT_NAME_PATTERN.test(input.name)) return null;
  const index = await readIndex(root, input.runId);
  if (!index || index.owner !== input.owner) return null;
  const path = join(shotDir(root, index, input.runId), input.name);
  if (!underRoot(root, path)) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** O1 wires the timer. Deletes run dirs whose storedAt is older than 30 days. */
export async function purgeExpiredHmsShots(input: { now: number; env?: ShotEnv }): Promise<void> {
  const root = hmsShotsRoot(input.env);
  if (!root) return;
  const indexDir = join(root, 'by-run');
  let names: string[] = [];
  try {
    names = await readdir(indexDir);
  } catch {
    return;
  }
  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    const runId = file.slice(0, -'.json'.length);
    const index = await readIndex(root, runId);
    if (!index || input.now - index.storedAt <= HMS_SHOTS_TTL_MS) continue;
    const dest = shotDir(root, index, runId);
    if (underRoot(root, dest)) await rm(dest, { recursive: true, force: true }).catch(() => {});
    const idx = indexPath(root, runId);
    if (underRoot(root, idx)) await rm(idx, { force: true }).catch(() => {});
  }
}

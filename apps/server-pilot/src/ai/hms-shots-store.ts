import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';

export const HMS_SHOT_NAMES = ['before.png', 'filled.png', 'saved.png'] as const;
const DEFAULT_ROOT = '/var/lib/nava/hms-shots';
const PROPERTY_CODE = /^[A-Z][A-Z0-9]+$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOT_NAME_PATTERN = /^(before|filled|saved)\.png$/;
const INDEX_MAX_BYTES = 16 * 1024;
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

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

// Bound allocation and reject special files, including a file that grows during the read.
async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset === stat.size ? bytes.subarray(0, offset) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Structural sanity check only: this is not a PNG decoder or CRC validation.
function isPlausiblePng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let dataSeen = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset === PNG_SIGNATURE.length &&
        (type !== 'IHDR' || size !== 13 || bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0)) return false;
    if (type === 'IDAT' && size > 0) dataSeen = true;
    if (type === 'IEND') return dataSeen && size === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

async function readIndex(root: string, runId: string): Promise<RunIndex | null> {
  if (!RUN_ID_PATTERN.test(runId)) return null;
  const path = indexPath(root, runId);
  if (!underRoot(root, path)) return null;
  try {
    const bytes = await readBoundedFile(path, INDEX_MAX_BYTES);
    if (!bytes) return null;
    const raw = JSON.parse(bytes.toString('utf8')) as Partial<RunIndex>;
    if (
      typeof raw.property !== 'string' ||
      !PROPERTY_CODE.test(raw.property) ||
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

/** Verify a retained PNG against its owner, property, work item and full recorded digest. */
export async function verifyStoredHmsShot(input: {
  runId: string; name: string; sha256: string; owner: string; propertyCode: string; workItemId: string;
  env?: ShotEnv;
}, expectedName: (typeof HMS_SHOT_NAMES)[number] = 'filled.png'): Promise<boolean> {
  const root = hmsShotsRoot(input.env);
  if (!root || !RUN_ID_PATTERN.test(input.runId) || input.name !== expectedName || !SHOT_NAME_PATTERN.test(input.name) ||
      !/^[0-9a-f]{64}$/.test(input.sha256)) return false;
  const index = await readIndex(root, input.runId);
  if (!index || index.owner !== input.owner || index.property !== input.propertyCode ||
      index.workItemId !== input.workItemId) return false;
  const path = join(shotDir(root, index, input.runId), input.name);
  if (!underRoot(root, path)) return false;
  const bytes = await readBoundedFile(path, PREVIEW_MAX_BYTES);
  return !!bytes && isPlausiblePng(bytes) && createHash('sha256').update(bytes).digest('hex') === input.sha256;
}

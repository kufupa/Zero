import { lstat, realpath, readdir, rm, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS = 3 * DAY_MS;
export const HMS_SHOTS_MAX_AGE_MS = 30 * DAY_MS;
export const TRACE_WRITE_REFUSAL_PERCENT = 75;
export const DISK_HEALTH_ALERT_PERCENT = 85;

export type PlaywrightQuotePurgeResult = {
  removed: number;
  bytes: number;
};

function assertRetentionRoot(inputRoot: string, suffix: string[], code: string): string {
  const root = resolve(inputRoot);
  const parts = root.split(sep).filter(Boolean);
  if (suffix.some((part, index) => parts[parts.length - suffix.length + index] !== part)) {
    throw new Error(code);
  }
  return root;
}

async function validateRoot(root: string, code: string): Promise<void> {
  const info = await lstat(root).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(code);
  const resolved = await realpath(root).catch(() => null);
  if (resolved !== root) throw new Error(code);
}

async function purgeOldFiles(
  root: string,
  cutoff: number,
  accepts: (name: string) => boolean,
): Promise<PlaywrightQuotePurgeResult> {
  let removed = 0;
  let bytes = 0;

  const walk = async (directory: string): Promise<void> => {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!entry || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.mtimeMs > cutoff || !accepts(name)) continue;
      await rm(path);
      removed += 1;
      bytes += entry.size;
    }
  };

  await walk(root);
  return { removed, bytes };
}

export async function purgeExpiredPlaywrightQuoteZips(
  inputRoot: string,
  now = new Date(),
): Promise<PlaywrightQuotePurgeResult> {
  const root = assertRetentionRoot(
    inputRoot,
    ['.private', 'playwright-quote'],
    'PLAYWRIGHT_QUOTE_PURGE_ROOT_INVALID',
  );
  await validateRoot(root, 'PLAYWRIGHT_QUOTE_PURGE_ROOT_INVALID');
  const cutoff = now.getTime() - PLAYWRIGHT_QUOTE_ZIP_MAX_AGE_MS;
  if (!Number.isFinite(cutoff)) throw new Error('PLAYWRIGHT_QUOTE_PURGE_TIME_INVALID');
  return purgeOldFiles(root, cutoff, (name) => name.endsWith('.zip'));
}

export async function purgeExpiredHmsShots(
  inputRoot: string,
  now = new Date(),
): Promise<PlaywrightQuotePurgeResult> {
  const root = assertRetentionRoot(
    inputRoot,
    ['var', 'lib', 'nava', 'hms-shots'],
    'HMS_SHOTS_PURGE_ROOT_INVALID',
  );
  await validateRoot(root, 'HMS_SHOTS_PURGE_ROOT_INVALID');
  const cutoff = now.getTime() - HMS_SHOTS_MAX_AGE_MS;
  if (!Number.isFinite(cutoff)) throw new Error('HMS_SHOTS_PURGE_TIME_INVALID');
  return purgeOldFiles(root, cutoff, (name) => /\.(?:png|jpe?g|webp)$/i.test(name));
}

export function canWritePlaywrightTraceAtUsage(usedPercent: number | null): boolean {
  return (
    usedPercent !== null &&
    Number.isFinite(usedPercent) &&
    usedPercent >= 0 &&
    usedPercent < TRACE_WRITE_REFUSAL_PERCENT
  );
}

export function diskHealthAlertLine(usedPercent: number | null): string | null {
  if (
    usedPercent === null ||
    !Number.isFinite(usedPercent) ||
    usedPercent < DISK_HEALTH_ALERT_PERCENT
  ) {
    return null;
  }
  return `High disk usage: ${Math.ceil(usedPercent)}% used. Free server space.`;
}

export async function readDiskUsedPercent(path = '/'): Promise<number | null> {
  try {
    const usage = await statfs(path);
    const total = Number(usage.blocks);
    const free = Number(usage.bfree);
    const available = Number(usage.bavail);
    const used = total - free;
    const usable = used + available;
    if (
      !Number.isFinite(total) ||
      !Number.isFinite(free) ||
      !Number.isFinite(available) ||
      total <= 0 ||
      free < 0 ||
      free > total ||
      available < 0 ||
      available > free ||
      used < 0 ||
      usable <= 0
    ) {
      return null;
    }
    return (used / usable) * 100;
  } catch {
    return null;
  }
}

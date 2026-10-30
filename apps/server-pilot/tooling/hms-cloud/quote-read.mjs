// Compose a live Hotel Availability read with a private, bounded quote view.
import { lstat, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { searchHotelAvailability } from './hotel-availability.mjs';
import { getQuoteView, roomQuantityIssue } from './quote-view.mjs';

/** Keep the full snapshot privately; return only the requested quote page. */
export async function readQuote(page, { criteria, roomQuantity, roomCount, quantity, view = {}, snapshotPath } = {}) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) ||
      !view || typeof view !== 'object' || Array.isArray(view) ||
      typeof snapshotPath !== 'string' || !snapshotPath.trim()) {
    return { outcome: 'input_gap', issue: 'QUOTE_INPUT_REQUIRED' };
  }
  const issue = roomQuantityIssue(criteria, { roomQuantity, roomCount, quantity });
  if (issue) return { outcome: 'input_gap', issue };
  if (['roomQuantity', 'roomCount', 'quantity'].some((key) => Object.hasOwn(view, key))) {
    return { outcome: 'input_gap', issue: 'ROOM_QUANTITY_IN_VIEW' };
  }
  const requestedPath = resolve(snapshotPath);
  let path;
  try {
    const directoryPath = await realpath(dirname(requestedPath));
    const directory = await stat(directoryPath);
    if (!directory.isDirectory() || (directory.mode & 0o077) ||
        (typeof process.getuid === 'function' && directory.uid !== process.getuid())) {
      return { outcome: 'input_gap', issue: 'OUTPUT_DIRECTORY_NOT_PRIVATE' };
    }
    for (let ancestor = directoryPath; ; ancestor = dirname(ancestor)) {
      try {
        await lstat(join(ancestor, '.git'));
        return { outcome: 'input_gap', issue: 'OUTPUT_DIRECTORY_IN_GIT_WORKTREE' };
      } catch (error) {
        if (error?.code !== 'ENOENT') return { outcome: 'input_gap', issue: 'OUTPUT_DIRECTORY_NOT_PRIVATE' };
      }
      if (dirname(ancestor) === ancestor) break;
    }
    path = join(directoryPath, basename(requestedPath));
  } catch {
    return { outcome: 'input_gap', issue: 'OUTPUT_DIRECTORY_NOT_PRIVATE' };
  }
  const requested = { ...criteria, ...(roomQuantity == null ? {} : { roomQuantity }) };
  const result = await searchHotelAvailability(page, requested);
  if (result.outcome !== 'ok' && result.outcome !== 'criteria_unavailable') return result;
  try {
    await writeFile(path, `${JSON.stringify(result.snapshot)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    return { outcome: 'execution_failure', issue: 'PRIVATE_SNAPSHOT_WRITE_FAILED' };
  }
  try {
    return { outcome: result.outcome, ...(result.issue ? { issue: result.issue } : {}), snapshotPath: path,
      view: getQuoteView(result.snapshot, { ...view, roomQuantity }) };
  } catch (error) {
    const message = String(error?.message || '');
    return { outcome: 'execution_failure', snapshotPath: path,
      issue: /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'QUOTE_PROJECTION_FAILED' };
  }
}

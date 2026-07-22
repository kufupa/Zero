import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when this ESM module is the process entrypoint.
 * Covers direct `node file.js` and PM2 fork (argv[1] = ProcessContainerFork.js).
 */
export function isCliEntry(importMetaUrl: string, pm2AppName?: string): boolean {
  const thisFile = fileURLToPath(importMetaUrl);
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      if (path.resolve(argv1) === thisFile) return true;
      if (importMetaUrl === pathToFileURL(path.resolve(argv1)).href) return true;
    } catch {
      /* ignore bad argv paths */
    }
  }
  const pmExec = process.env.pm_exec_path;
  if (pmExec) {
    try {
      if (path.resolve(pmExec) === thisFile) return true;
    } catch {
      /* ignore */
    }
  }
  // PM2: argv[1] is ProcessContainerFork.js; ecosystem sets name + pm_id
  if (
    pm2AppName &&
    process.env.pm_id !== undefined &&
    process.env.name === pm2AppName
  ) {
    return true;
  }
  return false;
}

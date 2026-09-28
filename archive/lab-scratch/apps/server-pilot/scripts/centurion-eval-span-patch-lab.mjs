#!/usr/bin/env node
/** Thin runner so `node …span-patch-lab.mjs` still works. Counts on stdout. No PII. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', path.join(here, 'centurion-eval-span-patch-lab.ts')],
  { stdio: 'inherit', cwd: path.join(here, '..'), env: process.env },
);
process.exit(result.status ?? 1);

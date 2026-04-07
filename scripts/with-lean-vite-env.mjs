#!/usr/bin/env node
/**
 * Sets ZERO_DISABLE_* lean Vite toggles, then runs the command after `--`.
 * Cross-platform (Windows does not support VAR=value cmd prefixes in npm scripts).
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dash = process.argv.indexOf('--');
const cmd = dash === -1 ? [] : process.argv.slice(dash + 1);

if (cmd.length === 0) {
  console.error('usage: node ./scripts/with-lean-vite-env.mjs -- <command> [args...]');
  process.exit(1);
}

const env = {
  ...process.env,
  ZERO_DISABLE_OXLINT: '1',
  ZERO_DISABLE_REACT_COMPILER: '1',
  ZERO_DISABLE_VITE_WARMUP: '1',
};

const r = spawnSync(cmd[0], cmd.slice(1), {
  stdio: 'inherit',
  env,
  shell: true,
  cwd: root,
});

process.exit(r.status ?? 1);

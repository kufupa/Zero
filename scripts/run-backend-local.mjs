#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const has = (bin) => {
  const check = spawnSync(`${bin} --version`, { shell: true, stdio: 'ignore' });
  return check.status === 0;
};

const packageManager = has('pnpm') ? 'pnpm' : has('npm') ? 'npm' : null;

if (!packageManager) {
  console.error('No package manager found. Install npm or pnpm, then run:');
  console.error('npm --prefix apps/server run dev');
  process.exit(1);
}

const cmd = packageManager === 'pnpm'
  ? 'pnpm --dir apps/server run dev'
  : 'npm --prefix apps/server run dev';

const child = spawnSync(cmd, {
  shell: true,
  stdio: 'inherit',
  env: process.env,
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);

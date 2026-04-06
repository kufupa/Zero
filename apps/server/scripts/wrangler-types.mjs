import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerCli = join(serverRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const baseConfig = join(serverRoot, 'wrangler.jsonc');

if (!existsSync(wranglerCli)) {
  console.error('wrangler CLI not found at', wranglerCli);
  process.exit(1);
}

// Types must use the full base config only; merging wrangler.local.jsonc (hyperdrive-only) drops `main`.
const args = ['types', '--env', 'local', '-c', baseConfig];

const child = spawn(process.execPath, [wranglerCli, ...args], {
  stdio: 'inherit',
  cwd: serverRoot,
  shell: false,
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});

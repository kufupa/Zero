import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerCli = join(serverRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const baseConfig = join(serverRoot, 'wrangler.jsonc');
const localConfig = join(serverRoot, 'wrangler.local.jsonc');

if (!existsSync(wranglerCli)) {
  console.error('wrangler CLI not found at', wranglerCli);
  process.exit(1);
}

// One config only: merged -c base + -c local registered two Workers and broke dev.
const configPath = existsSync(localConfig) ? localConfig : baseConfig;
const args = ['dev', '-c', configPath];
args.push(
  '--show-interactive-dev-session=false',
  '--experimental-vectorize-bind-to-prod',
  '--env',
  'local',
);

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

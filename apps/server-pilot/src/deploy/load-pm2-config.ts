import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const deployDir = join(here, '..', '..', 'deploy');

export type Pm2App = {
  name: string;
  script: string;
  cwd: string;
  instances: number;
  autorestart?: boolean;
};

export type Pm2Config = {
  apps: Pm2App[];
};

/** Load PM2 config from deploy/pm2.config.cjs for deploy tests. */
export function loadPm2Config(): Pm2Config {
  const require = createRequire(import.meta.url);
  const configPath = join(deployDir, 'pm2.config.cjs');
  return require(configPath) as Pm2Config;
}

/** Read nginx.conf text for deploy validation. */
export function readNginxConfig(): string {
  return readFileSync(join(deployDir, 'nginx.conf'), 'utf8');
}

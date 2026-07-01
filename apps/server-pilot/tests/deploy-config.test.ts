import { describe, expect, it } from 'vitest';

describe('deploy config', () => {
  it('runs exactly one worker', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    expect(pm2.apps.filter((app) => app.name === 'worker')).toHaveLength(1);
    expect(pm2.apps.find((app) => app.name === 'worker')?.instances).toBe(1);
    expect(pm2.apps.filter((app) => app.name === 'http')).toHaveLength(1);
  });

  it('nginx config proxies /api to localhost:8788', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const nginx = readFileSync(join(here, '..', 'deploy', 'nginx.conf'), 'utf8');
    expect(nginx).toContain('listen 443 ssl');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(nginx).toContain('try_files $uri /index.html');
  });
});

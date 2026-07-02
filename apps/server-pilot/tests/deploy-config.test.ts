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
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    expect(nginx).toContain('listen 443 ssl');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(nginx).toContain('try_files $uri /index.html');
  });

  it('nginx config redirects HTTP to HTTPS and sets security headers', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    expect(nginx).toContain('listen 80');
    expect(nginx).toContain('return 301 https://$host$request_uri');
    expect(nginx).toContain(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always',
    );
    expect(nginx).toContain('add_header X-Frame-Options "DENY" always');
    expect(nginx).toContain('add_header X-Content-Type-Options "nosniff" always');
    expect(nginx).toContain(
      'add_header Referrer-Policy "strict-origin-when-cross-origin" always',
    );
    expect(nginx).toContain(
      "add_header Content-Security-Policy \"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none';\" always",
    );
  });

  it('deploy-ec2.sh syncs nginx config and reloads', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('deploy/nginx.conf');
    expect(deploy).toContain('sudo nginx -t && sudo systemctl reload nginx');
    expect(deploy).toContain('nginx not installed');
  });
});

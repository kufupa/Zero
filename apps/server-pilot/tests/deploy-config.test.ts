import { describe, expect, it } from 'vitest';

describe('deploy config', () => {
  it('runs worker with bounded autorestart policy', async () => {
    const { loadPm2Config } = await import('../src/deploy/load-pm2-config.js');
    const pm2 = loadPm2Config();
    expect(pm2.apps.filter((app) => app.name === 'worker')).toHaveLength(1);
    const worker = pm2.apps.find((app) => app.name === 'worker');
    expect(worker?.instances).toBe(1);
    expect(worker?.autorestart).toBe(true);
    expect(worker?.max_restarts).toBe(10);
    expect(pm2.apps.filter((app) => app.name === 'http')).toHaveLength(1);
    const http = pm2.apps.find((app) => app.name === 'http');
    expect(http?.autorestart).toBe(true);
    expect(http?.max_restarts).toBe(10);
    expect(http?.min_uptime).toBe(10_000);
    expect(pm2.apps.filter((app) => app.name === 'ai-worker')).toHaveLength(1);
    const aiWorker = pm2.apps.find((app) => app.name === 'ai-worker');
    expect(aiWorker?.env?.AI_ENABLED).toBe('true');
    expect(aiWorker?.env?.BEDROCK_REGION).toBe('us-east-1');
    expect(aiWorker?.env?.SMTP_HOST).toBeUndefined();
    expect(aiWorker?.env?.POP3_HOST).toBeUndefined();
  });

  it('nginx config proxies /api to localhost:8788', async () => {
    const { readNginxConfig } = await import('../src/deploy/load-pm2-config.js');
    const nginx = readNginxConfig();
    expect(nginx).toContain('listen 443 ssl');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:8788/api/');
    expect(nginx).toContain('try_files $uri /index.html');
    expect(nginx).toContain('client_max_body_size 35m');
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

  it('write-ec2-env.sh quotes all env values', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('quote_val()');
    expect(script).toContain("NODE_ENV='production'");
    expect(script).toContain('DATABASE_URL=$(quote_val "$DATABASE_URL")');
    expect(script).toContain('BETTER_AUTH_SECRET=$(quote_val "$BETTER_AUTH_SECRET")');
  });

  it('write-ec2-env.sh persists SMTP password and AI gates', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('append_env SMTP_USER');
    expect(script).toContain('append_env SMTP_PASSWORD');
    expect(script).toContain('append_env AI_DRAFTS_ENABLED');
    expect(script).toContain('append_env AI_WRITE_GATE_ENABLED');
  });

  it('FakeSmtpTransport ring buffer caps at 100', async () => {
    const { FakeSmtpTransport, FAKE_SMTP_RING_MAX } = await import(
      '../src/mail/send/smtp.js'
    );
    expect(FAKE_SMTP_RING_MAX).toBe(100);
    const fake = new FakeSmtpTransport();
    const payload = {
      from: 'a@b.c',
      to: ['d@e.f'],
      cc: [] as string[],
      bcc: [] as string[],
      subject: 'x',
      html: '',
      text: 'x',
    };
    for (let i = 0; i < 110; i++) {
      await fake.send(payload);
    }
    expect(fake.sent).toHaveLength(100);
  });

  it('main.ts registers SIGTERM graceful shutdown with closeDb', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toContain("process.on('SIGTERM'");
    expect(main).toContain('server.close');
    expect(main).toContain('closeDb');
  });

  it('deploy-ec2.sh picks latest nvm node via version sort', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toMatch(/sort -V \| tail -1/);
  });

  it('deploy-ec2.sh retries health check with backoff', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('health attempt');
    expect(deploy).toMatch(/seq 1 10/);
  });

  it('ssm-run-command.sh caps poll duration and empty-status spins', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'ssm-run-command.sh'), 'utf8');
    expect(script).toContain('SSM_MAX_POLL_SECONDS');
    expect(script).toContain('SSM_MAX_EMPTY_POLLS');
  });

  it('rds-smoke.sh falls back to postgres npm package when psql missing', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'rds-smoke.sh'), 'utf8');
    expect(script).toContain('postgres npm package');
    expect(script).not.toContain('require("pg")');
    expect(script).toContain('import postgres from "postgres"');
  });

  it('mailbox_access schema has is_default column', async () => {
    const { mailboxAccess } = await import('../src/db/schema/mail.js');
    expect(mailboxAccess.isDefault).toBeDefined();
  });

  it('deploy-ec2.sh installs pm2-startup and deletes fixture worker', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    expect(deploy).toContain('pm2-startup.sh');
    expect(deploy).toContain('pm2 delete worker');
    expect(deploy).toContain('MAIL_TRANSPORT_MODE');
    expect(deploy).toContain('fixture');
  });

  it('pm2-boot.sh sources nvm and env then resurrect or startOrReload', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const boot = readFileSync(join(here, '..', 'deploy', 'pm2-boot.sh'), 'utf8');
    expect(boot).toContain('nvm.sh');
    expect(boot).toContain('.env.production');
    expect(boot).toContain('pm2 resurrect');
    expect(boot).toContain('startOrReload');
  });

  it('post-boot-smoke.sh checks :8788 and :443 not :3000', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const smoke = readFileSync(join(here, '..', 'deploy', 'post-boot-smoke.sh'), 'utf8');
    expect(smoke).toContain('127.0.0.1:8788/health');
    expect(smoke).toContain('https://127.0.0.1');
    expect(smoke).not.toContain(':3000');
    expect(smoke).toContain('systemctl is-active');
  });

  it('ops-deploy.sh syncs then SSM deploy-ec2 with optional migrate', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');
    expect(ops).toContain('sync-ec2-git-bundle.sh');
    expect(ops).toContain('ssm-run-command.sh');
    expect(ops).toContain('deploy-ec2.sh');
    expect(ops).toContain('--migrate');
    expect(ops).toContain('db:migrate');
  });

  it('ops-restart.sh reloads pm2 via SSM without sync', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-restart.sh'), 'utf8');
    expect(ops).toContain('ssm-run-command.sh');
    expect(ops).toContain('startOrReload');
    expect(ops).not.toContain('sync-ec2-git-bundle');
  });

  it('ops-reboot.sh reboots instance then runs post-boot-smoke', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-reboot.sh'), 'utf8');
    expect(ops).toContain('reboot-instances');
    expect(ops).toContain('post-boot-smoke.sh');
    expect(ops).toContain('ssm-run-command.sh');
  });

  it('pilot-db-wipe.sh requires CONFIRM=WIPE_PILOT_DB and passes bash -n', async () => {
    const { readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'pilot-db-wipe.sh');
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('CONFIRM=WIPE_PILOT_DB');
    expect(script).toContain('exit 2');
    expect(script).toContain('/var/lib/nava-pilot/wipe-navaai.ok');
    expect(script).toContain('TRUNCATE TABLE');
    expect(script).toContain('mail_ingest_mailbox');
    expect(script).not.toMatch(/\bTRUNCATE TABLE[\s\S]*\buser\b/i);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    // Refuse without confirm: exit 2 before any DB touch (no DATABASE_URL needed).
    const refuse = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CONFIRM: '', DATABASE_URL: '' },
    });
    expect(refuse.status).toBe(2);
    expect(refuse.stderr).toMatch(/CONFIRM=WIPE_PILOT_DB/);
  });
});

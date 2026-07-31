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
      "add_header Content-Security-Policy \"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';\" always",
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

  it('preserves the Infor hostname mapping used by the split tunnel', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');

    expect(deploy).toContain('appsrv-1.legacyhotels.co.za');
    expect(deploy).toContain('172.24.240.41');
  });

  it('uses BETTER_AUTH_URL as the only production app-origin source', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const writer = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');

    expect(writer).toContain(
      ': "${BETTER_AUTH_URL:=https://nava.legacyhotels.co.za}"',
    );
    expect(deploy).toContain(
      ': "${BETTER_AUTH_URL:?BETTER_AUTH_URL required before SPA build}"',
    );
    expect(deploy).toContain(
      'export VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-$BETTER_AUTH_URL}"',
    );
    expect(deploy).toContain('127.0.0.1 nava.legacyhotels.co.za');
    expect(deploy).not.toContain('127.0.0.1 nava.legacy.local');
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
    expect(script).toContain('AI_WRITE_GATE_ENABLED:-true');
    expect(script).toMatch(/MAIL_TRANSPORT_MODE:-fixture\}" == "real"/);
  });

  it('write-ec2-env.sh writes UNDO_SEND_SECONDS', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(join(here, '..', 'deploy', 'write-ec2-env.sh'), 'utf8');
    expect(script).toContain('UNDO_SEND_SECONDS');
    expect(script).toMatch(/UNDO_SEND_SECONDS:=20/);
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
    expect(deploy).toContain('pm2 start');
    expect(deploy).toContain('MAIL_TRANSPORT_MODE');
    expect(deploy).toContain('fixture');
    // startOrReload keeps stale process env after fixture→real cutover.
    expect(deploy).not.toContain('startOrReload');
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

  it('quiesced deploy builds assets, asserts workers stopped, skips PM2/health, keeps VPN', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deploy = readFileSync(join(here, '..', 'deploy', 'deploy-ec2.sh'), 'utf8');
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-deploy.sh'), 'utf8');

    /** Depth-aware if/fi — full QUIESCED branch, not first nested fi. */
    const extractBashIfBlock = (script: string, conditionRe: RegExp): string | null => {
      const match = script.match(conditionRe);
      if (!match || match.index == null) return null;
      const lines = script.slice(match.index).split(/\r?\n/);
      let depth = 0;
      const collected: string[] = [];
      for (const line of lines) {
        collected.push(line);
        if (/^\s*if\b/.test(line)) depth += 1;
        if (/^\s*fi\b/.test(line)) {
          depth -= 1;
          if (depth === 0) return collected.join('\n');
        }
      }
      return null;
    };

    expect(deploy).toContain('--quiesced');
    expect(ops).toContain('--quiesced');
    expect(ops).toContain('vpn-health-assert.sh');

    const deployQuiesced = extractBashIfBlock(
      deploy,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(deployQuiesced, 'deploy-ec2.sh QUIESCED branch').toBeTruthy();
    expect(deployQuiesced).toContain('quiesced deploy ok');
    expect(deployQuiesced).toMatch(/exit 0/);
    expect(deployQuiesced).toMatch(/http/);
    expect(deployQuiesced).toMatch(/worker/);
    expect(deployQuiesced).toMatch(/ai-worker/);
    // Refuse any non-stopped status (errored/stopping/online/launching/…).
    expect(deployQuiesced).toMatch(/"\$status"\s*!=\s*"stopped"/);
    expect(deployQuiesced).not.toMatch(/"\$status"\s*=\s*"online"/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+start\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+delete\b/);
    expect(deployQuiesced).not.toMatch(/\bpm2\s+save\b/);
    expect(deployQuiesced).not.toMatch(/health attempt|8788\/health/);

    // Non-quiesced path still has PM2 start + health (launch safety).
    expect(deploy).toContain('pm2 start');
    expect(deploy).toContain('health attempt');

    const opsQuiesced = extractBashIfBlock(
      ops,
      /if\s+\[\s*"\$\{?QUIESCED\}?"\s*=\s*"1"\s*\]/,
    );
    expect(opsQuiesced, 'ops-deploy.sh QUIESCED branch').toBeTruthy();
    expect(opsQuiesced).toContain('deploy-ec2.sh --quiesced');
    expect(opsQuiesced).not.toMatch(/curl[^\n]*\/health/);
    expect(ops).toMatch(/deploy-ec2\.sh --quiesced|deploy-ec2\.sh"\s*--quiesced/);
  });

  it('ops-restart.sh reloads pm2 via SSM without sync', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const ops = readFileSync(join(here, '..', 'deploy', 'ops-restart.sh'), 'utf8');
    expect(ops).toContain('ssm-run-command.sh');
    // delete+start refreshes process env; startOrReload kept stale MAIL_* after fixture→real.
    expect(ops).toContain('pm2 delete');
    expect(ops).toContain('pm2 start');
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

  it('pilot-db-wipe.sh requires CONFIRM_PILOT_WIPE=1 and passes bash -n', async () => {
    const { readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'pilot-db-wipe.sh');
    const script = readFileSync(scriptPath, 'utf8');
    expect(script).toContain('CONFIRM_PILOT_WIPE=1');
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
      env: { ...process.env, CONFIRM_PILOT_WIPE: '', DATABASE_URL: '' },
    });
    expect(refuse.status).toBe(2);
    expect(refuse.stderr).toMatch(/CONFIRM_PILOT_WIPE=1/);
  });

  it('activate-real-mail.sh probes ports, SMTP auth smoke, staged password wins', async () => {
    const { readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'scripts', 'activate-real-mail.sh');
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('POP3_HOST:=172.24.0.10');
    expect(script).toContain('SMTP_HOST:=172.24.0.10');
    expect(script).toContain('POP3_USER:=navaai@legacyhotels.co.za');
    expect(script).toContain('SMTP_USER:=navaai@legacyhotels.co.za');

    // Staged passwords saved before source; restored after (staged wins).
    expect(script).toContain('STAGED_POP3_PASSWORD="${POP3_PASSWORD:-}"');
    expect(script).toContain('STAGED_SMTP_PASSWORD="${SMTP_PASSWORD:-}"');
    expect(script).toMatch(
      /STAGED_POP3_PASSWORD[\s\S]*source[\s\S]*\.env\.production[\s\S]*STAGED_POP3_PASSWORD/,
    );
    expect(script).toContain('export POP3_PASSWORD="${STAGED_POP3_PASSWORD}"');
    expect(script).toContain('export SMTP_PASSWORD="${STAGED_SMTP_PASSWORD}"');

    // Port probe loop: POP3 995→110, SMTP 587→25; fail closed.
    expect(script).toContain('for candidate in 995 110');
    expect(script).toContain('for candidate in 587 25');
    expect(script).toContain('POP3 port probe failed');
    expect(script).toContain('SMTP port probe failed');
    expect(script).toContain('POP3_TLS=true');
    expect(script).toContain('POP3_TLS=false');
    expect(script).toContain('SMTP_SECURE=false');

    // SMTP auth smoke (not EHLO-only bare verify); TLS insecure gate for hotel certs.
    expect(script).toContain('auth: { user, pass }');
    expect(script).toContain('SMTP auth OK');
    expect(script).not.toContain('SMTP EHLO OK');
    expect(script).toContain('transporter.verify()');
    expect(script).toContain('MAIL_TLS_REJECT_UNAUTHORIZED');
    expect(script).toContain('tls: { rejectUnauthorized }');
    expect(script).toContain('trying next candidate');

    expect(script).toContain('export AI_DRAFTS_ENABLED=false');
    expect(script).toContain('export AI_WRITE_GATE_ENABLED=true');

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
  });

  it('production-env vitest gates require a disposable test database', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');

    const sourcesProductionEnv = (script: string) =>
      script.includes('.env.production') &&
      (script.includes('source "$ENV_FILE"') ||
        script.includes('source /home/ubuntu/.env.production') ||
        script.includes('source .env.production'));

    const invokesVitest = (script: string) =>
      /\bpnpm test\b/.test(script) || /\bpnpm exec vitest\b/.test(script);

    // AI/Bedrock gates stay DB-free and do not source production DB settings into Vitest.
    const dbFreeGateNames = new Set(['ai-gate.sh', 'bedrock-live-gate.sh']);

    const rdsVitestGates = readdirSync(deployDir)
      .filter((name) => name.endsWith('.sh'))
      .filter((name) => !dbFreeGateNames.has(name))
      .filter((name) => {
        const script = readFileSync(join(deployDir, name), 'utf8');
        return sourcesProductionEnv(script) && invokesVitest(script);
      });

    expect(rdsVitestGates.length).toBeGreaterThanOrEqual(3);
    for (const name of rdsVitestGates) {
      const script = readFileSync(join(deployDir, name), 'utf8');
      expect(script, `${name} must require TEST_DATABASE_URL`).toContain(
        'TEST_DATABASE_URL',
      );
      expect(script, `${name} must replace inherited DATABASE_URL`).toContain(
        'export DATABASE_URL="$TEST_DATABASE_URL"',
      );
      expect(script, `${name} must clear the legacy escape hatch`).toContain(
        'unset VITEST_ALLOW_PILOT_RDS',
      );
      expect(script, `${name} must never export the legacy escape hatch`).not.toContain(
        'export VITEST_ALLOW_PILOT_RDS=1',
      );
      expect(script, `${name} must use pnpm exec vitest run`).toContain(
        'pnpm exec vitest run',
      );
    }

    for (const name of [
      'mail-search-gate.sh',
      'fixture-loopback-gate.sh',
      'wire-gate.sh',
    ]) {
      expect(rdsVitestGates, `expected ${name} in RDS vitest gates`).toContain(
        name,
      );
    }
  });

  it('AI and Bedrock gates never bypass pilot-RDS Vitest guard', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const deployDir = join(here, '..', 'deploy');

    const aiGate = readFileSync(join(deployDir, 'ai-gate.sh'), 'utf8');
    const bedrockGate = readFileSync(join(deployDir, 'bedrock-live-gate.sh'), 'utf8');

    for (const [name, script] of [
      ['ai-gate.sh', aiGate],
      ['bedrock-live-gate.sh', bedrockGate],
    ] as const) {
      expect(script, `${name} must not set VITEST_ALLOW_PILOT_RDS=1`).not.toContain(
        'VITEST_ALLOW_PILOT_RDS=1',
      );
      expect(script, `${name} must unset DATABASE_URL and VITEST_ALLOW_PILOT_RDS`).toMatch(
        /unset\s+DATABASE_URL\s+VITEST_ALLOW_PILOT_RDS/,
      );
    }

    // ai-gate is DB-free: never source production env into Vitest.
    expect(aiGate).not.toMatch(/source\s+"?\$\{?ENV_FILE/);
    expect(aiGate).not.toContain('source .env.production');
    expect(aiGate).toContain('pnpm exec vitest run');

    // bedrock-live may source Bedrock/AWS settings, but must never invoke Vitest.
    expect(bedrockGate).not.toMatch(/\bpnpm exec vitest\b/);
    expect(bedrockGate).not.toMatch(/\bpnpm test\b/);
    expect(bedrockGate).toContain('bedrock-live-smoke');
    expect(bedrockGate).toMatch(/\btsx\b/);
  });

  it('stage-navaai-mail-env.sh refuses REPLACE_ and keeps password out of SSM argv', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'stage-navaai-mail-env.sh');
    const script = readFileSync(scriptPath, 'utf8');

    expect(script).toContain('navaai-mail-pass.txt');
    expect(script).toContain('REPLACE_');
    expect(script).toContain('mail-navaai');
    expect(script).toContain('/run/nava-mail/password');
    expect(script).toContain('chmod 600');
    expect(script).toContain('chown root:root');
    expect(script).toContain('STAGED_OK');
    expect(script).toContain('ssm-run-command.sh');
    expect(script).toContain('AWS_REGION:=af-south-1');
    expect(script).toContain('INSTANCE_ID:=i-008f737974a9ba9b3');

    // SSM installs via S3 cp as ubuntu (IMDS), then sudo cp into /run —
    // password bytes never interpolated into SYNC_CMD. sudo aws drops role → 403.
    expect(script).toContain('aws s3 cp "\\$S3_PREFIX/password"');
    expect(script).toContain('sudo cp "\\$TMP_PASS" /run/nava-mail/password');
    expect(script).not.toContain('sudo aws s3 cp');
    expect(script).not.toMatch(/ssm-run-command\.sh[^]*\$\(cat/);
    expect(script).not.toMatch(/echo\s+"?\$\{?(PASS|PASSWORD)/i);
    expect(script).not.toMatch(/\bcat\b[^\n]*\/run\/nava-mail\/password/);
    expect(script).not.toMatch(/SYNC_CMD=[\s\S]*PASS_FILE/);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);

    const mailDir = mkdtempSync(join(tmpdir(), 'nava-mail-stage-test-'));
    try {
      writeFileSync(
        join(mailDir, 'navaai-mail-pass.txt'),
        'REPLACE_WITH_NAVAAI_MAILBOX_PASSWORD\n',
        'utf8',
      );
      const refuse = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, MAIL_DIR: mailDir },
      });
      expect(refuse.status).toBe(2);
      expect(refuse.stderr).toMatch(/placeholder/i);
      expect(refuse.stdout).not.toMatch(/REPLACE_WITH_NAVAAI/);
    } finally {
      rmSync(mailDir, { recursive: true, force: true });
    }

    const missingDir = mkdtempSync(join(tmpdir(), 'nava-mail-stage-missing-'));
    try {
      const missing = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, MAIL_DIR: missingDir },
      });
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/missing/i);
    } finally {
      rmSync(missingDir, { recursive: true, force: true });
    }
  });

  it('launch-readiness.sh is strict, redacted, read-only, and syntactically valid', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(here, '..', 'deploy', 'launch-readiness.sh');
    const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';

    expect(script).toContain('REQUIRE_HOTEL_PROBE=1');
    expect(script).toContain('RDS_INSTANCE_ID:=nava-zero-mail-pilot');
    expect(script).toContain('S3_BUCKET:=nava-zero-mail-845242190536-af-south-1');
    expect(script).toContain('MAIL_TRANSPORT_MODE');
    expect(script).toContain('BETTER_AUTH_URL');
    expect(script).toContain('UNDO_SEND_SECONDS');
    expect(script).toContain('AI_WRITE_GATE_ENABLED');
    expect(script).toContain('AI_DRAFTS_ENABLED');
    expect(script).toContain('monitoringMode');
    expect(script).toContain('deletionProtection');
    expect(script).toContain('multiAZ');
    expect(script).toContain('latestInboundAt');
    expect(script).toContain('backupLatestRestorableAt');
    expect(script).not.toMatch(/\bset\s+-x\b/);
    expect(script).not.toMatch(
      /(?:echo|printf)[^\n]*(?:DATABASE_URL|PASSWORD|SECRET_ARN|SECRET_STRING)/,
    );
    expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);

    const syntax = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
  });

  it('real-mail UI gate has a non-mutating read-only mode', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(
      join(here, '..', 'deploy', 'playwright-real-mail-ui-gate.sh'),
      'utf8',
    );

    expect(script).toContain('--read-only');
    expect(script).toContain('READ_ONLY=1');
    expect(script).toContain('EXPECTED_UNDO_SEND_SECONDS=30');
    expect(script).toContain('READ_ONLY_SPECS=(');
    const readOnlySpecs = script.match(/READ_ONLY_SPECS=\(([\s\S]*?)\)/)?.[1] ?? '';
    expect(readOnlySpecs).toContain('real-mail-browser-login');
    expect(readOnlySpecs).toContain('real-mail-launch-readonly');
    expect(readOnlySpecs).not.toMatch(/compose|reply|force-sync|forceSync|send/i);
    expect(script).not.toContain('api/auth/sign-in/email');
    expect(script).not.toMatch(/echo[^\n]*PLAYWRIGHT_REAL_MAIL_PASSWORD/);
  });

  it('task-owned operations files never stage the whole worktree', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..');
    const paths = [
      join(here, '..', 'deploy', 'launch-readiness.sh'),
      join(here, '..', 'deploy', 'playwright-real-mail-ui-gate.sh'),
      join(repoRoot, 'docs', 'runbooks', 'centurion-day-one-operations.md'),
    ];

    for (const path of paths) {
      const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
      expect(source, path).not.toMatch(/\bgit\s+add\s+(?:\.|-A|--all)(?:\s|$)/m);
    }
  });

  it('private production and SDD artifacts are ignored', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const gitignore = readFileSync(join(here, '..', '..', '..', '.gitignore'), 'utf8');

    expect(gitignore).toContain('live real data connection/');
    expect(gitignore).toContain('Nava.ovpn');
    expect(gitignore).toContain('Nava.zip');
    expect(gitignore).toContain('.cursor/debug-*.log');
    expect(gitignore).toContain('.superpowers/sdd/');
  });
});

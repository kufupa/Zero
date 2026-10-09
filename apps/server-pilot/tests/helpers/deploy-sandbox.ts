import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// apps/server-pilot, the package root this helper copies deploy scripts from.
const serverRoot = fileURLToPath(new URL('../../', import.meta.url));

// Real schema/ledger throughout. Only external operational commands are local adapters.
export function deploymentSandbox(url: string) {
  const root = mkdtempSync(join(tmpdir(), 'zero-schema-deploy-'));
  const repo = join(root, 'repo');
  const server = join(repo, 'apps/server-pilot');
  const deploy = join(server, 'deploy');
  const bin = join(root, 'bin');
  const marker = join(root, 'activation');
  mkdirSync(deploy, { recursive: true });
  mkdirSync(bin);
  for (const dir of ['src', 'scripts', 'drizzle', 'node_modules']) {
    symlinkSync(join(serverRoot, dir), join(server, dir));
  }
  for (const file of [
    'deploy-ec2.sh',
    'ops-deploy.sh',
    'ops-restart.sh',
    'pm2-boot.sh',
    'check-migration-compatibility.sh',
  ]) {
    const source = join(serverRoot, 'deploy', file);
    if (existsSync(source)) cpSync(source, join(deploy, file));
  }
  const script = (file: string, body: string) =>
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  script(join(deploy, 'sync-ec2-git-bundle.sh'), ':');
  script(join(deploy, 'launch-readiness.sh'), ':');
  script(join(deploy, 'vpn-health-assert.sh'), ':');
  script(
    join(deploy, 'write-ec2-remote-env.sh'),
    `if [ "\x24{1:-}" != --validate ]; then\n  printf common > "$REMOTE_TEST_SERVER/.env.remote-common"\n  printf admin > "$REMOTE_TEST_SERVER/.env.remote-admin"\n  printf '%s\\n' bootstrap >> "$EVENTS"\nfi`,
  );
  script(
    join(deploy, 'ssm-run-command.sh'),
    `node -e 'const {spawnSync}=require("node:child_process"); const command=process.argv[1].replaceAll("/home/ubuntu/repos/zero",process.env.REMOTE_TEST_REPO); const r=spawnSync("bash",["-euc",command],{stdio:"inherit",env:process.env}); process.exit(r.status??1)' "$1"`,
  );
  script(join(bin, 'id'), 'echo 1000');
  script(
    join(bin, 'pnpm'),
    `if [ "\x24{1:-}" = install ]; then exit 0; fi\nif [ "\x24{1:-}" = db:migrate ]; then\n  printf '%s\\n' migrate >> "$EVENTS"\n  exec node --import tsx "$REMOTE_TEST_ROOT/migrate.mjs"\nfi\nprintf pnpm > "$ACTIVATION_MARKER"\nexit 77`,
  );
  for (const command of ['sudo', 'pm2', 'curl'])
    script(join(bin, command), `printf ${command} > "$ACTIVATION_MARKER"\nexit 77`);
  writeFileSync(join(server, '.env.production'), `export DATABASE_URL=${JSON.stringify(url)}\n`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REPO_ROOT: repo,
    ENV_FILE: join(server, '.env.production'),
    REMOTE_TEST_REPO: repo,
    REMOTE_TEST_SERVER: server,
    REMOTE_TEST_ROOT: root,
    ACTIVATION_MARKER: marker,
    EVENTS: join(root, 'events'),
  };
  delete env.DATABASE_URL;
  delete env.VITEST_ALLOW_PILOT_RDS;
  return {
    root,
    server,
    marker,
    env,
    run: (file: string, args: string[] = []) =>
      spawnSync('bash', [join(deploy, file), ...args], { env, encoding: 'utf8', timeout: 20_000 }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

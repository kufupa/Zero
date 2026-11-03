import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../deploy/build-identity.sh', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'nava-build-identity-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const commit = () => execFileSync('git', [
    '-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-qm', 'build fixture',
  ]);
  const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  commit();
  return { root, commit, head };
}

function run(script: string, root: string, sha = '', inherited = '') {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'test', helper, root, sha], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NAVA_BUILD_COMMIT: inherited },
  });
}

describe('server build identity', () => {
  it('uses the built SHA after checkout and inherited env change', () => {
    const repo = repository();
    const built = repo.head();
    const finished = run('nava_write_build_marker "$2" BUILD_IN_PROGRESS\nnava_finish_server_build "$2" "$3"', repo.root, built);
    expect(finished.status).toBe(0);
    repo.commit();
    expect(repo.head()).not.toBe(built);
    const loaded = run('nava_load_build_commit "$2"\nprintf "%s" "$NAVA_BUILD_COMMIT"', repo.root, '', 'a'.repeat(40));
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toBe(built);
  });

  it('refuses to label an incomplete build or a checkout that changed during build', () => {
    const repo = repository();
    const oldHead = repo.head();
    expect(run('nava_write_build_marker "$2" BUILD_IN_PROGRESS', repo.root).status).toBe(0);
    repo.commit();
    const finished = run('nava_finish_server_build "$2" "$3"', repo.root, oldHead);
    expect(finished.status).not.toBe(0);
    expect(finished.stderr).toContain('checkout changed during server build');
    const loaded = run('nava_load_build_commit "$2"', repo.root, '', 'a'.repeat(40));
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('build in progress');
  });

  it('refuses startup if a failed clean build removed dist and its marker', () => {
    const repo = repository();
    expect(run('nava_write_build_marker "$2" BUILD_IN_PROGRESS', repo.root).status).toBe(0);
    rmSync(join(repo.root, 'apps', 'server-pilot', 'dist'), { recursive: true, force: true });
    const loaded = run('nava_load_build_commit "$2"', repo.root, '', 'a'.repeat(40));
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('build in progress');
  });

  it('marks legacy startup identity unknown instead of trusting stale env or checkout', () => {
    const repo = repository();
    const loaded = run('nava_load_build_commit "$2"\nprintf "%s" "$NAVA_BUILD_COMMIT"', repo.root, '', 'b'.repeat(40));
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toBe('unknown');
    expect(loaded.stderr).toContain('identity is unverified');
  });

  it('guards each PM2 server entry on every start using the built artifact', () => {
    const repo = repository();
    const server = join(repo.root, 'apps', 'server-pilot');
    const deploy = join(server, 'deploy');
    const dist = join(server, 'dist');
    mkdirSync(deploy, { recursive: true });
    copyFileSync(helper, join(deploy, 'build-identity.sh'));
    const wrapper = join(deploy, 'start-guarded-server.sh');
    copyFileSync(fileURLToPath(new URL('../deploy/start-guarded-server.sh', import.meta.url)), wrapper);
    const entries = [
      ['http', 'main.js'],
      ['worker', 'mail/ingest/worker.js'],
      ['ai-worker', 'ai/worker.js'],
    ];
    for (const [, relative] of entries) {
      const file = join(dist, relative);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'process.stdout.write(process.env.PRINT_EXEC_PATH ? process.execPath : process.env.NAVA_BUILD_COMMIT);\n');
    }
    const invoke = (entry: string) => spawnSync('bash', [wrapper, entry], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NAVA_BUILD_COMMIT: 'b'.repeat(40) },
    });
    const built = repo.head();
    writeFileSync(join(dist, '.nava-build-commit'), `${built}\n`);
    for (const [entry] of entries) {
      const started = invoke(entry);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toBe(built);
    }
    const hms = spawnSync('bash', [wrapper, 'ai-worker'], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AI_WORKER_LANE: 'hms', PRINT_EXEC_PATH: '1' },
    });
    if (existsSync('/usr/bin/node')) {
      expect(hms.status, hms.stderr).toBe(0);
      expect(hms.stdout).toBe(realpathSync('/usr/bin/node'));
    } else {
      // The VPS has no system Node; EC2 does. Failure identifies the pinned binary.
      expect(hms.status).toBe(127);
      expect(hms.stderr).toContain('/usr/bin/node');
    }
    writeFileSync(join(server, '.nava-build-in-progress'), 'BUILD_IN_PROGRESS\n');
    for (const [entry] of entries) {
      const blocked = invoke(entry);
      expect(blocked.status).not.toBe(0);
      expect(blocked.stdout).toBe('');
      expect(blocked.stderr).toContain('build in progress');
    }
    const remote = join(deploy, 'start-remote-http.sh');
    copyFileSync(fileURLToPath(new URL('../deploy/start-remote-http.sh', import.meta.url)), remote);
    const blockedRemote = spawnSync('bash', [remote], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    expect(blockedRemote.status).not.toBe(0);
    expect(blockedRemote.stderr).toContain('build in progress');
    rmSync(join(server, '.nava-build-in-progress'));
    rmSync(join(dist, '.nava-build-commit'));
    expect(invoke('http').stdout).toBe('unknown');
    expect(invoke('invalid').status).not.toBe(0);
  });

  it('registers guarded entrypoints for all PM2 server processes', () => {
    const require = createRequire(import.meta.url);
    const config = require('../deploy/pm2.config.cjs') as {
      apps: Array<{ name: string; script: string; interpreter: string; args?: string }>;
    };
    for (const name of ['http', 'worker', 'ai-worker']) {
      expect(config.apps.find((app) => app.name === name)).toMatchObject({
        script: 'deploy/start-guarded-server.sh', interpreter: '/bin/bash', args: name,
      });
    }
    expect(config.apps.find((app) => app.name === 'hms-ai-worker')?.args)
      .toContain('/bin/bash deploy/start-guarded-server.sh ai-worker');
    expect(config.apps.find((app) => app.name === 'remote-http')?.script)
      .toBe('deploy/start-remote-http.sh');
  });

  it('binds HMS start to the built marker and allows status when identity is unknown', () => {
    const repo = repository();
    const server = join(repo.root, 'apps', 'server-pilot');
    const deploy = join(server, 'deploy');
    const ops = join(server, 'dist', 'ops');
    mkdirSync(deploy, { recursive: true });
    mkdirSync(ops, { recursive: true });
    copyFileSync(helper, join(deploy, 'build-identity.sh'));
    writeFileSync(join(server, '.env.production'), `NAVA_BUILD_COMMIT=${'b'.repeat(40)}\n`);
    writeFileSync(join(ops, 'hms-live-proof.js'), 'console.log(process.argv[2], process.env.NAVA_BUILD_COMMIT);\n');
    const shadowSource = fileURLToPath(new URL('../deploy/ops-hms-shadow.sh', import.meta.url));
    const shadow = join(deploy, 'ops-hms-shadow.sh');
    writeFileSync(shadow, readFileSync(shadowSource, 'utf8').replaceAll(
      '/home/ubuntu/.nava-deploy.lock', join(repo.root, 'deploy.lock'),
    ));
    const invoke = (action: string) => spawnSync('bash', [shadow, action], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo.root, REPO_ROOT: repo.root },
    });
    expect(invoke('start').status).toBe(10);
    expect(invoke('status').stdout.trim()).toBe('status unknown');
    const built = repo.head();
    expect(run('nava_write_build_marker "$2" "$3"', repo.root, built).status).toBe(0);
    const started = invoke('start');
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout.trim()).toBe(`start ${built}`);
    expect(invoke('status').stdout.trim()).toBe(`status ${built}`);
    writeFileSync(join(server, '.nava-build-in-progress'), 'BUILD_IN_PROGRESS\n');
    expect(invoke('status').stdout.trim()).toBe('status unknown');
    rmSync(join(server, '.nava-build-in-progress'));
    repo.commit();
    expect(invoke('canary').status).toBe(10);
    expect(invoke('stop').status).toBe(0);
  });

  it('rejects a symlinked build directory', () => {
    const repo = repository();
    const server = join(repo.root, 'apps', 'server-pilot');
    mkdirSync(server, { recursive: true });
    symlinkSync(tmpdir(), join(server, 'dist'));
    const loaded = run('nava_load_build_commit "$2"', repo.root, '', 'a'.repeat(40));
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain('unsafe dist directory');
  });
});

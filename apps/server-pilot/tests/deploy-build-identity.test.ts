import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    expect(loaded.stderr).toContain('invalid server build identity');
  });

  it('marks legacy startup identity unknown instead of trusting stale env or checkout', () => {
    const repo = repository();
    const loaded = run('nava_load_build_commit "$2"\nprintf "%s" "$NAVA_BUILD_COMMIT"', repo.root, '', 'b'.repeat(40));
    expect(loaded.status).toBe(0);
    expect(loaded.stdout).toBe('unknown');
    expect(loaded.stderr).toContain('identity is unverified');
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
    expect(invoke('status').status).toBe(0);
    const built = repo.head();
    expect(run('nava_write_build_marker "$2" "$3"', repo.root, built).status).toBe(0);
    const started = invoke('start');
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout.trim()).toBe(`start ${built}`);
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

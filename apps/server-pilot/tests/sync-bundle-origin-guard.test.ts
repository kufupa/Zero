import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The bundle ships local refs/heads/main. A local main that lags or leads origin
// once shipped the wrong commit to prod, so the sync must refuse before any upload.
const syncScript = fileURLToPath(new URL('../deploy/sync-ec2-git-bundle.sh', import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Caller overrides (or a git hook's GIT_DIR) must not leak into the sandbox.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith('GIT_') ||
      [
        'ALLOW_UNPUSHED_DEPLOY',
        'AWS_REGION',
        'BUNDLE_KEY',
        'BOOTSTRAP_BUCKET',
        'EC2_REPO_PATH',
      ].includes(key)
    )
      delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'zero-sync-guard-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const awsCalls = join(root, 'aws-calls');
  mkdirSync(bin);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', repo);
  for (const [key, value] of [
    ['user.email', 'test@example.com'],
    ['user.name', 'test'],
    ['commit.gpgsign', 'false'],
  ] as const)
    git(repo, 'config', key, value);
  git(repo, 'remote', 'add', 'origin', origin);
  const deploy = join(repo, 'apps/server-pilot/deploy');
  mkdirSync(deploy, { recursive: true });
  cpSync(syncScript, join(deploy, 'sync-ec2-git-bundle.sh'));
  writeFileSync(join(deploy, 'ssm-run-command.sh'), '#!/usr/bin/env bash\nexit 0\n', {
    mode: 0o755,
  });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(awsCalls)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(deploy, 'sync-ec2-git-bundle.sh')], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, ...env },
    });
  const commit = (message: string) => {
    writeFileSync(join(repo, `${message}.txt`), message);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', message);
  };
  return { repo, origin, run, commit, uploaded: () => existsSync(awsCalls) };
}

describe('sync-ec2-git-bundle refuses a local main that differs from origin', () => {
  it('bundles when local main matches origin/main', () => {
    const box = sandbox();
    const result = box.run();
    expect(result.stderr).not.toContain('does not match origin');
    expect(result.status).toBe(0);
    expect(box.uploaded()).toBe(true);
  });

  it('stops before upload when local main is behind origin', () => {
    const box = sandbox();
    box.commit('pushed-elsewhere');
    git(box.repo, 'push', '-q', 'origin', 'main');
    git(box.repo, 'reset', '-q', '--hard', 'HEAD~1');
    const result = box.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('local main');
    expect(result.stderr).toContain('does not match origin/main');
    expect(result.stderr).toContain('git fetch origin main:main');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when local main has unpushed commits', () => {
    const box = sandbox();
    box.commit('unpushed');
    const result = box.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match origin/main');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when origin cannot be fetched', () => {
    const box = sandbox();
    git(box.repo, 'remote', 'set-url', 'origin', join(box.repo, 'missing.git'));
    const result = box.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot fetch origin/main');
    expect(box.uploaded()).toBe(false);
  });

  it('ALLOW_UNPUSHED_DEPLOY=1 skips the check', () => {
    const box = sandbox();
    box.commit('unpushed');
    const result = box.run({ ALLOW_UNPUSHED_DEPLOY: '1' });
    expect(result.status).toBe(0);
    expect(box.uploaded()).toBe(true);
  });
});

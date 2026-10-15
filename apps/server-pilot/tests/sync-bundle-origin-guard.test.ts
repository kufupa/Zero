import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
        'SANDBOX_EC2_SHA',
        'SANDBOX_EC2_CHECKOUT',
        'SANDBOX_SSM_FAIL',
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
  writeFileSync(
    join(deploy, 'ssm-run-command.sh'),
    [
      '#!/usr/bin/env bash',
      'if [ "${SANDBOX_SSM_FAIL:-}" = 1 ]; then exit 70; fi',
      'if [ -n "${SANDBOX_EC2_SHA:-}" ]; then',
      '  printf \'NAVA_EC2_CHECKOUT=present\\n%s\\n\' "$SANDBOX_EC2_SHA"',
      '  exit 0',
      'fi',
      'if [ "${SANDBOX_EC2_CHECKOUT:-}" = present ]; then',
      '  printf \'NAVA_EC2_CHECKOUT=present\\n\'',
      '  exit 0',
      'fi',
      'printf \'NAVA_EC2_CHECKOUT=absent\\n\'',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  writeFileSync(
    join(bin, 'aws'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(awsCalls)}\nexit 0\n`,
    { mode: 0o755 },
  );
  const run = (env: Record<string, string> = {}, args: string[] = []) =>
    spawnSync('bash', [join(deploy, 'sync-ec2-git-bundle.sh'), ...args], {
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
    const sha = git(box.repo, 'rev-parse', 'HEAD');
    const result = box.run();
    expect(result.stderr).not.toContain('does not match origin');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`shipping SHA: ${sha}`);
    expect(result.stdout).toContain('EC2 SHA: none');
    expect(box.uploaded()).toBe(true);
  });

  it('stops before upload when local main is behind origin', () => {
    const box = sandbox();
    box.commit('pushed-elsewhere');
    git(box.repo, 'push', '-q', 'origin', 'main');
    git(box.repo, 'reset', '-q', '--hard', 'HEAD~1');
    const result = box.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('local main');
    expect(result.stderr).toContain('does not match origin/main');
    expect(result.stderr).toContain('git fetch origin main:main');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when local main has unpushed commits', () => {
    const box = sandbox();
    box.commit('unpushed');
    const result = box.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not match origin/main');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when origin cannot be fetched', () => {
    const box = sandbox();
    git(box.repo, 'remote', 'set-url', 'origin', join(box.repo, 'missing.git'));
    const result = box.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot fetch origin/main');
    expect(box.uploaded()).toBe(false);
  });

  it('prints readable EC2 SHA and ships when it equals local main', () => {
    const box = sandbox();
    const sha = git(box.repo, 'rev-parse', 'HEAD');
    const result = box.run({ SANDBOX_EC2_SHA: sha });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`shipping SHA: ${sha}`);
    expect(result.stdout).toContain(`EC2 SHA: ${sha}`);
    expect(box.uploaded()).toBe(true);
  });

  it('stops before upload when shipping SHA is an ancestor of EC2 HEAD', () => {
    const box = sandbox();
    box.commit('newer-on-ec2');
    const ec2 = git(box.repo, 'rev-parse', 'HEAD');
    git(box.repo, 'push', '-q', 'origin', 'main');
    git(box.repo, 'reset', '-q', '--hard', 'HEAD~1');
    git(box.repo, 'push', '-q', '--force', 'origin', 'main');
    const shipping = git(box.repo, 'rev-parse', 'HEAD');
    const result = box.run({ SANDBOX_EC2_SHA: ec2 });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`shipping SHA: ${shipping}`);
    expect(result.stdout).toContain(`EC2 SHA: ${ec2}`);
    expect(result.stderr).toMatch(
      /ancestor of the EC2 SHA [0-9a-f]+ \(rollback\)/,
    );
    expect(result.stderr).toContain('--allow-rollback');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when the EC2 checkout exists but its SHA is unreadable', () => {
    const box = sandbox();
    const result = box.run({ SANDBOX_EC2_CHECKOUT: 'present' });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('EC2 SHA: unread');
    expect(result.stderr).toMatch(/unreadable|unread/i);
    expect(result.stderr).toContain('re-run');
    expect(result.stderr).toContain('--allow-rollback');
    expect(box.uploaded()).toBe(false);
  });

  it('stops before upload when the EC2 SHA read fails over SSM', () => {
    const box = sandbox();
    const result = box.run({ SANDBOX_SSM_FAIL: '1' });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('EC2 SHA: unread');
    expect(result.stderr).toContain('re-run');
    expect(result.stderr).toContain('--allow-rollback');
    expect(box.uploaded()).toBe(false);
  });

  it('--allow-rollback ships when the EC2 SHA is unreadable', () => {
    const box = sandbox();
    const result = box.run({ SANDBOX_EC2_CHECKOUT: 'present' }, ['--allow-rollback']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EC2 SHA: unread');
    expect(box.uploaded()).toBe(true);
  });

  it('--allow-rollback ships an ancestor of EC2 HEAD', () => {
    const box = sandbox();
    box.commit('newer-on-ec2');
    const ec2 = git(box.repo, 'rev-parse', 'HEAD');
    git(box.repo, 'push', '-q', 'origin', 'main');
    git(box.repo, 'reset', '-q', '--hard', 'HEAD~1');
    git(box.repo, 'push', '-q', '--force', 'origin', 'main');
    const result = box.run({ SANDBOX_EC2_SHA: ec2 }, ['--allow-rollback']);
    expect(result.status).toBe(0);
    expect(box.uploaded()).toBe(true);
  });

  it('ALLOW_UNPUSHED_DEPLOY=1 skips the origin match check', () => {
    const box = sandbox();
    box.commit('unpushed');
    const result = box.run({ ALLOW_UNPUSHED_DEPLOY: '1' });
    expect(result.status).toBe(0);
    expect(box.uploaded()).toBe(true);
  });
});

describe('ops-deploy prints that bundle sync reports SHAs', () => {
  it('mentions shipping SHA and EC2 SHA in the sync step', () => {
    const ops = readFileSync(new URL('../deploy/ops-deploy.sh', import.meta.url), 'utf8');
    expect(ops).toMatch(/shipping SHA/);
    expect(ops).toMatch(/EC2 SHA/);
  });

  it('accepts --allow-rollback and forwards it to bundle sync', () => {
    const ops = readFileSync(new URL('../deploy/ops-deploy.sh', import.meta.url), 'utf8');
    expect(ops).toMatch(/--allow-rollback\) ALLOW_ROLLBACK=1/);
    expect(ops).toContain('bash "${SCRIPT_DIR}/sync-ec2-git-bundle.sh" --allow-rollback');
    expect(ops).toMatch(/usage: \$0 \[--migrate\] \[--quiesced\] \[--allow-rollback\]/);
    expect(ops).toMatch(/unknown arg: \$arg \(try --migrate \/ --quiesced \/ --allow-rollback\)/);
  });
});

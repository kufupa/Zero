import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { deploymentSandbox } from './helpers/deploy-sandbox.js';
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

// husky's prepare copies its shim onto .husky/_/h, which fails with EACCES while that file is mode 0444.
// ops-deploy must restore the owner write bit before its first on-box pnpm install.
describe('ops-deploy restores the husky hook before the first on-box install', () => {
  it('places the guarded chmod before the first pnpm install', () => {
    const lines = readFileSync(
      new URL('../deploy/ops-deploy.sh', import.meta.url),
      'utf8',
    ).split(/\r?\n/);
    const chmod = lines.findIndex((line) =>
      line.includes('if [ -e "$hook" ]; then chmod u+w "$hook"; fi'),
    );
    const firstInstall = lines.findIndex(
      (line) => !line.trimStart().startsWith('#') && /\bpnpm install\b/.test(line),
    );

    expect(chmod).toBeGreaterThanOrEqual(0);
    expect(firstInstall).toBeGreaterThanOrEqual(0);
    expect(chmod).toBeLessThan(firstInstall);
  });

  it.skipIf(process.getuid?.() === 0)(
    'makes a read-only hook writable before pnpm install runs',
    () => {
      const sandbox = deploymentSandbox('postgresql://unused@127.0.0.1:1/unused?sslmode=disable');
      try {
        const hook = join(sandbox.root, 'repo', '.husky', '_', 'h');
        mkdirSync(join(sandbox.root, 'repo', '.husky', '_'), { recursive: true });
        writeFileSync(hook, 'shim');
        chmodSync(hook, 0o444);
        expect(() => accessSync(hook, constants.W_OK)).toThrow();
        // Stands in for the prepare hook: install fails on a read-only hook, the way husky's copy does on the box.
        writeFileSync(
          join(sandbox.root, 'bin', 'pnpm'),
          [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'if [ "${1:-}" = install ]; then',
            '  hook="$REMOTE_TEST_REPO/.husky/_/h"',
            '  if [ -e "$hook" ] && [ ! -w "$hook" ]; then',
            '    echo "EACCES: permission denied, copyfile \'$hook\'" >&2',
            '    exit 1',
            '  fi',
            '  printf \'%s\\n\' install >> "$EVENTS"',
            '  exit 0',
            'fi',
            'exit 0',
            '',
          ].join('\n'),
          { mode: 0o755 },
        );
        const result = sandbox.run('ops-deploy.sh', ['--quiesced']);
        expect(result.stderr).not.toContain('EACCES');
        expect(readFileSync(sandbox.env.EVENTS!, 'utf8')).toContain('install');
        const restore = result.stdout.indexOf('restore husky hook write bit');
        expect(restore).toBeGreaterThanOrEqual(0);
        expect(restore).toBeLessThan(
          result.stdout.indexOf('install dependencies before migration check'),
        );
        expect(statSync(hook).mode & 0o200).not.toBe(0);
      } finally {
        sandbox.close();
      }
    },
  );
});

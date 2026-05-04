import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const mailRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const ALLOW_TRPC = new Set([
  'lib/trpc.ts',
  'lib/trpc.server.ts',
  'providers/query-provider.tsx',
  'lib/api/adapters/legacy-trpc.ts',
  'tests/legacy-adapter-routes.test.ts',
]);

const ALLOW_SERVER_AUTH_TYPE = new Set(['lib/auth-client.ts']);

function* walkTsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'paraglide' || name === '.react-router') {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (st.isFile() && /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('frontend import boundary', () => {
  it('does not import forbidden server internals', () => {
    const forbidden = [
      { re: /\bserver\/src\b/, msg: 'server/src' },
      { re: /@zero\/server\/src/, msg: '@zero/server/src' },
      { re: /@zero\/server\/schemas/, msg: '@zero/server/schemas' },
      { re: /@zero\/server\/auth-providers/, msg: '@zero/server/auth-providers' },
    ];

    for (const file of walkTsFiles(mailRoot)) {
      const rel = relative(mailRoot, file).replace(/\\/g, '/');
      if (rel === 'tests/frontend-import-boundary.test.ts') {
        continue;
      }
      const src = readFileSync(file, 'utf8');

      for (const { re, msg } of forbidden) {
        if (re.test(src)) {
          expect.fail(`${rel}: forbidden pattern ${msg}`);
        }
      }

      if (/@zero\/server\/auth\b/.test(src) && !ALLOW_SERVER_AUTH_TYPE.has(rel)) {
        expect.fail(`${rel}: @zero/server/auth only allowed in ${[...ALLOW_SERVER_AUTH_TYPE].join(', ')}`);
      }

      if (/@zero\/server\/trpc\b/.test(src) && !ALLOW_TRPC.has(rel)) {
        expect.fail(`${rel}: @zero/server/trpc only allowed in ${[...ALLOW_TRPC].join(', ')}`);
      }
    }
  });
});

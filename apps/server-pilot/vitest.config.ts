import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, string>;
};

/** Vitest aliases derived from package.json exports — breaks if export map drifts. */
const alias: Record<string, string> = {};
for (const [subpath, target] of Object.entries(pkg.exports)) {
  if (subpath === '.') continue;
  alias[`@zero/server${subpath.slice(1)}`] = fileURLToPath(new URL(target, import.meta.url));
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias,
  },
});

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@zero/server/trpc': src('trpc/index.ts'),
      '@zero/server/auth': src('lib/auth.ts'),
      '@zero/server/auth-providers': src('lib/auth-providers.ts'),
      '@zero/server/schemas': src('lib/schemas.ts'),
    },
  },
});

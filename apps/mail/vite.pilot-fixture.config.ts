import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export const pilotFixtureContract = {
  mode: 'fixture',
  envFiles: false,
  liveBindings: false,
  externalSockets: false,
  networkPolicy: 'loopback-only',
  transport: 'fake',
  allowedOrigins: ['http://127.0.0.1:4179'],
  publicOrigin: 'http://127.0.0.1:4179',
} as const;

export default defineConfig({
  envDir: '/dev/null',
  root: 'tests/e2e/fixture',
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@': '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/apps/mail',
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4179,
    strictPort: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  expect: {
    timeout: 20_000,
  },
  outputDir:
    '/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.private/centurion-dashboard-tools-execution/u11a-browser-artifacts',
  use: {
    trace: 'on',
    video: 'on',
    screenshot: 'on',
  },
  testDir: 'tests/e2e',
  webServer: {
    command: 'pnpm exec vite --config vite.pilot-fixture.config.ts',
    port: 4179,
    timeout: 30_000,
    reuseExistingServer: false,
  },
} as any);

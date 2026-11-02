/** Synthetic Outlook replay only: loopback Vite, no env files or live backend bindings. */
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const mailRoot = fileURLToPath(new URL('.', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./tests/e2e/fixture/', import.meta.url));
const paneFixture: Plugin = {
  name: 'synthetic-outlook-pane',
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url === '/outlook-pane') request.url = '/replay.html';
      next();
    });
  },
};

export default defineConfig({
  envDir: '/dev/null',
  root: fixtureRoot,
  plugins: [tailwindcss(), paneFixture],
  resolve: { alias: { '@': mailRoot } },
  define: {
    'import.meta.env.VITE_PUBLIC_BACKEND_URL': JSON.stringify(''),
    'import.meta.env.VITE_ZERO_DEMO_MODE': JSON.stringify('0'),
    'import.meta.env.VITE_FRONTEND_ONLY': JSON.stringify('0'),
  },
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
});

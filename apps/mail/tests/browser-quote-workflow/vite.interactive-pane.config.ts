import { defineConfig } from 'vite';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mailRoot = path.resolve(here, '../..');
const cssDir = path.join(mailRoot, 'build/client/assets');
const cssName = readdirSync(cssDir).find(
  (name) => name.startsWith('server-build-') && name.endsWith('.css'),
);
if (!cssName) {
  throw new Error('missing built server-build-*.css; run mail build first');
}

export default defineConfig({
  root: here,
  envDir: '/dev/null',
  publicDir: false,
  plugins: [
    {
      name: 'built-mail-css',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? '').split('?')[0];
          if (pathname === '/recorded-proof' && process.env.QUOTE_UI_RECORDED_PROOF) {
            const proof = JSON.parse(readFileSync(process.env.QUOTE_UI_RECORDED_PROOF, 'utf8'));
            const pdfBase64 = readFileSync(proof.pdfPath).toString('base64');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ...proof, pdfBase64 }));
            return;
          }
          if (pathname !== '/built-mail.css') {
            next();
            return;
          }
          res.setHeader('content-type', 'text/css; charset=utf-8');
          createReadStream(path.join(cssDir, cssName)).pipe(res);
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': mailRoot,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4181,
    strictPort: true,
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
});

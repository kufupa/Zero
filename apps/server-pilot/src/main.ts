import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { getPublicAuthProviders } from './lib/auth-providers.js';
import { createAuth } from './lib/auth.js';
import { resolveAuthSessionProfile } from './lib/auth-profile.js';
import { closeDb, getDb } from './db/client.js';
import { createWiredInlineAttachmentHandler } from './http/inline-attachment.js';
import { createWiredCenturionLabIndexHandler } from './http/centurion-lab-index.js';
import { createEmlDownloadHandler } from './http/eml-download.js';
import { createOutlookNativeHandler } from './http/outlook-native.js';
import { appRouter } from './trpc/router.js';

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'server-pilot' }),
);

// Public providers endpoint consumed by apps/mail login page.
app.get('/api/public/providers', (c) => {
  const env = process.env as Record<string, string | undefined>;
  const isProd = env.NODE_ENV === 'production';

  return c.json({
    allProviders: getPublicAuthProviders(env, resolveAuthSessionProfile(env)),
    isProd,
  });
});

// Better Auth handlers mount at /api/auth/* (better-auth default basePath).
const auth = createAuth();
app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', (c) => auth.handler(c.req.raw));

// Native enrollment is a one-use, operator-approved pairing; no browser signup exists.
app.post('/api/outlook/native/enroll', (c) => createOutlookNativeHandler(
  // Lazily load DB but fail closed when the separate wrapping key is missing.
  getDb(), process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY ?? '',
)(c.req.raw));
app.post('/api/outlook/native/challenge', (c) => createOutlookNativeHandler(
  getDb(), process.env.NAVA_OUTLOOK_DEVICE_WRAPPING_KEY ?? '',
)(c.req.raw));

// CID inline images: cookie session + mailbox_access join (no active-transport
// header — <img> tags cannot set custom headers). Must mount before /api/trpc/*.
const inlineAttachmentHandler = createWiredInlineAttachmentHandler(auth);
const centurionLabIndexHandler = createWiredCenturionLabIndexHandler(auth);
app.get('/api/lab/centurion-index', (c) => centurionLabIndexHandler(c.req.raw));
app.get(
  '/api/mail/messages/:messageId/attachments/:attachmentId/inline',
  async (c) =>
    inlineAttachmentHandler(c.req.raw, {
      messageId: c.req.param('messageId'),
      attachmentId: c.req.param('attachmentId'),
    }),
);

// EML message download: cookie session + mailbox_access join.
const emlDownloadHandler = createEmlDownloadHandler(auth);
app.get('/api/mail/messages/:messageId/download.eml', async (c) =>
  emlDownloadHandler(c.req.raw, { messageId: c.req.param('messageId') }),
);

// tRPC endpoint. We use `@trpc/server/adapters/fetch`'s `fetchRequestHandler`
// directly (instead of `@hono/trpc-server`) to avoid a dual-package types
// clash between the ESM `.d.mts` and CJS `.d.cts` declarations that the
// @hono/trpc-server wrapper pulls in under `moduleResolution: NodeNext`.
//
// Context factory hands the Better Auth instance + raw request headers to the
// procedure layer; `privateProcedure` resolves the session user from cookies,
// `mailboxProcedure` resolves the active transport from the
// `x-zero-active-transport` header (or the user's highest-role transport).
app.on(['GET', 'POST'], '/api/trpc/*', (c) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    router: appRouter,
    req: c.req.raw,
    allowMethodOverride: true,
    createContext: () => ({ auth, reqHeaders: c.req.raw.headers }),
    onError: (opts) => {
      console.error('tRPC error:', opts.error);
    },
  }),
);

const port = Number(process.env.PORT ?? 8788);

const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`server-pilot listening on http://127.0.0.1:${info.port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    void closeDb()
      .then(() => {
        console.log('shutdown complete');
        process.exit(0);
      })
      .catch((err) => {
        console.error('shutdown error:', err);
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

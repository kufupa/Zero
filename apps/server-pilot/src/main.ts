import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

app.get('/health', (c) =>
  c.json({ ok: true, service: 'server-pilot' }),
);

const port = Number(process.env.PORT ?? 8788);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server-pilot listening on http://0.0.0.0:${info.port}`);
});

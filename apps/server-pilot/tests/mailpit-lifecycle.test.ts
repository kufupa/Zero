import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import nodemailer from 'nodemailer';
import { startMailpitForTests, mailpitConfigured, type MailpitContext } from './helpers/mailpit.js';

describe.skipIf(!mailpitConfigured)('mailpit lifecycle helper', () => {
  let ctx: MailpitContext;

  beforeAll(async () => {
    const started = await startMailpitForTests();
    if (!started) throw new Error('expected mailpit');
    ctx = started;
  }, 30_000);

  afterAll(async () => {
    await ctx?.stop();
  });

  it('accepts SMTP inject and purge via HTTP API', async () => {
    await ctx.clearAll();
    const transport = nodemailer.createTransport({
      host: ctx.smtpHost,
      port: ctx.smtpPort,
      secure: false,
    });
    await transport.sendMail({
      from: 'probe@wire.test',
      to: 'nava@legacyhotel.com',
      subject: 'mailpit-probe',
      text: 'probe',
    });
    const res = await fetch(`${ctx.httpUrl}/api/v1/messages`);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBeGreaterThan(0);
    await ctx.clearAll();
    const after = await fetch(`${ctx.httpUrl}/api/v1/messages`);
    const empty = (await after.json()) as { total: number };
    expect(empty.total).toBe(0);
  });
});

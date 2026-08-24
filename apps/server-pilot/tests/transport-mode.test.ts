import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import {
  createPop3Client,
  FakePop3Client,
  RealPop3Client,
  loadFixtureMessagesFromDir,
} from '../src/mail/ingest/pop3-client';
import {
  createSmtpTransport,
  FakeSmtpTransport,
  RealSmtpTransport,
} from '../src/mail/send/smtp';
import { parseEnv } from '../src/env';
import { fixturePath } from './helpers/fixtures';

describe('MAIL_TRANSPORT_MODE factories', () => {
  it('parseEnv defaults MAIL_TRANSPORT_MODE to fixture', () => {
    const env = parseEnv({
      PORT: '8788',
      DATABASE_URL: 'postgres://x',
      BETTER_AUTH_URL: 'http://localhost',
      BETTER_AUTH_SECRET: 'secret',
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'bucket',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '50',
    });
    expect(env.MAIL_TRANSPORT_MODE).toBe('fixture');
  });

  it('createPop3Client returns FakePop3Client in fixture mode even when POP3_HOST set', () => {
    const client = createPop3Client({
      MAIL_TRANSPORT_MODE: 'fixture',
      POP3_HOST: 'mail.example.com',
      POP3_PORT: 995,
      POP3_USER: 'navaai@legacyhotels.co.za',
      POP3_PASSWORD: 'secret',
    });
    expect(client).toBeInstanceOf(FakePop3Client);
    expect(client?.kind).toBe('fake');
  });

  it('fixture FakePop3Client connect does not require POP3_HOST', async () => {
    const client = createPop3Client({
      MAIL_TRANSPORT_MODE: 'fixture',
      POP3_HOST: 'mail.example.com',
      POP3_PORT: 995,
      POP3_USER: 'navaai@legacyhotels.co.za',
    });
    expect(client).toBeInstanceOf(FakePop3Client);
    await client!.connect();
    const uidls = await client!.listUidl();
    expect(uidls).toEqual([]);
    await client!.quit();
  });

  it('createPop3Client returns null in real mode without host or secret', () => {
    expect(
      createPop3Client({
        MAIL_TRANSPORT_MODE: 'real',
        POP3_HOST: 'mail.example.com',
        POP3_PORT: 995,
        POP3_USER: 'navaai@legacyhotels.co.za',
      }),
    ).toBeNull();
    expect(
      createPop3Client({
        MAIL_TRANSPORT_MODE: 'real',
        POP3_PORT: 995,
        POP3_USER: 'navaai@legacyhotels.co.za',
        POP3_PASSWORD: 'secret',
      }),
    ).toBeNull();
  });

  it('createPop3Client returns RealPop3Client in real mode with host and password', () => {
    const client = createPop3Client({
      MAIL_TRANSPORT_MODE: 'real',
      POP3_HOST: 'mail.example.com',
      POP3_PORT: 995,
      POP3_USER: 'navaai@legacyhotels.co.za',
      POP3_PASSWORD: 'secret',
    });
    expect(client).toBeInstanceOf(RealPop3Client);
    expect(client?.kind).toBe('real');
  });

  it('loadFixtureMessagesFromDir loads .eml files by stem uidl', () => {
    const fixturesDir = fixturePath('centurion-stamped.eml').replace(
      /[/\\]centurion-stamped\.eml$/,
      '',
    );
    const loaded = loadFixtureMessagesFromDir(fixturesDir);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.some((m) => m.uidl === 'centurion-stamped')).toBe(true);
  });

  it('Pop3Client interface parity — fake and real expose same methods', () => {
    const fake = new FakePop3Client();
    const real = new RealPop3Client({
      host: 'x',
      port: 995,
      user: 'u',
      password: 'p',
    });
    for (const client of [fake, real]) {
      expect(typeof client.connect).toBe('function');
      expect(typeof client.listUidl).toBe('function');
      expect(typeof client.retr).toBe('function');
      expect(typeof client.dele).toBe('function');
      expect(typeof client.quit).toBe('function');
      expect(typeof client.close).toBe('function');
      expect(['fake', 'real']).toContain(client.kind);
    }
  });

  it('createSmtpTransport returns fake in fixture mode even when SMTP_HOST set', () => {
    const saved = process.env.SMTP_HOST;
    process.env.SMTP_HOST = 'smtp.example.com';
    try {
      const transport = createSmtpTransport({ mode: 'fixture' });
      expect(transport).toBeInstanceOf(FakeSmtpTransport);
      expect(transport.kind).toBe('fake');
    } finally {
      if (saved === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = saved;
    }
  });

  it('createSmtpTransport returns RealSmtpTransport in real mode on Rocketseed hop', () => {
    const transport = createSmtpTransport({
      mode: 'real',
      host: '172.24.0.8',
      port: 587,
      user: 'navaai@legacyhotels.co.za',
      password: 'leftover-ignored',
    });
    expect(transport).toBeInstanceOf(RealSmtpTransport);
    expect(transport.kind).toBe('real');
  });

  it('createSmtpTransport allows real mode on Rocketseed without SMTP password', () => {
    const transport = createSmtpTransport({
      mode: 'real',
      host: '172.24.0.8',
      port: 587,
    });
    expect(transport).toBeInstanceOf(RealSmtpTransport);
  });

  it('createSmtpTransport rejects Zimbra SMTP host in real mode', () => {
    expect(() =>
      createSmtpTransport({
        mode: 'real',
        host: '172.24.0.10',
        port: 587,
      }),
    ).toThrow(/172\.24\.0\.8/);
  });

  it('createSmtpTransport rejects non-Rocketseed host in real mode', () => {
    expect(() =>
      createSmtpTransport({
        mode: 'real',
        host: 'smtp.example.com',
        port: 587,
        password: 'secret',
      }),
    ).toThrow(/172\.24\.0\.8/);
  });

  it('fixture mode still returns Fake when SMTP_HOST is Zimbra', () => {
    const transport = createSmtpTransport({
      mode: 'fixture',
      host: '172.24.0.10',
    });
    expect(transport).toBeInstanceOf(FakeSmtpTransport);
  });

  it('parseEnv accepts MAIL_TRANSPORT_MODE=wire', () => {
    const env = parseEnv({
      PORT: '8788',
      DATABASE_URL: 'postgres://x',
      BETTER_AUTH_URL: 'http://localhost',
      BETTER_AUTH_SECRET: 'secret',
      AWS_REGION: 'af-south-1',
      S3_BUCKET: 'bucket',
      POP3_POLL_INTERVAL_MS: '30000',
      POP3_MAX_MESSAGES_PER_CYCLE: '50',
      MAIL_TRANSPORT_MODE: 'wire',
    });
    expect(env.MAIL_TRANSPORT_MODE).toBe('wire');
  });

  it('createPop3Client returns RealPop3Client in wire mode', () => {
    const client = createPop3Client({
      MAIL_TRANSPORT_MODE: 'wire',
      POP3_HOST: '127.0.0.1',
      POP3_PORT: 11110,
      POP3_USER: 'ingest@wire.test',
      POP3_PASSWORD: 'wire-test-pass',
      POP3_TLS: false,
    });
    expect(client).toBeInstanceOf(RealPop3Client);
  });

  it('createSmtpTransport returns RealSmtpTransport in wire mode without secret ARN', () => {
    const transport = createSmtpTransport({
      mode: 'wire',
      host: '127.0.0.1',
      port: 11025,
      secure: false,
    });
    expect(transport).toBeInstanceOf(RealSmtpTransport);
  });

  it('SmtpTransport interface parity — fake and real expose send', () => {
    const fake = new FakeSmtpTransport();
    const real = new RealSmtpTransport({
      host: '172.24.0.8',
      port: 587,
      user: 'u',
      password: 'p',
    });
    for (const transport of [fake, real]) {
      expect(typeof transport.send).toBe('function');
      expect(['fake', 'real']).toContain(transport.kind);
    }
  });

  it('FakeSmtpTransport accepts every requested recipient and rejects none', async () => {
    const result = await new FakeSmtpTransport().send({
      from: 'sender@zero.test',
      to: ['to@zero.test'],
      cc: ['cc@zero.test'],
      bcc: ['bcc@zero.test'],
      subject: 'fake result',
      html: '<p>fake result</p>',
      text: 'fake result',
    });

    expect(result.accepted).toEqual(['to@zero.test', 'cc@zero.test', 'bcc@zero.test']);
    expect(result.rejected).toEqual([]);
  });
});

describe('Rocketseed real SMTP hop options', () => {
  // Imported after describe so failures surface if export missing (RED).
  it('omits auth on Rocketseed even when password present', async () => {
    const { buildRealSmtpNodemailerOptions } = await import('../src/mail/send/smtp');
    const opts = buildRealSmtpNodemailerOptions({
      host: '172.24.0.8',
      port: 587,
      user: 'navaai@legacyhotels.co.za',
      password: 'leftover-zimbra-secret',
    });
    expect(opts.auth).toBeUndefined();
  });

  it('forces strict TLS + SNI on Rocketseed ignoring MAIL_TLS_REJECT_UNAUTHORIZED=false', async () => {
    const { buildRealSmtpNodemailerOptions } = await import('../src/mail/send/smtp');
    const previous = process.env.MAIL_TLS_REJECT_UNAUTHORIZED;
    process.env.MAIL_TLS_REJECT_UNAUTHORIZED = 'false';
    try {
      const opts = buildRealSmtpNodemailerOptions({
        host: '172.24.0.8',
        port: 587,
      });
      expect(opts.requireTLS).toBe(true);
      expect(opts.tls.rejectUnauthorized).toBe(true);
      expect(opts.tls.servername).toBe('branding.legacyhotels.co.za');
    } finally {
      if (previous === undefined) delete process.env.MAIL_TLS_REJECT_UNAUTHORIZED;
      else process.env.MAIL_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });

  it('wire/Mailpit host keeps optional auth and does not force Rocketseed SNI', async () => {
    const { buildRealSmtpNodemailerOptions } = await import('../src/mail/send/smtp');
    const opts = buildRealSmtpNodemailerOptions({
      host: '127.0.0.1',
      port: 11025,
      user: 'u',
      password: 'p',
      secure: false,
    });
    expect(opts.auth).toEqual({ user: 'u', pass: 'p' });
    expect(opts.tls.servername).toBeUndefined();
    expect(opts.requireTLS).toBeUndefined();
  });

  it('preserves Nodemailer empty accepted and rejected recipient arrays', async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: 'smtp-outcome@zero.test',
      accepted: [],
      rejected: ['rejected@zero.test'],
    });
    const createTransport = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail } as never);

    try {
      const transport = new RealSmtpTransport({
        host: '127.0.0.1',
        port: 11025,
        secure: false,
      });
      const result = await transport.send({
        from: 'sender@zero.test',
        to: ['rejected@zero.test'],
        cc: [],
        bcc: [],
        subject: 'test',
        html: '<p>test</p>',
        text: 'test',
      });

      expect(result).toEqual({
        messageId: 'smtp-outcome@zero.test',
        accepted: [],
        rejected: ['rejected@zero.test'],
      });
    } finally {
      createTransport.mockRestore();
    }
  });
});

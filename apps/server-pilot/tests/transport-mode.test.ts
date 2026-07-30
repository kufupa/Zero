import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { createTransportMock, sendMailMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

const requiredEnv = {
  PORT: '8788',
  DATABASE_URL: 'postgres://x',
  BETTER_AUTH_URL: 'http://localhost',
  BETTER_AUTH_SECRET: 'secret',
  AWS_REGION: 'af-south-1',
  S3_BUCKET: 'bucket',
  POP3_POLL_INTERVAL_MS: '30000',
  POP3_MAX_MESSAGES_PER_CYCLE: '50',
};

const realSmtpEnv = {
  ...requiredEnv,
  MAIL_TRANSPORT_MODE: 'real',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'relay@example.com',
  SMTP_PASSWORD: 'test-password',
  SMTP_REQUIRE_TLS: 'true',
  SMTP_TLS_SERVERNAME: 'smtp.example.com',
};

describe('MAIL_TRANSPORT_MODE factories', () => {
  beforeEach(() => {
    createTransportMock.mockReset();
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({
      messageId: '<message@example.com>',
      accepted: ['to@example.com'],
    });
    createTransportMock.mockReturnValue({
      sendMail: sendMailMock,
    });
  });

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

  it('parseEnv parses split POP3 and SMTP TLS policy', () => {
    const env = parseEnv({
      ...realSmtpEnv,
      POP3_TLS_REJECT_UNAUTHORIZED: 'false',
    });

    expect(env.POP3_TLS_REJECT_UNAUTHORIZED).toBe(false);
    expect(env.SMTP_REQUIRE_TLS).toBe(true);
    expect(env.SMTP_TLS_SERVERNAME).toBe('smtp.example.com');
  });

  it('parseEnv rejects incomplete or insecure real SMTP configuration', () => {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_TLS_SERVERNAME'] as const) {
      expect(() => parseEnv({ ...realSmtpEnv, [key]: undefined })).toThrow(key);
    }

    expect(() =>
      parseEnv({
        ...realSmtpEnv,
        SMTP_PASSWORD: undefined,
        SMTP_SECRET_ARN: undefined,
      }),
    ).toThrow(/SMTP_PASSWORD or SMTP_SECRET_ARN/);
    expect(() =>
      parseEnv({
        ...realSmtpEnv,
        SMTP_REQUIRE_TLS: 'false',
      }),
    ).toThrow(/SMTP_REQUIRE_TLS=true/);
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
      POP3_TLS_REJECT_UNAUTHORIZED: false,
    });
    expect(client).toBeInstanceOf(RealPop3Client);
    expect(client?.kind).toBe('real');
    expect(
      (
        client as RealPop3Client & {
          opts: { tlsRejectUnauthorized?: boolean };
        }
      ).opts.tlsRejectUnauthorized,
    ).toBe(false);
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

  it('createSmtpTransport returns RealSmtpTransport in real mode with host and password', () => {
    const transport = createSmtpTransport({
      mode: 'real',
      host: 'smtp.example.com',
      port: 587,
      user: 'relay@legacyhotel.com',
      password: 'secret',
      requireTls: true,
      tlsServername: 'smtp.example.com',
    });
    expect(transport).toBeInstanceOf(RealSmtpTransport);
    expect(transport.kind).toBe('real');
  });

  it('createSmtpTransport defaults only a missing mode to fixture', () => {
    const saved = process.env.MAIL_TRANSPORT_MODE;
    delete process.env.MAIL_TRANSPORT_MODE;
    try {
      expect(createSmtpTransport()).toBeInstanceOf(FakeSmtpTransport);
      process.env.MAIL_TRANSPORT_MODE = 'unknown-mode';
      expect(() => createSmtpTransport()).toThrow(
        /MAIL_TRANSPORT_MODE.*unknown-mode/,
      );
    } finally {
      if (saved === undefined) delete process.env.MAIL_TRANSPORT_MODE;
      else process.env.MAIL_TRANSPORT_MODE = saved;
    }
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

  it('createSmtpTransport uses a separate wire path without secret ARN', () => {
    const transport = createSmtpTransport({
      mode: 'wire',
      host: '127.0.0.1',
      port: 11025,
      secure: false,
    });
    expect(transport).not.toBeInstanceOf(RealSmtpTransport);
    expect(transport.kind).toBe('wire');
  });

  it('wire SMTP ignores ambient and option credentials', async () => {
    const saved = {
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      secretArn: process.env.SMTP_SECRET_ARN,
    };
    process.env.SMTP_USER = 'ambient-user';
    process.env.SMTP_PASSWORD = 'ambient-password';
    process.env.SMTP_SECRET_ARN = 'ambient-secret-arn';

    try {
      const transport = createSmtpTransport({
        mode: 'wire',
        host: '127.0.0.1',
        port: 11025,
        secure: false,
        user: 'option-user',
        password: 'option-password',
        secretArn: 'option-secret-arn',
      });

      await transport.send({
        from: 'from@example.com',
        to: ['to@example.com'],
        cc: [],
        bcc: [],
        subject: 'wire',
        html: '',
        text: 'wire',
      });

      expect(createTransportMock).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 11025,
        secure: false,
        auth: undefined,
      });
    } finally {
      if (saved.user === undefined) delete process.env.SMTP_USER;
      else process.env.SMTP_USER = saved.user;
      if (saved.password === undefined) delete process.env.SMTP_PASSWORD;
      else process.env.SMTP_PASSWORD = saved.password;
      if (saved.secretArn === undefined) delete process.env.SMTP_SECRET_ARN;
      else process.env.SMTP_SECRET_ARN = saved.secretArn;
    }
  });

  it('createSmtpTransport throws in real mode without credentials', () => {
    expect(() =>
      createSmtpTransport({
        mode: 'real',
        host: 'smtp.example.com',
        port: 587,
        user: 'relay@legacyhotel.com',
        requireTls: true,
        tlsServername: 'smtp.example.com',
      }),
    ).toThrow(/SMTP_PASSWORD or SMTP_SECRET_ARN/);
  });

  it('real SMTP enforces authenticated STARTTLS and explicit envelope sender', async () => {
    const transport = createSmtpTransport({
      mode: 'real',
      host: 'smtp.example.com',
      port: 587,
      user: 'relay@example.com',
      password: 'test-password',
      requireTls: true,
      tlsServername: 'smtp.example.com',
    });
    const payload = {
      from: 'sender@example.com',
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'subject',
      html: '<p>body</p>',
      text: 'body',
    };

    await transport.send(payload);

    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
      auth: {
        user: 'relay@example.com',
        pass: 'test-password',
      },
      tls: {
        rejectUnauthorized: true,
        servername: 'smtp.example.com',
      },
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: {
          from: 'sender@example.com',
          to: ['to@example.com', 'cc@example.com', 'bcc@example.com'],
        },
      }),
    );
  });

  it('direct RealSmtpTransport construction cannot omit TLS requirement to downgrade', async () => {
    const transport = new RealSmtpTransport({
      host: 'smtp.example.com',
      port: 587,
      user: 'relay@example.com',
      password: 'test-password',
      tlsServername: 'smtp.example.com',
    });

    await transport.send({
      from: 'sender@example.com',
      to: ['to@example.com'],
      cc: [],
      bcc: [],
      subject: 'subject',
      html: '',
      text: 'body',
    });

    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
      auth: {
        user: 'relay@example.com',
        pass: 'test-password',
      },
      tls: {
        rejectUnauthorized: true,
        servername: 'smtp.example.com',
      },
    });
  });

  it('SmtpTransport interface parity — fake and real expose send', () => {
    const fake = new FakeSmtpTransport();
    const real = new RealSmtpTransport({
      host: 'x',
      port: 587,
      user: 'u',
      password: 'p',
      tlsServername: 'x',
    });
    for (const transport of [fake, real]) {
      expect(typeof transport.send).toBe('function');
      expect(['fake', 'real']).toContain(transport.kind);
    }
  });
});

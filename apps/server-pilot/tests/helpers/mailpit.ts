import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';

export const WIRE_SMTP_PORT = 11_025;
export const WIRE_POP3_PORT = 11_110;
export const WIRE_HTTP_PORT = 18_025;
export const WIRE_POP3_USER = 'ingest@wire.test';
export const WIRE_POP3_PASSWORD = 'wire-test-pass';

export type MailpitContext = {
  httpUrl: string;
  smtpHost: string;
  smtpPort: number;
  pop3Host: string;
  pop3Port: number;
  pop3User: string;
  pop3Password: string;
  clearAll(): Promise<void>;
  injectRawEml(raw: Buffer, envelopeTo?: string): Promise<void>;
  stop(): Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/api/v1/info`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  throw new Error(`mailpit not ready at ${url}`);
}

/** Reuse EC2 sidecar when MAILPIT_HTTP_URL set; else spawn local binary. */
export async function startMailpitForTests(): Promise<MailpitContext | null> {
  const external = process.env.MAILPIT_HTTP_URL;
  if (external) {
    return buildContext(external, null);
  }

  const binary = process.env.MAILPIT_BINARY ?? 'mailpit';
  const httpUrl = `http://127.0.0.1:${WIRE_HTTP_PORT}`;

  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        `--smtp=127.0.0.1:${WIRE_SMTP_PORT}`,
        `--pop3=127.0.0.1:${WIRE_POP3_PORT}`,
        `--listen=127.0.0.1:${WIRE_HTTP_PORT}`,
      ],
      {
        env: {
          ...process.env,
          MP_POP3_AUTH: `${WIRE_POP3_USER}:${WIRE_POP3_PASSWORD}`,
        },
        stdio: 'ignore',
      },
    );

    child.on('error', () => resolve(null));

    waitForHttp(httpUrl)
      .then(() => resolve(buildContext(httpUrl, child)))
      .catch(() => {
        child.kill();
        resolve(null);
      });
  });
}

function buildContext(httpUrl: string, child: ChildProcess | null): MailpitContext {
  const u = new URL(httpUrl);
  return {
    httpUrl,
    smtpHost: u.hostname,
    smtpPort: WIRE_SMTP_PORT,
    pop3Host: u.hostname,
    pop3Port: WIRE_POP3_PORT,
    pop3User: WIRE_POP3_USER,
    pop3Password: WIRE_POP3_PASSWORD,
    async clearAll() {
      await fetch(`${httpUrl}/api/v1/messages`, { method: 'DELETE' });
    },
    async injectRawEml(raw: Buffer, envelopeTo = 'nava@legacyhotel.com') {
      const transport = nodemailer.createTransport({
        host: u.hostname,
        port: WIRE_SMTP_PORT,
        secure: false,
      });
      await transport.sendMail({
        envelope: { from: 'inject@wire.test', to: [envelopeTo] },
        raw,
      });
    },
    async stop() {
      if (!child) return;
      child.kill('SIGTERM');
      await sleep(500);
    },
  };
}

/** Wire env block for createPop3Client / process.env in tests. */
export function wireMailEnv(ctx: MailpitContext): NodeJS.ProcessEnv {
  return {
    MAIL_TRANSPORT_MODE: 'wire',
    SMTP_HOST: ctx.smtpHost,
    SMTP_PORT: String(ctx.smtpPort),
    SMTP_SECURE: 'false',
    POP3_HOST: ctx.pop3Host,
    POP3_PORT: String(ctx.pop3Port),
    POP3_TLS: 'false',
    POP3_USER: ctx.pop3User,
    POP3_PASSWORD: ctx.pop3Password,
  };
}

/** True when EC2 sidecar URL or explicit binary path is configured. */
export const mailpitConfigured = !!(
  process.env.MAILPIT_HTTP_URL || process.env.MAILPIT_BINARY
);

export function readFixtureEml(name: string): Buffer {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(path);
}

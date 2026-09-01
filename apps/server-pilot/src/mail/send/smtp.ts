/**
 * SMTP send adapter + fake transport for outbound mail.
 *
 * `MAIL_TRANSPORT_MODE=fixture` (default) uses `FakeSmtpTransport` — in-memory
 * ring buffer, no TCP. `MAIL_TRANSPORT_MODE=real` uses `RealSmtpTransport`
 * against Rocketseed (`172.24.0.8`) only — IP-trusted STARTTLS, never AUTH.
 * `wire` uses RealSmtpTransport against Mailpit (no hop pin).
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { MailTransportMode } from '../../env.js';

/** Sole allowed real-mail SMTP connect host (Rocketseed banner relay). */
export const ROCKETSEED_SMTP_HOST = '172.24.0.8';

/** TLS SNI for Rocketseed — not a connect host. */
export const ROCKETSEED_TLS_SERVERNAME = 'branding.legacyhotels.co.za';

export function isRocketseedSmtpHost(host: string): boolean {
  return host.trim() === ROCKETSEED_SMTP_HOST;
}

/** Fail closed: real mode may only connect to Rocketseed. */
export function assertRealSmtpHop(host: string): void {
  if (!isRocketseedSmtpHost(host)) {
    throw new Error(
      `SMTP_HOST must be ${ROCKETSEED_SMTP_HOST} when MAIL_TRANSPORT_MODE=real (got ${host})`,
    );
  }
}

export type RealSmtpNodemailerOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  auth?: { user: string; pass: string };
  tls: { rejectUnauthorized: boolean; servername?: string };
};

/**
 * Nodemailer options for real/wire TCP sends.
 * Rocketseed: never AUTH (even if password present); strict STARTTLS + SNI.
 * Wire/other: optional AUTH; shared MAIL_TLS_REJECT_UNAUTHORIZED for Mailpit.
 */
export function buildRealSmtpNodemailerOptions(opts: {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
}): RealSmtpNodemailerOptions {
  const secure = opts.secure ?? false;
  if (isRocketseedSmtpHost(opts.host)) {
    return {
      host: opts.host.trim(),
      port: opts.port,
      secure,
      requireTLS: true,
      auth: undefined,
      tls: {
        rejectUnauthorized: true,
        servername: ROCKETSEED_TLS_SERVERNAME,
      },
    };
  }
  const rejectUnauthorized =
    process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== 'false';
  return {
    host: opts.host,
    port: opts.port,
    secure,
    auth:
      opts.user && opts.password
        ? { user: opts.user, pass: opts.password }
        : undefined,
    tls: { rejectUnauthorized },
  };
}

export interface OutboundMailAttachment {
  filename: string;
  content: Buffer | string;
  contentType?: string;
}

export interface OutboundMailPayload {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  extraHeaders?: Record<string, string>;
  attachments?: OutboundMailAttachment[];
}

export interface SmtpSendResult {
  /** RFC Message-ID header value (without angle brackets). */
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface SmtpTransport {
  readonly kind: 'real' | 'fake';
  send(payload: OutboundMailPayload): Promise<SmtpSendResult>;
}

export interface SmtpTransportOptions {
  mode?: MailTransportMode;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  secretArn?: string;
  /** Force fake transport even when host is set (tests). */
  forceFake?: boolean;
}

function exactRecipientAddresses(
  recipients: readonly (string | { address?: unknown })[] | undefined,
): string[] {
  return (recipients ?? []).map((recipient) => {
    if (typeof recipient === 'string') return recipient;
    if (typeof recipient.address === 'string') return recipient.address;
    throw new Error('SMTP response recipient malformed');
  });
}

/** Ring buffer cap — prevents unbounded memory growth in long-running pilot. */
export const FAKE_SMTP_RING_MAX = 100;

/** In-memory fake transport — never connects to a real SMTP server. */
export class FakeSmtpTransport implements SmtpTransport {
  readonly kind = 'fake' as const;
  readonly sent: OutboundMailPayload[] = [];

  async send(payload: OutboundMailPayload): Promise<SmtpSendResult> {
    this.sent.push({ ...payload });
    if (this.sent.length > FAKE_SMTP_RING_MAX) {
      this.sent.shift();
    }
    const messageId = `${randomUUID()}@zero-fake-smtp.local`;
    return {
      messageId,
      accepted: [...payload.to, ...payload.cc, ...payload.bcc],
      rejected: [],
    };
  }
}

async function fetchSmtpSecret(secretArn: string): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const region = process.env.AWS_REGION ?? 'af-south-1';
  const client = new SecretsManagerClient({ region });
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const raw = out.SecretString;
  if (!raw) {
    throw new Error(`smtp secret empty: ${secretArn}`);
  }
  try {
    const parsed = JSON.parse(raw) as {
      SMTP_PASSWORD?: string;
      password?: string;
    };
    return parsed.SMTP_PASSWORD ?? parsed.password ?? raw;
  } catch {
    return raw;
  }
}

/** Real SMTP transport via nodemailer — Exchange/SMTP relay. */
export class RealSmtpTransport implements SmtpTransport {
  readonly kind = 'real' as const;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      secure?: boolean;
      user?: string;
      password?: string;
      secretArn?: string;
    },
  ) {}

  async send(payload: OutboundMailPayload): Promise<SmtpSendResult> {
    const password = isRocketseedSmtpHost(this.opts.host)
      ? undefined
      : await this.resolvePassword();
    const transporter = nodemailer.createTransport(
      buildRealSmtpNodemailerOptions({
        host: this.opts.host,
        port: this.opts.port,
        secure: this.opts.secure,
        user: this.opts.user,
        password,
      }),
    );

    const headers: Record<string, string> = { ...payload.extraHeaders };
    if (payload.inReplyTo) {
      headers['In-Reply-To'] = payload.inReplyTo;
    }
    if (payload.references?.length) {
      headers.References = payload.references.join(' ');
    }

    const info = await transporter.sendMail({
      from: payload.from,
      to: payload.to,
      cc: payload.cc.length ? payload.cc : undefined,
      bcc: payload.bcc.length ? payload.bcc : undefined,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      headers: Object.keys(headers).length ? headers : undefined,
      attachments: payload.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    const rawId = info.messageId ?? '';
    const messageId = rawId.replace(/^<|>$/g, '');
    if (!messageId) {
      throw new Error('SMTP response missing messageId');
    }
    return {
      messageId,
      accepted: exactRecipientAddresses(info.accepted),
      rejected: exactRecipientAddresses(info.rejected),
    };
  }

  private async resolvePassword(): Promise<string | undefined> {
    if (this.opts.password) return this.opts.password;
    const envPass = process.env.SMTP_PASSWORD;
    if (envPass) return envPass;
    if (this.opts.secretArn) {
      return fetchSmtpSecret(this.opts.secretArn);
    }
    return undefined;
  }
}

function resolveTransportMode(opts: SmtpTransportOptions): MailTransportMode {
  if (opts.mode) return opts.mode;
  const raw = process.env.MAIL_TRANSPORT_MODE ?? 'fixture';
  if (raw === 'real' || raw === 'wire') return raw;
  return 'fixture';
}

function usesRealSmtp(mode: MailTransportMode): boolean {
  return mode === 'real' || mode === 'wire';
}

/** Resolve transport from env — fake by default; wire/real use TCP when host set. */
export function createSmtpTransport(
  opts: SmtpTransportOptions = {},
): SmtpTransport {
  if (opts.forceFake) return new FakeSmtpTransport();

  const mode = resolveTransportMode(opts);
  if (!usesRealSmtp(mode)) return new FakeSmtpTransport();

  const host = opts.host ?? process.env.SMTP_HOST;
  const defaultPort = mode === 'wire' ? '11025' : '587';
  const port = opts.port ?? Number(process.env.SMTP_PORT ?? defaultPort);
  if (!host) {
    throw new Error(`SMTP_HOST required when MAIL_TRANSPORT_MODE=${mode}`);
  }
  if (mode === 'real') {
    assertRealSmtpHop(host);
  }

  const user = opts.user ?? process.env.SMTP_USER;
  const secretArn = opts.secretArn ?? process.env.SMTP_SECRET_ARN;
  const password = opts.password ?? process.env.SMTP_PASSWORD;

  const secureRaw = process.env.SMTP_SECURE;
  const secure =
    opts.secure ??
    (secureRaw === 'true' || secureRaw === '1'
      ? true
      : secureRaw === 'false' || secureRaw === '0'
        ? false
        : mode === 'wire'
          ? false
          : port === 465);

  return new RealSmtpTransport({
    host,
    port,
    secure,
    user,
    password,
    secretArn,
  });
}

let defaultTransport: SmtpTransport | null = null;

/** Singleton transport for production routes. Tests override via `__setSmtpTransportForTests`. */
export function getSmtpTransport(): SmtpTransport {
  if (!defaultTransport) {
    defaultTransport = createSmtpTransport();
  }
  return defaultTransport;
}

/** Test-only override — reset with `null` to restore default. */
export function __setSmtpTransportForTests(transport: SmtpTransport | null): void {
  defaultTransport = transport;
}

/** Build references chain for a reply. */
export function buildReplyHeaders(original: {
  messageIdHeader: string | null;
  references: string[] | null;
}): { inReplyTo: string | null; references: string[] } {
  const parentId = original.messageIdHeader;
  if (!parentId) {
    return { inReplyTo: null, references: [] };
  }
  const prior = original.references ?? [];
  const references = prior.includes(parentId) ? prior : [...prior, parentId];
  return { inReplyTo: parentId, references };
}

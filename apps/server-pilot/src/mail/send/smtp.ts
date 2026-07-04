/**
 * SMTP send adapter + fake transport for outbound mail.
 *
 * `MAIL_TRANSPORT_MODE=fixture` (default) uses `FakeSmtpTransport` — in-memory
 * ring buffer, no TCP. `MAIL_TRANSPORT_MODE=real` uses `RealSmtpTransport`
 * (nodemailer) against Exchange/SMTP relay when host + credentials are set.
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { MailTransportMode } from '../../env.js';

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
}

export interface SmtpSendResult {
  /** RFC Message-ID header value (without angle brackets). */
  messageId: string;
  accepted: string[];
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
    const password = await this.resolvePassword();
    const transporter = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure ?? false,
      auth:
        this.opts.user && password
          ? { user: this.opts.user, pass: password }
          : undefined,
    });

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
    });

    const rawId = info.messageId ?? '';
    const messageId = rawId.replace(/^<|>$/g, '');
    const accepted = (info.accepted ?? []).map(String);
    return {
      messageId: messageId || `${randomUUID()}@zero-smtp.local`,
      accepted:
        accepted.length > 0
          ? accepted
          : [...payload.to, ...payload.cc, ...payload.bcc],
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
  if (raw === 'real') return 'real';
  return 'fixture';
}

/** Resolve transport from env — fake by default; real only when mode=real + host. */
export function createSmtpTransport(
  opts: SmtpTransportOptions = {},
): SmtpTransport {
  if (opts.forceFake) return new FakeSmtpTransport();

  const mode = resolveTransportMode(opts);
  if (mode !== 'real') return new FakeSmtpTransport();

  const host = opts.host ?? process.env.SMTP_HOST;
  const port = opts.port ?? Number(process.env.SMTP_PORT ?? '587');
  if (!host) {
    throw new Error('SMTP_HOST required when MAIL_TRANSPORT_MODE=real');
  }

  const user = opts.user ?? process.env.SMTP_USER;
  const secretArn = opts.secretArn ?? process.env.SMTP_SECRET_ARN;
  const password = opts.password ?? process.env.SMTP_PASSWORD;
  if (!password && !secretArn) {
    throw new Error(
      'SMTP_PASSWORD or SMTP_SECRET_ARN required when MAIL_TRANSPORT_MODE=real',
    );
  }

  const secureRaw = process.env.SMTP_SECURE;
  const secure =
    opts.secure ??
    (secureRaw === 'true' || secureRaw === '1'
      ? true
      : secureRaw === 'false' || secureRaw === '0'
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

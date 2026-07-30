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
  readonly kind: 'real' | 'wire' | 'fake';
  send(payload: OutboundMailPayload): Promise<SmtpSendResult>;
}

export interface SmtpTransportOptions {
  mode?: MailTransportMode;
  host?: string;
  port?: number;
  secure?: boolean;
  requireTls?: boolean;
  tlsServername?: string;
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

type NodemailerTransporter = ReturnType<typeof nodemailer.createTransport>;

async function sendWithTransporter(
  transporter: NodemailerTransporter,
  payload: OutboundMailPayload,
  transmittedMessageId?: string,
): Promise<SmtpSendResult> {
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
    envelope: {
      from: payload.from,
      to: [...payload.to, ...payload.cc, ...payload.bcc],
    },
    ...(transmittedMessageId ? { messageId: transmittedMessageId } : {}),
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: payload.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  const rawId = info.messageId || transmittedMessageId || '';
  const messageId = rawId.replace(/^<|>$/g, '');
  return {
    messageId: messageId || `${randomUUID()}@zero-smtp.local`,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/** Real SMTP transport via nodemailer — Exchange/SMTP relay. */
export class RealSmtpTransport implements SmtpTransport {
  readonly kind = 'real' as const;
  private readonly opts: {
    host: string;
    port: number;
    tlsServername: string;
    user: string;
    password?: string;
    secretArn?: string;
  };

  constructor(opts: {
    host: string;
    port: number;
    tlsServername: string;
    user: string;
    password?: string;
    secretArn?: string;
  }) {
    if (!opts.tlsServername) {
      throw new Error('SMTP_TLS_SERVERNAME required for real SMTP transport');
    }
    if (!opts.user) {
      throw new Error('SMTP_USER required for real SMTP transport');
    }
    if (!opts.password && !opts.secretArn) {
      throw new Error(
        'SMTP_PASSWORD or SMTP_SECRET_ARN required for real SMTP transport',
      );
    }
    this.opts = opts;
  }

  async send(payload: OutboundMailPayload): Promise<SmtpSendResult> {
    const password = await this.resolvePassword();
    const transporter = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: false,
      requireTLS: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
      auth: { user: this.opts.user, pass: password },
      tls: {
        rejectUnauthorized: true,
        servername: this.opts.tlsServername,
      },
    });
    const transmittedMessageId = `${randomUUID()}@zero-smtp.local`;
    return sendWithTransporter(transporter, payload, transmittedMessageId);
  }

  private async resolvePassword(): Promise<string> {
    if (this.opts.password) return this.opts.password;
    return fetchSmtpSecret(this.opts.secretArn as string);
  }
}

/** Mailpit/wire transport — cleartext-capable and never authenticates. */
class WireSmtpTransport implements SmtpTransport {
  readonly kind = 'wire' as const;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      secure: boolean;
    },
  ) {}

  async send(payload: OutboundMailPayload): Promise<SmtpSendResult> {
    const transporter = nodemailer.createTransport({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: undefined,
    });
    return sendWithTransporter(transporter, payload);
  }
}

function resolveTransportMode(opts: SmtpTransportOptions): MailTransportMode {
  const raw = opts.mode ?? process.env.MAIL_TRANSPORT_MODE;
  if (!raw) return 'fixture';
  if (raw === 'fixture' || raw === 'real' || raw === 'wire') return raw;
  throw new Error(
    `MAIL_TRANSPORT_MODE must be fixture, wire, or real; got: ${raw}`,
  );
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

  if (mode === 'wire') {
    const secureRaw = process.env.SMTP_SECURE;
    const secure =
      opts.secure ?? (secureRaw === 'true' || secureRaw === '1');
    return new WireSmtpTransport({ host, port, secure });
  }

  const user = opts.user ?? process.env.SMTP_USER;
  const secretArn = opts.secretArn ?? process.env.SMTP_SECRET_ARN;
  const password = opts.password ?? process.env.SMTP_PASSWORD;
  const requireTlsRaw = process.env.SMTP_REQUIRE_TLS;
  const requireTls =
    opts.requireTls ??
    (requireTlsRaw === 'true' || requireTlsRaw === '1');
  const tlsServername =
    opts.tlsServername ?? process.env.SMTP_TLS_SERVERNAME;
  if (!user) {
    throw new Error('SMTP_USER required when MAIL_TRANSPORT_MODE=real');
  }
  if (!password && !secretArn) {
    throw new Error(
      'SMTP_PASSWORD or SMTP_SECRET_ARN required when MAIL_TRANSPORT_MODE=real',
    );
  }
  if (!requireTls) {
    throw new Error(
      'SMTP_REQUIRE_TLS=true required when MAIL_TRANSPORT_MODE=real',
    );
  }
  if (!tlsServername) {
    throw new Error(
      'SMTP_TLS_SERVERNAME required when MAIL_TRANSPORT_MODE=real',
    );
  }

  return new RealSmtpTransport({
    host,
    port,
    tlsServername,
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

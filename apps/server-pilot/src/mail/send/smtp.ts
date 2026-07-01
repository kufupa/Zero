/**
 * SMTP send adapter + fake transport for outbound mail.
 *
 * REAL mail server connection is OUT OF SCOPE for this pass. The interface
 * (`SmtpTransport`) is what `mail.send` depends on; production will use a
 * real relay (Exchange Send As / SMTP relay). Tests and the default pilot
 * path use `FakeSmtpTransport`, which records sends in memory and never
 * opens a TCP connection.
 */
import { randomUUID } from 'node:crypto';

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
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  secretArn?: string;
  /** Force fake transport even when host is set (tests). */
  forceFake?: boolean;
}

/** In-memory fake transport — never connects to a real SMTP server. */
export class FakeSmtpTransport implements SmtpTransport {
  readonly kind = 'fake' as const;
  readonly sent: OutboundMailPayload[] = [];

  async send(payload: OutboundMailPayload): Promise<SmtpSendResult> {
    this.sent.push({ ...payload });
    const messageId = `${randomUUID()}@zero-fake-smtp.local`;
    return {
      messageId,
      accepted: [...payload.to, ...payload.cc, ...payload.bcc],
    };
  }
}

/**
 * Real SMTP transport stub — interface ready for Exchange/SMTP relay.
 * Not exercised against a real server in this pass.
 */
export class RealSmtpTransport implements SmtpTransport {
  readonly kind = 'real' as const;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      user?: string;
      password?: string;
    },
  ) {}

  async send(_payload: OutboundMailPayload): Promise<SmtpSendResult> {
    throw new Error(
      `Real SMTP send not enabled in pilot pass (host=${this.opts.host ?? 'unset'})`,
    );
  }
}

/** Resolve transport from env — fake by default; real only when explicitly configured. */
export function createSmtpTransport(
  opts: SmtpTransportOptions = {},
): SmtpTransport {
  if (opts.forceFake) return new FakeSmtpTransport();
  const host = opts.host ?? process.env.SMTP_HOST;
  const port = opts.port ?? Number(process.env.SMTP_PORT ?? '587');
  if (host && process.env.SMTP_ENABLE_REAL === 'true') {
    return new RealSmtpTransport({
      host,
      port,
      user: opts.user ?? process.env.SMTP_USER,
      password: opts.password,
    });
  }
  return new FakeSmtpTransport();
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

import { INGEST_EMAIL } from '../db/seed.js';
import type { OutboundMailPayload, SmtpSendResult } from './send/smtp.js';
import type { MailTransportMode } from '../env.js';

export interface LoopbackMessage {
  uidl: string;
  raw: Buffer;
}

class FixtureLoopbackStoreImpl {
  private queue: LoopbackMessage[] = [];
  private seq = 0;

  enqueue(raw: Buffer): string {
    const uidl = `loopback-${++this.seq}`;
    this.queue.push({ uidl, raw });
    return uidl;
  }

  drain(): LoopbackMessage[] {
    const out = [...this.queue];
    this.queue = [];
    return out;
  }

  reset(): void {
    this.queue = [];
    this.seq = 0;
  }
}

export const fixtureLoopbackStore = new FixtureLoopbackStoreImpl();

export function resetFixtureLoopbackStoreForTests(): void {
  fixtureLoopbackStore.reset();
}

export function recipientMatchesIngestEmail(addresses: string[]): boolean {
  const t = INGEST_EMAIL.toLowerCase();
  return addresses.some((a) => a.toLowerCase() === t);
}

export function buildLoopbackEml(args: {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  extraHeaders?: Record<string, string>;
}): Buffer {
  const lines = [
    `From: ${args.from}`,
    `To: ${args.to.join(', ')}`,
    `Subject: ${args.subject}`,
    `Message-ID: <${args.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ];
  if (args.cc?.length) lines.splice(3, 0, `Cc: ${args.cc.join(', ')}`);
  if (args.inReplyTo) lines.push(`In-Reply-To: <${args.inReplyTo}>`);
  if (args.references?.length) {
    lines.push(`References: ${args.references.map((r) => `<${r}>`).join(' ')}`);
  }
  for (const [k, v] of Object.entries(args.extraHeaders ?? {})) lines.push(`${k}: ${v}`);
  lines.push('', args.html || args.text);
  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

export function maybeEnqueueLoopback(
  payload: OutboundMailPayload,
  smtpResult: SmtpSendResult,
  mode: MailTransportMode,
  extraHeaders?: Record<string, string>,
): void {
  if (mode === 'real' || mode === 'wire') return;
  const recipients = [...payload.to, ...payload.cc, ...payload.bcc];
  if (!recipientMatchesIngestEmail(recipients)) return;
  const raw = buildLoopbackEml({
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    messageId: smtpResult.messageId,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    extraHeaders,
  });
  fixtureLoopbackStore.enqueue(raw);
}

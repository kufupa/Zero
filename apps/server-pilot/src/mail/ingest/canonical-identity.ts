import { attachment, message } from '../../db/schema/mail.js';
import { canonicalMessageId } from './message-id.js';
import type { DB } from '../../db/client.js';
import { and, eq, sql } from 'drizzle-orm';

export type CanonicalEvidence = {
  internetMessageId: string | null;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  authoredAt: Date | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: { sizeBytes: number; sha256: string | null }[];
};
/** Corroboration accepts a complete, syntactically bounded Internet Message-ID. */
export const corroboratedMessageId = (raw: string | null): string | null => {
  if (!raw || raw.length > 998) return null;
  const value = raw.trim();
  if (value.startsWith('<') !== value.endsWith('>')) return null;
  const id = canonicalMessageId(value);
  return id && /^[^\s<>@]+@[^\s<>@]+$/.test(id) ? id : null;
};
const address = (v: string) => (/<([^<>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();
const participants = (v: string[]) => [...new Set(v.map(address))].sort().join('\n');
const body = (v: CanonicalEvidence) =>
  (v.textBody || v.htmlBody?.replace(/<[^>]*>/g, ' ') || '').replace(/\s+/g, ' ').trim();
/** Mailbox lock precedes every fresh candidate read, insertion and admission snapshot. */
export async function lockCanonicalMailbox(db: DB, transportId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('mail-canonical'), hashtext(${transportId}))`,
  );
}
export function compatibleCanonicalEvidence(a: CanonicalEvidence, b: CanonicalEvidence): boolean {
  const id = corroboratedMessageId(a.internetMessageId);
  if (
    !id ||
    id !== corroboratedMessageId(b.internetMessageId) ||
    a.direction !== b.direction ||
    !address(a.fromAddress) ||
    address(a.fromAddress) !== address(b.fromAddress) ||
    participants(a.toAddresses) !== participants(b.toAddresses) ||
    participants(a.ccAddresses) !== participants(b.ccAddresses) ||
    !a.authoredAt ||
    !b.authoredAt ||
    !Number.isFinite(a.authoredAt.getTime()) ||
    !Number.isFinite(b.authoredAt.getTime()) ||
    Math.abs(a.authoredAt.getTime() - b.authoredAt.getTime()) > 120_000 ||
    !body(a) ||
    body(a) !== body(b)
  )
    return false;
  // Retain richer attachment variants. Conflicting known checksums cannot corroborate a reused ID.
  if (a.attachments.length && b.attachments.length) {
    const left = a.attachments.map((x) => `${x.sizeBytes}:${x.sha256 ?? ''}`).sort();
    const right = b.attachments.map((x) => `${x.sizeBytes}:${x.sha256 ?? ''}`).sort();
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length <= right.length ? right : left;
    const remaining = [...longer];
    for (const entry of shorter) {
      const index = remaining.indexOf(entry);
      if (entry.endsWith(':') || index < 0) return false;
      remaining.splice(index, 1);
    }
  }
  return true;
}
export async function findCanonicalCandidate(
  db: DB,
  transportId: string,
  evidence: CanonicalEvidence,
) {
  const id = corroboratedMessageId(evidence.internetMessageId);
  if (!id) return { kind: 'none' as const };
  const rows = await db
    .select()
    .from(message)
    .where(and(eq(message.transportId, transportId), eq(message.messageIdHeader, id)))
    .limit(101);
  if (rows.length > 100) return { kind: 'ambiguous' as const };
  const compatible: typeof rows = [];
  for (const row of rows) {
    const artifacts = await db
      .select({ sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 })
      .from(attachment)
      .where(eq(attachment.messageId, row.id));
    if (
      compatibleCanonicalEvidence(evidence, {
        ...row,
        internetMessageId: row.messageIdHeader,
        authoredAt: row.direction === 'outbound' ? row.sentAt : row.receivedAt,
        attachments: artifacts,
      })
    )
      compatible.push(row);
  }
  return compatible.length === 1
    ? { kind: 'unique' as const, message: compatible[0]! }
    : compatible.length > 1
      ? { kind: 'ambiguous' as const }
      : { kind: 'none' as const };
}

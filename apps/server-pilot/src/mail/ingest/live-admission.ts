import {
  attachment,
  mailboxTransport,
  mailLabel,
  mailLiveAdmission,
  mailThread,
  message,
} from '../../db/schema/mail.js';
import {
  DEFAULT_AI_MODEL_ID,
  DEFAULT_TRIAGE_PROMPT_VERSION,
  enqueueAiRun,
} from '../../ai/run-ledger.js';
import { enqueueShadowPrediction } from '../../ai/shadow-evaluation.js';
import { THREAD_CONTEXT_MAX_BYTES } from '../../ai/thread-context.js';
import { lockCanonicalMailbox } from './canonical-identity.js';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getSenderPreference } from '../sender-preference.js';
import { createHash, randomUUID } from 'node:crypto';
import { markThreadRead } from '../thread-read.js';
import type { DB } from '../../db/client.js';

export type AdmissionProjection = {
  id: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  createdAt: string;
  receivedAt: string | null;
  sentAt: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[] | null;
};
export type AdmissionSnapshot = {
  version: 1;
  admittedAt?: string;
  transportId: string;
  triggerMessageId: string;
  threadMessages: AdmissionProjection[];
  transportMessages: AdmissionProjection[];
  artifacts: {
    id: string;
    messageId: string;
    s3Key: string;
    sha256: string | null;
    sizeBytes: number;
    mimeType: string;
    filename: string;
    isInline: boolean;
    createdAt: string;
  }[];
};
export type NativeAdmissionEvidence = {
  direction: string;
  receivedAt?: string | null;
  sentAt?: string | null;
  event: {
    kind: string;
    observedAt: string;
    receivedAt?: string | null;
    wasUnsent?: boolean;
    isUnsent?: boolean;
    sentCopySaved?: boolean;
  };
};
export function qualifiesNativeAdmission(cutover: Date, e: NativeAdmissionEvidence): boolean {
  const start = cutover.getTime(),
    observed = Date.parse(e.event.observedAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(observed) ||
    observed < start ||
    e.event.isUnsent === true
  )
    return false;
  if (e.direction === 'inbound' && e.event.kind === 'new-mail') {
    const received = Date.parse(e.receivedAt ?? '');
    return (
      Number.isFinite(received) &&
      received >= start &&
      received <= observed &&
      e.event.receivedAt === e.receivedAt
    );
  }
  if (e.direction === 'outbound' && e.event.kind === 'saved-sent') {
    const sent = Date.parse(e.sentAt ?? '');
    return (
      Number.isFinite(sent) &&
      sent >= start &&
      sent <= observed &&
      e.event.wasUnsent === true &&
      e.event.isUnsent === false &&
      e.event.sentCopySaved === true
    );
  }
  return false;
}
const utf8Prefix = (value: string | null, maxBytes: number): string | null => {
  if (value === null) return null;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
};
type ProjectionRow = Pick<
  typeof message.$inferSelect,
  | 'id'
  | 'threadId'
  | 'direction'
  | 'fromAddress'
  | 'subject'
  | 'textBody'
  | 'htmlBody'
  | 'createdAt'
  | 'receivedAt'
  | 'sentAt'
  | 'toAddresses'
  | 'ccAddresses'
  | 'bccAddresses'
  | 'messageIdHeader'
  | 'inReplyTo'
  | 'references'
>;
const projection = (row: ProjectionRow, bodyBudget: number): AdmissionProjection => {
  const textBody = utf8Prefix(row.textBody, bodyBudget);
  const htmlBody = textBody ? null : utf8Prefix(row.htmlBody, bodyBudget);
  const addresses = (values: string[]) => values.slice(0, 50).map((v) => v.slice(0, 256));
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction,
    fromAddress: row.fromAddress.slice(0, 256),
    subject: row.subject?.slice(0, 512) ?? null,
    textBody,
    htmlBody,
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    toAddresses: addresses(row.toAddresses),
    ccAddresses: addresses(row.ccAddresses),
    bccAddresses: addresses(row.bccAddresses),
    messageIdHeader: row.messageIdHeader?.slice(0, 998) ?? null,
    inReplyTo: row.inReplyTo?.slice(0, 998) ?? null,
    references: row.references?.slice(-30).map((v) => v.slice(0, 998)) ?? null,
  };
};
const canonicalJson = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalJson)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonicalJson(v)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
export async function readAdmissionSnapshot(
  db: DB,
  id: string,
  expectedHash?: string,
): Promise<AdmissionSnapshot> {
  const [receipt] = await db
    .select()
    .from(mailLiveAdmission)
    .where(eq(mailLiveAdmission.id, id))
    .limit(1);
  if (
    !receipt ||
    receipt.snapshotHash !== hash(receipt.snapshot) ||
    (expectedHash && receipt.snapshotHash !== expectedHash)
  )
    throw new Error('Admission snapshot integrity mismatch');
  return receipt.snapshot as unknown as AdmissionSnapshot;
}
export async function admitLiveMessage(
  db: DB,
  input: {
    transportId: string;
    canonicalMessageId: string;
    newlyPersisted?: boolean;
    evidence:
      | { kind: 'verified-pop3'; sourceReceiptId: string }
      | {
          kind: 'native';
          sourceReceiptId: string;
          cutover: Date;
          observation: NativeAdmissionEvidence;
        };
  },
): Promise<{ admitted: boolean; receiptId: string }> {
  await lockCanonicalMailbox(db, input.transportId);
  const [prior] = await db
    .select()
    .from(mailLiveAdmission)
    .where(
      and(
        eq(mailLiveAdmission.transportId, input.transportId),
        eq(mailLiveAdmission.canonicalMessageId, input.canonicalMessageId),
      ),
    )
    .limit(1);
  if (prior) return { admitted: false, receiptId: prior.id };
  if (
    input.evidence.kind === 'native' &&
    !qualifiesNativeAdmission(input.evidence.cutover, input.evidence.observation)
  )
    return { admitted: false, receiptId: '' };
  const boundedColumns = {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    fromAddress: message.fromAddress,
    subject: message.subject,
    createdAt: message.createdAt,
    receivedAt: message.receivedAt,
    sentAt: message.sentAt,
    toAddresses: message.toAddresses,
    ccAddresses: message.ccAddresses,
    bccAddresses: message.bccAddresses,
    messageIdHeader: message.messageIdHeader,
    inReplyTo: message.inReplyTo,
    references: message.references,
    historyOnly: message.historyOnly,
    attention: sql<string | null>`${message.sourceProvenance}->>'attention'`,
    textBody: sql<string | null>`left(${message.textBody},16384)`,
    htmlBody: sql<string | null>`left(${message.htmlBody},16384)`,
  };
  const [trigger] = await db
    .select(boundedColumns)
    .from(message)
    .where(
      and(eq(message.id, input.canonicalMessageId), eq(message.transportId, input.transportId)),
    )
    .for('update')
    .limit(1);
  if (!trigger) throw new Error('Live admission trigger unavailable');
  if (trigger.attention === 'AMBIGUOUS_IDENTITY') return { admitted: false, receiptId: '' };
  // Existing operational rows predate this admission authority. A fresh producer
  // explicitly marks its insertion under the same mailbox lock; reconciliation
  // and native retries can never replay an old row while startup seeding runs.
  if (!trigger.historyOnly && !input.newlyPersisted) {
    const id = randomUUID();
    const snapshot: AdmissionSnapshot = {
      version: 1,
      transportId: input.transportId,
      triggerMessageId: trigger.id,
      threadMessages: [],
      transportMessages: [],
      artifacts: [],
    };
    await db.insert(mailLiveAdmission).values({
      id,
      transportId: input.transportId,
      canonicalMessageId: trigger.id,
      evidence: { kind: 'existing-operational-baseline' },
      snapshot: snapshot as unknown as Record<string, unknown>,
      snapshotHash: hash(snapshot),
      effectState: 'baseline',
    });
    return { admitted: false, receiptId: id };
  }
  const threadRows = await db
    .select(boundedColumns)
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, trigger.threadId)))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(50);
  if (!threadRows.some((r) => r.id === trigger.id)) threadRows.push(trigger);
  const transportRows = await db
    .select({
      ...boundedColumns,
      textBody: sql<string | null>`NULL`,
      htmlBody: sql<string | null>`NULL`,
    })
    .from(message)
    .where(eq(message.transportId, input.transportId))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(100);
  const ids = [...new Set([...threadRows, ...transportRows].map((r) => r.id))];
  const artifactRows = ids.length
    ? await db
        .select({
          id: attachment.id,
          messageId: attachment.messageId,
          s3Key: attachment.s3Key,
          sha256: attachment.sha256,
          sizeBytes: attachment.sizeBytes,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          isInline: attachment.isInline,
          createdAt: attachment.createdAt,
        })
        .from(attachment)
        .where(inArray(attachment.messageId, ids))
        .orderBy(asc(attachment.id))
        .limit(200)
    : [];
  const artifacts = artifactRows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  let remaining = THREAD_CONTEXT_MAX_BYTES;
  const projected = new Map<string, AdmissionProjection>();
  for (const row of [trigger, ...threadRows.filter((r) => r.id !== trigger.id)]) {
    const value = projection(
      row,
      Math.min(remaining, row.id === trigger.id ? 16 * 1024 : 2 * 1024),
    );
    remaining -= Buffer.byteLength(value.textBody ?? value.htmlBody ?? '');
    projected.set(row.id, value);
  }
  const sorted = [...projected.values()].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
  );
  // The transport index consumes metadata only. Source bodies remain complete
  // in canonical storage while actual worker inputs obey the existing budget.
  const snapshot: AdmissionSnapshot = {
    version: 1,
    admittedAt: new Date().toISOString(),
    transportId: input.transportId,
    triggerMessageId: trigger.id,
    threadMessages: sorted,
    transportMessages: transportRows.map((row) => projection(row, 0)),
    artifacts,
  };
  // Drop least-recent optional context before admitting an unusually wide
  // metadata projection. Never reject complete source storage for AI budgets.
  while (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) {
    if (snapshot.transportMessages.length) {
      snapshot.transportMessages.shift();
      continue;
    }
    if (snapshot.artifacts.length) {
      snapshot.artifacts.pop();
      continue;
    }
    const optional = snapshot.threadMessages.findIndex((row) => row.id !== trigger.id);
    if (optional < 0) throw new Error('Trigger metadata exceeds input budget');
    snapshot.threadMessages.splice(optional, 1);
  }
  const id = randomUUID(),
    snapshotHash = hash(snapshot);
  await db.insert(mailLiveAdmission).values({
    id,
    transportId: input.transportId,
    canonicalMessageId: trigger.id,
    evidence: input.evidence as unknown as Record<string, unknown>,
    snapshot: snapshot as unknown as Record<string, unknown>,
    snapshotHash,
    effectState: 'queued',
  });
  await db
    .update(message)
    .set({ historyOnly: false, isRead: trigger.direction === 'outbound' })
    .where(eq(message.id, trigger.id));
  await db
    .update(mailThread)
    .set({
      historyOnly: false,
      isRead: trigger.direction === 'outbound',
      latestMessageAt: sql`greatest(${mailThread.latestMessageAt},${(trigger.receivedAt ?? trigger.sentAt ?? trigger.createdAt).toISOString()}::timestamp)`,
      updatedAt: new Date(),
    })
    .where(eq(mailThread.id, trigger.threadId));
  if (trigger.direction === 'outbound')
    await markThreadRead(db, input.transportId, [trigger.threadId]);
  else if (trigger.historyOnly) {
    const preference = await getSenderPreference({
      db,
      transportId: input.transportId,
      emailRaw: trigger.fromAddress,
    });
    if (preference === 'block')
      await db
        .update(mailThread)
        .set({ spamAt: new Date(), updatedAt: new Date() })
        .where(eq(mailThread.id, trigger.threadId));
    if (process.env.AI_WRITE_GATE_ENABLED !== 'true') {
      const [transport] = await db
        .select({ email: mailboxTransport.email })
        .from(mailboxTransport)
        .where(eq(mailboxTransport.id, input.transportId))
        .limit(1);
      const domain = (raw: string) =>
        (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase().split('@')[1];
      if (
        !domain(trigger.fromAddress) ||
        domain(trigger.fromAddress) !== domain(transport?.email ?? '')
      ) {
        const labelId = `label-soft-quarantine-${input.transportId}`;
        await db
          .insert(mailLabel)
          .values({
            id: labelId,
            transportId: input.transportId,
            name: 'soft-quarantine',
            color: null,
          })
          .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
        const [thread] = await db
          .select({ labelIds: mailThread.labelIds })
          .from(mailThread)
          .where(eq(mailThread.id, trigger.threadId))
          .limit(1);
        await db
          .update(mailThread)
          .set({
            labelIds: [...new Set([...(thread?.labelIds ?? []), labelId])],
            updatedAt: new Date(),
          })
          .where(eq(mailThread.id, trigger.threadId));
      }
    }
  }
  await enqueueAiRun(
    {
      transportId: input.transportId,
      threadId: trigger.threadId,
      triggerMessageId: trigger.id,
      runKind: 'inbound_triage',
      idempotencyKey:
        trigger.direction === 'outbound'
          ? `external-sent-baseline:${trigger.id}`
          : `inbound-triage:${trigger.id}`,
      modelId: DEFAULT_AI_MODEL_ID,
      promptVersion: DEFAULT_TRIAGE_PROMPT_VERSION,
      admissionSnapshotId: id,
      admissionSnapshotHash: snapshotHash,
    },
    db,
  );
  if (trigger.direction === 'inbound')
    await enqueueShadowPrediction({
      transportId: input.transportId,
      threadId: trigger.threadId,
      triggerMessageId: trigger.id,
      admissionSnapshotId: id,
      admissionSnapshotHash: snapshotHash,
      db,
    });
  return { admitted: true, receiptId: id };
}
export async function seedLiveAdmissionBaseline(db: DB, transportId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as DB;
    await lockCanonicalMailbox(scoped, transportId);
    const rows = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.transportId, transportId),
          eq(message.historyOnly, false),
          sql`NOT EXISTS (SELECT 1 FROM mail_live_admission a WHERE a.transport_id=${transportId} AND a.canonical_message_id=${message.id})`,
        ),
      )
      .orderBy(asc(message.id))
      .limit(250);
    for (const row of rows) {
      const snapshot: AdmissionSnapshot = {
        version: 1,
        transportId,
        triggerMessageId: row.id,
        threadMessages: [],
        transportMessages: [],
        artifacts: [],
      };
      await tx
        .insert(mailLiveAdmission)
        .values({
          id: randomUUID(),
          transportId,
          canonicalMessageId: row.id,
          evidence: { kind: 'existing-operational-baseline' },
          snapshot: snapshot as unknown as Record<string, unknown>,
          snapshotHash: hash(snapshot),
          effectState: 'baseline',
        })
        .onConflictDoNothing();
    }
    return rows.length;
  });
}

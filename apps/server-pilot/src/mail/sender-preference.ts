import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { normalizeEmailAddress } from '../ai/never-spam.js';
import type { DB } from '../db/client.js';
import { mailSenderPreference, message } from '../db/schema/mail.js';

export async function upsertSenderPreference(input: {
  db: DB;
  transportId: string;
  emailRaw: string;
  kind: 'block' | 'allow';
}): Promise<{ email: string; kind: 'block' | 'allow' }> {
  const email = normalizeEmailAddress(input.emailRaw);
  const now = new Date();

  await input.db
    .insert(mailSenderPreference)
    .values({
      id: randomUUID(),
      transportId: input.transportId,
      email,
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mailSenderPreference.transportId, mailSenderPreference.email],
      set: {
        kind: input.kind,
        updatedAt: now,
      },
    });

  return { email, kind: input.kind };
}

export async function getSenderPreference(input: {
  db: DB;
  transportId: string;
  emailRaw: string;
}): Promise<'block' | 'allow' | null> {
  const email = normalizeEmailAddress(input.emailRaw);
  const rows = await input.db
    .select({ kind: mailSenderPreference.kind })
    .from(mailSenderPreference)
    .where(
      and(
        eq(mailSenderPreference.transportId, input.transportId),
        eq(mailSenderPreference.email, email),
      ),
    )
    .limit(1);
  return rows[0]?.kind ?? null;
}

export async function removeSenderPreference(input: {
  db: DB;
  transportId: string;
  emailRaw: string;
}): Promise<{ removed: boolean }> {
  const email = normalizeEmailAddress(input.emailRaw);
  const deleted = await input.db
    .delete(mailSenderPreference)
    .where(
      and(
        eq(mailSenderPreference.transportId, input.transportId),
        eq(mailSenderPreference.email, email),
      ),
    )
    .returning({ id: mailSenderPreference.id });
  return { removed: deleted.length > 0 };
}

/** Latest inbound From on thread (mark-spam blocks this sender only; multi-sender threads). */
export async function getLatestInboundFromAddress(
  db: DB,
  transportId: string,
  threadId: string,
): Promise<string | null> {
  const rows = await db
    .select({ fromAddress: message.fromAddress })
    .from(message)
    .where(
      and(
        eq(message.transportId, transportId),
        eq(message.threadId, threadId),
        eq(message.direction, 'inbound'),
      ),
    )
    .orderBy(desc(message.receivedAt))
    .limit(1);
  return rows[0]?.fromAddress ?? null;
}

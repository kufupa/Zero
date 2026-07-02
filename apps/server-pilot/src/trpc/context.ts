/**
 * Mailbox context resolver for tRPC.
 */
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  mailboxAccess,
  mailboxTransport,
  type MailboxAccessRole,
} from '../db/schema/mail.js';
import type * as schema from '../db/schema/index.js';

export type DB = PostgresJsDatabase<typeof schema>;

export type MailboxContext = {
  userId: string;
  activeTransportId: string;
  transportEmail: string;
  accessRole: MailboxAccessRole;
};

export class MailboxForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message);
    this.name = 'MailboxForbiddenError';
  }
}

/** User is authenticated but has zero mailbox_access rows. */
export class MailboxNoAccessError extends Error {
  constructor(message = 'NO_MAILBOX') {
    super(message);
    this.name = 'MailboxNoAccessError';
  }
}

export async function resolveMailboxContext(
  userId: string,
  requestedTransportId: string | undefined,
  db: DB,
): Promise<MailboxContext> {
  if (requestedTransportId) {
    const access = await db
      .select({
        transportId: mailboxAccess.transportId,
        role: mailboxAccess.role,
        email: mailboxTransport.email,
      })
      .from(mailboxAccess)
      .innerJoin(
        mailboxTransport,
        eq(mailboxAccess.transportId, mailboxTransport.id),
      )
      .where(
        and(
          eq(mailboxAccess.userId, userId),
          eq(mailboxAccess.transportId, requestedTransportId),
        ),
      )
      .limit(1);

    if (access.length === 0) {
      throw new MailboxForbiddenError();
    }
    const row = access[0]!;
    return {
      userId,
      activeTransportId: row.transportId,
      transportEmail: row.email,
      accessRole: row.role,
    };
  }

  const candidates = await db
    .select({
      transportId: mailboxAccess.transportId,
      role: mailboxAccess.role,
      email: mailboxTransport.email,
      isDefault: mailboxAccess.isDefault,
    })
    .from(mailboxAccess)
    .innerJoin(
      mailboxTransport,
      eq(mailboxAccess.transportId, mailboxTransport.id),
    )
    .where(eq(mailboxAccess.userId, userId));

  if (candidates.length === 0) {
    throw new MailboxNoAccessError();
  }

  const roleRank: Record<MailboxAccessRole, number> = {
    owner: 0,
    admin: 1,
    member: 2,
  };
  candidates.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return roleRank[a.role] - roleRank[b.role];
  });
  const row = candidates[0]!;
  return {
    userId,
    activeTransportId: row.transportId,
    transportEmail: row.email,
    accessRole: row.role,
  };
}

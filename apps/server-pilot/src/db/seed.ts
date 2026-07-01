/**
 * Pilot seed logic (pure DB operations, no Secrets Manager).
 *
 * Exported so `scripts/seed-prod.ts` (production runner) and
 * `tests/seed-contract.test.ts` (transaction-rollback verification) can both
 * call it against the same DB handle.
 */
import { count } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { account, user as userTable } from './schema/auth.js';
import {
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
} from './schema/mail.js';
import type { DB } from './client.js';

export type PilotUserSpec = {
  id: string;
  name: string;
  email: string;
};

export const PILOT_USERS: PilotUserSpec[] = [
  { id: 'user-manager', name: 'Centurion Manager', email: 'manager@legacyhotel.com' },
  { id: 'user-centurion-worker', name: 'Centurion Worker', email: 'worker@legacyhotel.com' },
  { id: 'user-admin', name: 'Pilot Admin', email: 'admin@legacyhotel.com' },
];

export const INGEST_EMAIL = 'nava@legacyhotel.com';
export const INGEST_MAILBOX_ID = 'ingest-nava-legacy';
export const TRANSPORT_ID = 'transport-centurion';
export const TRANSPORT_EMAIL = 'centurion@legacyhotel.com';
export const TRANSPORT_OWNER_HEADER = 'centurion@legacyhotel.com';

export const ACCESS_ROWS: { userId: string; role: 'owner' | 'member' | 'admin' }[] = [
  { userId: 'user-manager', role: 'owner' },
  { userId: 'user-centurion-worker', role: 'member' },
  { userId: 'user-admin', role: 'admin' },
];

export type SeedResult = {
  pilotCredentials: Record<string, { password: string }>;
  transportCount: number;
  accessCount: number;
};

/**
 * Seed all pilot rows against the given DB handle.
 *
 * Idempotent: re-running upserts rows. The DB handle may be a normal
 * connection (production) or a transaction-scoped handle (tests with
 * rollback).
 */
export async function seedAll(db: DB): Promise<SeedResult> {
  // 1. Ingest mailbox
  await db
    .insert(mailIngestMailbox)
    .values({
      id: INGEST_MAILBOX_ID,
      email: INGEST_EMAIL,
      description: 'NAVA aggregate ingest (legacyhotel.com)',
      isActive: true,
    })
    .onConflictDoNothing({ target: mailIngestMailbox.email });

  // 2. Transport (mailboxType personal per Task 4 design note)
  await db
    .insert(mailboxTransport)
    .values({
      id: TRANSPORT_ID,
      email: TRANSPORT_EMAIL,
      ownerHeaderValue: TRANSPORT_OWNER_HEADER,
      mailboxType: 'personal',
      displayName: 'Centurion Transport',
      isActive: true,
    })
    .onConflictDoUpdate({
      target: mailboxTransport.ownerHeaderValue,
      set: {
        email: TRANSPORT_EMAIL,
        mailboxType: 'personal',
        displayName: 'Centurion Transport',
        isActive: true,
        updatedAt: new Date(),
      },
    });

  // 3. Pilot users + credential accounts (rotate passwords)
  const pilotCredentials: Record<string, { password: string }> = {};
  for (const spec of PILOT_USERS) {
    const password = randomBytes(18).toString('base64url');
    const hashed = await hashPassword(password);

    await db
      .insert(userTable)
      .values({
        id: spec.id,
        name: spec.name,
        email: spec.email,
        emailVerified: true,
      })
      .onConflictDoUpdate({
        target: userTable.email,
        set: {
          name: spec.name,
          emailVerified: true,
          updatedAt: new Date(),
        },
      });

    const accountId = `cred-${spec.id}`;
    await db
      .insert(account)
      .values({
        id: accountId,
        userId: spec.id,
        accountId: spec.id,
        providerId: 'credential',
        password: hashed,
      })
      .onConflictDoUpdate({
        target: account.id,
        set: { password: hashed, updatedAt: new Date() },
      });

    pilotCredentials[spec.email] = { password };
  }

  // 4. Mailbox access rows
  for (const row of ACCESS_ROWS) {
    await db
      .insert(mailboxAccess)
      .values({
        id: `access-${row.userId}-${TRANSPORT_ID}`,
        userId: row.userId,
        transportId: TRANSPORT_ID,
        role: row.role,
      })
      .onConflictDoUpdate({
        target: [mailboxAccess.userId, mailboxAccess.transportId],
        set: { role: row.role, updatedAt: new Date() },
      });
  }

  // 5. Counts for summary
  const transportRows = await db
    .select({ id: mailboxTransport.id, email: mailboxTransport.email })
    .from(mailboxTransport);
  const accessCountRow = await db
    .select({ n: count() })
    .from(mailboxAccess);

  return {
    pilotCredentials,
    transportCount: transportRows.length,
    accessCount: Number(accessCountRow[0]?.n ?? 0),
  };
}

/**
 * Pilot seed logic (pure DB operations, no Secrets Manager).
 *
 * Exported so `scripts/seed-prod.ts` (production runner) and
 * `tests/seed-contract.test.ts` (transaction-rollback verification) can both
 * call it against the same DB handle.
 */
import { count, eq } from 'drizzle-orm';
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

export type SeedOptions = {
  /** When true, rotate passwords for all pilot users. Default false. */
  rotatePasswords?: boolean;
  /** Pre-generated plaintext passwords (from planPilotCredentials). */
  precomputedCredentials?: Record<string, { password: string }>;
};

function credentialAccountId(specId: string): string {
  return `cred-${specId}`;
}

/**
 * Determine which pilot users need new passwords before any DB writes.
 * Used by seed-prod to persist Secrets Manager values before seedAll.
 */
export async function planPilotCredentials(
  db: DB,
  opts: SeedOptions = {},
): Promise<Record<string, { password: string }>> {
  const rotatePasswords = opts.rotatePasswords ?? false;
  const pilotCredentials: Record<string, { password: string }> = {};

  for (const spec of PILOT_USERS) {
    const existing = await db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.id, credentialAccountId(spec.id)))
      .limit(1);

    if (rotatePasswords || existing.length === 0) {
      pilotCredentials[spec.email] = {
        password: randomBytes(18).toString('base64url'),
      };
    }
  }

  return pilotCredentials;
}

/**
 * Seed all pilot rows against the given DB handle.
 *
 * Idempotent: re-running upserts rows. The DB handle may be a normal
 * connection (production) or a transaction-scoped handle (tests with
 * rollback).
 */
export async function seedAll(db: DB, opts: SeedOptions = {}): Promise<SeedResult> {
  const rotatePasswords = opts.rotatePasswords ?? false;
  const precomputed = opts.precomputedCredentials ?? {};

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

  // 3. Pilot users + credential accounts (rotate only when requested or missing)
  const pilotCredentials: Record<string, { password: string }> = {};

  await db.transaction(async (tx) => {
    for (const spec of PILOT_USERS) {
      const accountId = credentialAccountId(spec.id);
      const existingAccount = await tx
        .select({ id: account.id })
        .from(account)
        .where(eq(account.id, accountId))
        .limit(1);

      const shouldRotate = rotatePasswords || existingAccount.length === 0;
      let password: string | undefined;
      let hashed: string | undefined;

      if (shouldRotate) {
        password =
          precomputed[spec.email]?.password ?? randomBytes(18).toString('base64url');
        hashed = await hashPassword(password);
        pilotCredentials[spec.email] = { password };
      }

      await tx
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

      const userRow = await tx
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.email, spec.email))
        .limit(1);
      const actualUserId = userRow[0]?.id;
      if (!actualUserId) {
        throw new Error(`seed failed: user row missing for ${spec.email}`);
      }

      if (shouldRotate && hashed) {
        await tx
          .insert(account)
          .values({
            id: accountId,
            userId: actualUserId,
            accountId: actualUserId,
            providerId: 'credential',
            password: hashed,
          })
          .onConflictDoUpdate({
            target: account.id,
            set: {
              password: hashed,
              userId: actualUserId,
              accountId: actualUserId,
              updatedAt: new Date(),
            },
          });
      }
    }
  });

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

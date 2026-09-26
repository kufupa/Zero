/**
 * Pilot seed logic (pure DB operations, no Secrets Manager).
 *
 * Exported so `scripts/seed-prod.ts` (production runner) and
 * `tests/seed-contract.test.ts` (transaction-rollback verification) can both
 * call it against the same DB handle.
 */
import { count, eq, inArray, notInArray } from 'drizzle-orm';
import { AI_MANAGED_CATEGORY_SEED_ROWS } from '../ai/categories.js';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { account, remoteSession, session, user as userTable } from './schema/auth.js';
import {
  mailCategory,
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
  mailLabel,
} from './schema/mail.js';
import type { DB } from './client.js';

export type PilotUserSpec = {
  id: string;
  name: string;
  email: string;
};

export const NAVA_TRANSPORT_ID = 'transport-nava';
export const NAVA_TRANSPORT_EMAIL = 'navaai@legacyhotels.co.za';
export const NAVA_USER_ID = 'user-navaai';
export const NAVA_USER_EMAIL = 'navaai@legacyhotels.co.za';

export const CENTURION_USER_ID = 'user-centurion';
export const CENTURION_USER_EMAIL = 'centurion@legacyhotels.co.za';

/** Separate Centurion mailbox login for audit (not the shared reservation persona). */
export const MARTHA_USER_ID = 'user-martha';
export const MARTHA_USER_EMAIL = 'marthamthembu@legacyhotels.co.za';

/** Centurion hotel IT login (Centurion mailbox + admin dashboard allowlist). */
export const ROPPERMAN_USER_ID = 'user-ropperman';
export const ROPPERMAN_USER_EMAIL = 'ropperman@legacyhotels.co.za';

/** Centurion hotel operations login (Centurion mailbox + admin dashboard allowlist). */
export const DARREN_USER_ID = 'user-darren-bezuidenhout';
export const DARREN_USER_EMAIL = 'dbezuidenhout@legacyhotels.co.za';

/** Centurion reservations login for the cross-user quote PDF pilot. */
export const KAMALA_USER_ID = 'user-kamala';
export const KAMALA_USER_EMAIL = 'kdouglas@legacyhotels.co.za';

export const PILOT_USERS: PilotUserSpec[] = [
  { id: NAVA_USER_ID, name: 'Nava AI', email: NAVA_USER_EMAIL },
  { id: CENTURION_USER_ID, name: 'Centurion', email: CENTURION_USER_EMAIL },
  { id: MARTHA_USER_ID, name: 'Martha Mthembu', email: MARTHA_USER_EMAIL },
  { id: ROPPERMAN_USER_ID, name: 'R Opperman', email: ROPPERMAN_USER_EMAIL },
  { id: DARREN_USER_ID, name: 'Darren Bezuidenhout', email: DARREN_USER_EMAIL },
  { id: KAMALA_USER_ID, name: 'Kamala Douglas', email: KAMALA_USER_EMAIL },
];

export const INGEST_EMAIL = 'navaai@legacyhotels.co.za';
export const INGEST_MAILBOX_ID = 'ingest-nava-legacy';
export const TRANSPORT_ID = 'transport-centurion';
export const TRANSPORT_EMAIL = 'centurion@legacyhotels.co.za';
export const TRANSPORT_OWNER_HEADER = 'centurion@legacyhotels.co.za';
export const CENTURION_TRANSPORT_DISPLAY_NAME = 'Centurion Hotel Reservations';
export const TRANSPORT_ALIASES = [
  'centurion@legacyhotels.com',
  'centurion@legacyhotel.com',
] as const;

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

function pilotUserIds(): string[] {
  return PILOT_USERS.map((u) => u.id);
}

/** Nava owns every active transport; Centurion-scoped staff own Centurion only. */
export async function applyPilotMailboxAccess(db: DB): Promise<void> {
  const keepIds = pilotUserIds();
  await db.delete(mailboxAccess).where(inArray(mailboxAccess.userId, keepIds));

  const active = await db
    .select({ id: mailboxTransport.id })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  for (const transport of active) {
    await db.insert(mailboxAccess).values({
      id: `access-${NAVA_USER_ID}-${transport.id}`,
      userId: NAVA_USER_ID,
      transportId: transport.id,
      role: 'owner',
      isDefault: transport.id === NAVA_TRANSPORT_ID,
    });
  }

  for (const userId of [
    CENTURION_USER_ID,
    MARTHA_USER_ID,
    ROPPERMAN_USER_ID,
    DARREN_USER_ID,
    KAMALA_USER_ID,
  ]) {
    await db.insert(mailboxAccess).values({
      id: `access-${userId}-${TRANSPORT_ID}`,
      userId,
      transportId: TRANSPORT_ID,
      role: 'owner',
      isDefault: true,
    });
  }
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
 * rollback). Prunes auth users not in PILOT_USERS; mailbox_access for
 * pilot users is rebuilt by applyPilotMailboxAccess.
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
      description: 'NAVA aggregate ingest (legacyhotels.co.za)',
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
      displayName: CENTURION_TRANSPORT_DISPLAY_NAME,
      isActive: true,
      sendFromConfig: { aliases: [...TRANSPORT_ALIASES] },
    })
    .onConflictDoUpdate({
      target: mailboxTransport.id,
      set: {
        email: TRANSPORT_EMAIL,
        ownerHeaderValue: TRANSPORT_OWNER_HEADER,
        mailboxType: 'personal',
        displayName: CENTURION_TRANSPORT_DISPLAY_NAME,
        isActive: true,
        sendFromConfig: { aliases: [...TRANSPORT_ALIASES] },
        updatedAt: new Date(),
      },
    });

  await db
    .insert(mailboxTransport)
    .values({
      id: NAVA_TRANSPORT_ID,
      email: NAVA_TRANSPORT_EMAIL,
      ownerHeaderValue: NAVA_TRANSPORT_EMAIL,
      mailboxType: 'personal',
      displayName: 'Nava AI Transport',
      isActive: true,
    })
    .onConflictDoUpdate({
      target: mailboxTransport.ownerHeaderValue,
      set: {
        email: NAVA_TRANSPORT_EMAIL,
        mailboxType: 'personal',
        displayName: 'Nava AI Transport',
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

      if (shouldRotate) {
        await tx.delete(session).where(eq(session.userId, actualUserId));
        await tx.delete(remoteSession).where(eq(remoteSession.userId, actualUserId));

        const password =
          precomputed[spec.email]?.password ?? randomBytes(18).toString('base64url');
        const hashed = await hashPassword(password);
        pilotCredentials[spec.email] = { password };

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

  // 3b. Drop non-pilot auth users (cascades session/account/mailbox_access)
  const keepIds = pilotUserIds();
  await db.delete(userTable).where(notInArray(userTable.id, keepIds));
  await applyPilotMailboxAccess(db);

  await seedSpamLabel(db, TRANSPORT_ID);
  await seedSpamLabel(db, NAVA_TRANSPORT_ID);

  const activeTransportRows = await db
    .select({ id: mailboxTransport.id })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  for (const transport of activeTransportRows) {
    await seedAiManagedCategories(db, transport.id);
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

async function seedAiManagedCategories(db: DB, transportId: string): Promise<void> {
  for (const row of AI_MANAGED_CATEGORY_SEED_ROWS) {
    await db
      .insert(mailCategory)
      .values({
        id: `category-${transportId}-${row.slug}`,
        transportId,
        slug: row.slug,
        name: row.name,
        color: row.color,
        sortOrder: row.sortOrder,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [mailCategory.transportId, mailCategory.slug],
        set: {
          name: row.name,
          color: row.color,
          sortOrder: row.sortOrder,
          isActive: true,
          updatedAt: new Date(),
        },
      });
  }
}

async function seedSpamLabel(db: DB, transportId: string): Promise<void> {
  await db
    .insert(mailLabel)
    .values({
      id: `label-spam-${transportId}`,
      transportId,
      name: 'SPAM',
      color: null,
    })
    .onConflictDoNothing({ target: [mailLabel.transportId, mailLabel.name] });
}

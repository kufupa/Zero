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
import { DAVINCI_MAILBOX_IDENTITIES } from '../hms/mailbox-hms-origin-bind.js';

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

export const DAVINCI_TRANSPORT_ID = 'transport-davinci';
export const DAVINCI_TRANSPORT_EMAIL = DAVINCI_MAILBOX_IDENTITIES[0];
export const DAVINCI_TRANSPORT_OWNER_HEADER = DAVINCI_MAILBOX_IDENTITIES[0];
export const DAVINCI_TRANSPORT_DISPLAY_NAME = 'Da Vinci Hotel Reservations';
export const DAVINCI_TRANSPORT_ALIASES = DAVINCI_MAILBOX_IDENTITIES.slice(1);

/** Faith hotel mailbox + documented domain spellings. Not HMS origin; not TRANSPORT_ALIASES. */
export const FAITH_MAILBOX_IDENTITIES = [
  'fkhumalo@legacyhotels.co.za',
  'fkhumalo@legacyhotels.com',
  'fkhumalo@legacyhotel.com',
] as const;
export const FAITH_TRANSPORT_ID = 'transport-faith';
export const FAITH_TRANSPORT_EMAIL = FAITH_MAILBOX_IDENTITIES[0];
export const FAITH_TRANSPORT_OWNER_HEADER = FAITH_MAILBOX_IDENTITIES[0];
export const FAITH_TRANSPORT_DISPLAY_NAME = 'Faith Hotel Reservations';
export const FAITH_TRANSPORT_ALIASES = FAITH_MAILBOX_IDENTITIES.slice(1);

/** Ayanda hotel mailbox (adladla) + documented domain spellings. Not HMS origin; not TRANSPORT_ALIASES. */
export const AYANDA_MAILBOX_IDENTITIES = [
  'adladla@legacyhotels.co.za',
  'adladla@legacyhotels.com',
  'adladla@legacyhotel.com',
] as const;
export const AYANDA_TRANSPORT_ID = 'transport-ayanda';
export const AYANDA_TRANSPORT_EMAIL = AYANDA_MAILBOX_IDENTITIES[0];
export const AYANDA_TRANSPORT_OWNER_HEADER = AYANDA_MAILBOX_IDENTITIES[0];
export const AYANDA_TRANSPORT_DISPLAY_NAME = 'Ayanda Hotel Reservations';
export const AYANDA_TRANSPORT_ALIASES = AYANDA_MAILBOX_IDENTITIES.slice(1);

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

export function credentialAccountId(specId: string): string {
  return `cred-${specId}`;
}

async function upsertHotelMailboxTransport(
  db: DB,
  spec: {
    id: string;
    email: string;
    ownerHeaderValue: string;
    displayName: string;
    aliases: readonly string[];
  },
): Promise<void> {
  await db
    .insert(mailboxTransport)
    .values({
      id: spec.id,
      email: spec.email,
      ownerHeaderValue: spec.ownerHeaderValue,
      mailboxType: 'personal',
      displayName: spec.displayName,
      isActive: true,
      sendFromConfig: { aliases: [...spec.aliases] },
    })
    .onConflictDoUpdate({
      target: mailboxTransport.id,
      set: {
        email: spec.email,
        ownerHeaderValue: spec.ownerHeaderValue,
        mailboxType: 'personal',
        displayName: spec.displayName,
        isActive: true,
        sendFromConfig: { aliases: [...spec.aliases] },
        updatedAt: new Date(),
      },
    });
}

function pilotUserIds(): string[] {
  return PILOT_USERS.map((u) => u.id);
}

type PilotMailboxAccessRow = {
  userId: string;
  transportId: string;
  role: 'owner';
  isDefault: boolean;
};

/** Deliberate pilot mailbox grants; new transports grant nobody until listed here. */
export const PILOT_MAILBOX_ACCESS_ROWS: readonly PilotMailboxAccessRow[] = [
  { userId: NAVA_USER_ID, transportId: NAVA_TRANSPORT_ID, role: 'owner', isDefault: true },
  { userId: NAVA_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: false },
  { userId: CENTURION_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: true },
  { userId: MARTHA_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: true },
  { userId: ROPPERMAN_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: true },
  { userId: DARREN_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: true },
  { userId: KAMALA_USER_ID, transportId: TRANSPORT_ID, role: 'owner', isDefault: true },
];

export async function applyPilotMailboxAccess(db: DB): Promise<void> {
  const keepIds = pilotUserIds();
  await db.delete(mailboxAccess).where(inArray(mailboxAccess.userId, keepIds));

  for (const row of PILOT_MAILBOX_ACCESS_ROWS) {
    await db.insert(mailboxAccess).values({
      id: `access-${row.userId}-${row.transportId}`,
      userId: row.userId,
      transportId: row.transportId,
      role: row.role,
      isDefault: row.isDefault,
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
 * NEVER run on prod; use provision:prod (additive, never prunes).
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

  await upsertHotelMailboxTransport(db, {
    id: DAVINCI_TRANSPORT_ID,
    email: DAVINCI_TRANSPORT_EMAIL,
    ownerHeaderValue: DAVINCI_TRANSPORT_OWNER_HEADER,
    displayName: DAVINCI_TRANSPORT_DISPLAY_NAME,
    aliases: DAVINCI_TRANSPORT_ALIASES,
  });
  await upsertHotelMailboxTransport(db, {
    id: FAITH_TRANSPORT_ID,
    email: FAITH_TRANSPORT_EMAIL,
    ownerHeaderValue: FAITH_TRANSPORT_OWNER_HEADER,
    displayName: FAITH_TRANSPORT_DISPLAY_NAME,
    aliases: FAITH_TRANSPORT_ALIASES,
  });
  await upsertHotelMailboxTransport(db, {
    id: AYANDA_TRANSPORT_ID,
    email: AYANDA_TRANSPORT_EMAIL,
    ownerHeaderValue: AYANDA_TRANSPORT_OWNER_HEADER,
    displayName: AYANDA_TRANSPORT_DISPLAY_NAME,
    aliases: AYANDA_TRANSPORT_ALIASES,
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
  await seedSpamLabel(db, DAVINCI_TRANSPORT_ID);
  await seedSpamLabel(db, FAITH_TRANSPORT_ID);
  await seedSpamLabel(db, AYANDA_TRANSPORT_ID);
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

export async function seedAiManagedCategories(
  db: DB,
  transportId: string,
  opts?: { onConflict?: 'update' | 'nothing' },
): Promise<void> {
  const onConflict = opts?.onConflict ?? 'update';
  for (const row of AI_MANAGED_CATEGORY_SEED_ROWS) {
    const values = {
      id: `category-${transportId}-${row.slug}`,
      transportId,
      slug: row.slug,
      name: row.name,
      color: row.color,
      sortOrder: row.sortOrder,
      isActive: true,
    };
    if (onConflict === 'nothing') {
      await db
        .insert(mailCategory)
        .values(values)
        .onConflictDoNothing({ target: [mailCategory.transportId, mailCategory.slug] });
      continue;
    }
    await db
      .insert(mailCategory)
      .values(values)
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

export async function seedSpamLabel(db: DB, transportId: string): Promise<void> {
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

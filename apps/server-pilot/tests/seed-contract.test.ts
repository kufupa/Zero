import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailCategory,
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
  mailLabel,
} from '../src/db/schema/mail';
import { AI_MANAGED_CATEGORY_SLUGS } from '../src/ai/categories.js';
import { user as userTable, account } from '../src/db/schema/auth';
import {
  planPilotCredentials,
  seedAll,
  PILOT_USERS,
  NAVA_TRANSPORT_EMAIL,
  INGEST_EMAIL,
  TRANSPORT_EMAIL,
  NAVA_OPS_USER_EMAIL,
} from '../src/db/seed';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
  withTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

describe('seed identity constants', () => {
  it('uses navaai@legacyhotels.co.za for ingest + Nava transport', () => {
    expect(INGEST_EMAIL).toBe('navaai@legacyhotels.co.za');
    expect(NAVA_TRANSPORT_EMAIL).toBe('navaai@legacyhotels.co.za');
  });

  it('keeps Centurion + ops on legacyhotel.com', () => {
    expect(TRANSPORT_EMAIL).toBe('centurion@legacyhotel.com');
    expect(NAVA_OPS_USER_EMAIL).toBe('nava-ops@legacyhotel.com');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'seed contract (transaction-rollback)',
  () => {
    it(
      'seeds navaai@legacyhotels.co.za ingest mailbox',
      async () => {
        const ingest = await withSeededTestDb(async (db) => {
          const rows = await db
            .select()
            .from(mailIngestMailbox)
            .where(eq(mailIngestMailbox.email, 'navaai@legacyhotels.co.za'));
          return rows[0];
        });
        expect(ingest).toBeDefined();
        expect(ingest!.email).toBe('navaai@legacyhotels.co.za');
        expect(ingest!.description).toBe('NAVA aggregate ingest (legacyhotels.co.za)');
        expect(ingest!.isActive).toBe(true);
      },
      30000,
    );

    it(
      'seeds transport-centurion with personal mailboxType and centurion owner header',
      async () => {
        const transport = await withSeededTestDb(async (db) => {
          const rows = await db
            .select()
            .from(mailboxTransport)
            .where(eq(mailboxTransport.ownerHeaderValue, 'centurion@legacyhotel.com'));
          return rows[0];
        });
        expect(transport).toBeDefined();
        expect(transport!.id).toBe('transport-centurion');
        expect(transport!.email).toBe('centurion@legacyhotel.com');
        expect(transport!.mailboxType).toBe('personal');
        expect(transport!.isActive).toBe(true);
      },
      30000,
    );

    it(
      'seeds transport-nava and nava-ops with access only to Nava',
      async () => {
        const result = await withSeededTestDb(async (db) => {
          const transports = await db
            .select()
            .from(mailboxTransport)
            .where(eq(mailboxTransport.id, 'transport-nava'));
          const access = await db
            .select({
              userId: mailboxAccess.userId,
              transportId: mailboxAccess.transportId,
              role: mailboxAccess.role,
              isDefault: mailboxAccess.isDefault,
            })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, 'user-nava'));
          return { transport: transports[0], access };
        });

        expect(result.transport).toBeDefined();
        expect(result.transport!.email).toBe('navaai@legacyhotels.co.za');
        expect(result.transport!.ownerHeaderValue).toBe('navaai@legacyhotels.co.za');
        expect(result.access).toEqual([
          {
            userId: 'user-nava',
            transportId: 'transport-nava',
            role: 'owner',
            isDefault: true,
          },
        ]);
      },
      30000,
    );

    it(
      'seeds SPAM labels for Centurion and Nava transports',
      async () => {
        const labels = await withSeededTestDb(async (db) =>
          db
            .select({
              id: mailLabel.id,
              transportId: mailLabel.transportId,
              name: mailLabel.name,
            })
            .from(mailLabel),
        );

        expect(labels).toContainEqual({
          id: 'label-spam-transport-centurion',
          transportId: 'transport-centurion',
          name: 'SPAM',
        });
        expect(labels).toContainEqual({
          id: 'label-spam-transport-nava',
          transportId: 'transport-nava',
          name: 'SPAM',
        });
      },
      30000,
    );

    it(
      'seeds exactly 3 mailbox_access rows on transport-centurion with correct roles',
      async () => {
        const access = await withSeededTestDb(async (db) => {
          return db
            .select({
              userId: mailboxAccess.userId,
              role: mailboxAccess.role,
            })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.transportId, 'transport-centurion'));
        });
        expect(access).toHaveLength(3);
        const byUser = Object.fromEntries(access.map((r) => [r.userId, r.role]));
        expect(byUser['user-manager']).toBe('owner');
        expect(byUser['user-centurion-worker']).toBe('member');
        expect(byUser['user-admin']).toBe('admin');
      },
      30000,
    );

    it(
      'seeds four pilot users with emailVerified=true',
      async () => {
        const users = await withSeededTestDb(async (db) => {
          return db
            .select({ id: userTable.id, email: userTable.email, emailVerified: userTable.emailVerified })
            .from(userTable);
        });
        const byId = Object.fromEntries(users.map((u) => [u.id, u]));
        expect(byId['user-manager']?.email).toBe('manager@legacyhotel.com');
        expect(byId['user-manager']?.emailVerified).toBe(true);
        expect(byId['user-centurion-worker']?.email).toBe('worker@legacyhotel.com');
        expect(byId['user-admin']?.email).toBe('admin@legacyhotel.com');
        expect(byId['user-nava']?.email).toBe('nava-ops@legacyhotel.com');
        expect(byId['user-nava']?.emailVerified).toBe(true);
      },
      30000,
    );

    it(
      'seeds credential accounts for each PILOT_USERS email with hashed passwords',
      async () => {
        const accounts = await withSeededTestDb(async (db) => {
          return db
            .select({
              id: account.id,
              userId: account.userId,
              providerId: account.providerId,
              password: account.password,
            })
            .from(account)
            .where(eq(account.providerId, 'credential'));
        });
        const pilotUserIds = new Set(PILOT_USERS.map((u) => u.id));
        const pilotAccounts = accounts.filter((a) => pilotUserIds.has(a.userId));
        expect(pilotAccounts).toHaveLength(PILOT_USERS.length);
        for (const a of pilotAccounts) {
          expect(a.password).toBeTruthy();
          expect(a.password).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
        }
      },
      30000,
    );

    it(
      'planPilotCredentials returns empty when accounts exist and rotatePasswords is false',
      async () => {
        const planned = await withSeededTestDb(async (db) => {
          return planPilotCredentials(db, { rotatePasswords: false });
        });
        expect(Object.keys(planned)).toHaveLength(0);
      },
      30000,
    );

    it(
      'seeds AI-managed categories for each active transport',
      async () => {
        const categories = await withSeededTestDb(async (db) =>
          db
            .select({
              transportId: mailCategory.transportId,
              slug: mailCategory.slug,
            })
            .from(mailCategory),
        );

        for (const transportId of ['transport-centurion', 'transport-nava']) {
          for (const slug of AI_MANAGED_CATEGORY_SLUGS) {
            expect(categories).toContainEqual({ transportId, slug });
          }
        }
      },
      30000,
    );

    it(
      're-seeding without rotatePasswords does not change credential password hashes',
      async () => {
        const beforeAfter = await withTestDb(async (db) => {
          await seedAll(db);
          const before = await db
            .select({ id: account.id, password: account.password })
            .from(account)
            .where(eq(account.providerId, 'credential'));
          await seedAll(db, { rotatePasswords: false });
          const after = await db
            .select({ id: account.id, password: account.password })
            .from(account)
            .where(eq(account.providerId, 'credential'));
          return { before, after };
        });
        const beforeById = Object.fromEntries(
          beforeAfter.before.map((row) => [row.id, row.password]),
        );
        for (const row of beforeAfter.after) {
          expect(row.password).toBe(beforeById[row.id]);
        }
      },
      30000,
    );
  },
);

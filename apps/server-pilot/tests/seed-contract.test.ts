import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
} from '../src/db/schema/mail';
import { user as userTable, account } from '../src/db/schema/auth';
import { planPilotCredentials, seedAll, PILOT_USERS } from '../src/db/seed';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
  withTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'seed contract (transaction-rollback)',
  () => {
    it(
      'seeds nava@legacyhotel.com ingest mailbox',
      async () => {
        const ingest = await withSeededTestDb(async (db) => {
          const rows = await db
            .select()
            .from(mailIngestMailbox)
            .where(eq(mailIngestMailbox.email, 'nava@legacyhotel.com'));
          return rows[0];
        });
        expect(ingest).toBeDefined();
        expect(ingest!.email).toBe('nava@legacyhotel.com');
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
      'seeds the three pilot users with emailVerified=true',
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

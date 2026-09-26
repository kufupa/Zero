import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  mailCategory,
  mailIngestMailbox,
  mailboxAccess,
  mailboxTransport,
  mailLabel,
} from '../src/db/schema/mail';
import { AI_MANAGED_CATEGORY_SLUGS, AI_WORKFLOW_PRIMARY_SLUGS } from '../src/ai/categories.js';
import { user as userTable, account } from '../src/db/schema/auth';
import {
  planPilotCredentials,
  seedAll,
  PILOT_USERS,
  NAVA_TRANSPORT_EMAIL,
  NAVA_USER_EMAIL,
  NAVA_USER_ID,
  CENTURION_USER_EMAIL,
  CENTURION_USER_ID,
  MARTHA_USER_EMAIL,
  MARTHA_USER_ID,
  ROPPERMAN_USER_EMAIL,
  ROPPERMAN_USER_ID,
  DARREN_USER_EMAIL,
  DARREN_USER_ID,
  KAMALA_USER_EMAIL,
  KAMALA_USER_ID,
  INGEST_EMAIL,
  TRANSPORT_EMAIL,
  TRANSPORT_OWNER_HEADER,
  TRANSPORT_ALIASES,
} from '../src/db/seed';
import * as pilotSeed from '../src/db/seed';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
  withTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

describe('seed identity constants', () => {
  it('uses navaai@legacyhotels.co.za for ingest + Nava transport + app login', () => {
    expect(INGEST_EMAIL).toBe('navaai@legacyhotels.co.za');
    expect(NAVA_TRANSPORT_EMAIL).toBe('navaai@legacyhotels.co.za');
    expect(NAVA_USER_EMAIL).toBe('navaai@legacyhotels.co.za');
    expect(PILOT_USERS).toEqual([
      { id: NAVA_USER_ID, name: 'Nava AI', email: NAVA_USER_EMAIL },
      { id: CENTURION_USER_ID, name: 'Centurion', email: CENTURION_USER_EMAIL },
      { id: MARTHA_USER_ID, name: 'Martha Mthembu', email: MARTHA_USER_EMAIL },
      { id: ROPPERMAN_USER_ID, name: 'R Opperman', email: ROPPERMAN_USER_EMAIL },
      { id: DARREN_USER_ID, name: 'Darren Bezuidenhout', email: DARREN_USER_EMAIL },
      { id: KAMALA_USER_ID, name: 'Kamala Douglas', email: KAMALA_USER_EMAIL },
    ]);
  });

  it('exports Centurion Hotel Reservations transport label', () => {
    expect(pilotSeed.CENTURION_TRANSPORT_DISPLAY_NAME).toBe(
      'Centurion Hotel Reservations',
    );
  });

  it('uses centurion@legacyhotels.co.za as live Centurion primary', () => {
    expect(TRANSPORT_EMAIL).toBe('centurion@legacyhotels.co.za');
    expect(TRANSPORT_OWNER_HEADER).toBe('centurion@legacyhotels.co.za');
    expect(TRANSPORT_ALIASES).toEqual([
      'centurion@legacyhotels.com',
      'centurion@legacyhotel.com',
    ]);
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
      'seeds transport-centurion with live primary email, owner header, and aliases',
      async () => {
        const transport = await withSeededTestDb(async (db) => {
          const rows = await db
            .select()
            .from(mailboxTransport)
            .where(eq(mailboxTransport.id, 'transport-centurion'));
          return rows[0];
        });
        expect(transport).toBeDefined();
        expect(transport!.id).toBe('transport-centurion');
        expect(transport!.displayName).toBe('Centurion Hotel Reservations');
        expect(transport!.email).toBe('centurion@legacyhotels.co.za');
        expect(transport!.ownerHeaderValue).toBe('centurion@legacyhotels.co.za');
        expect(transport!.mailboxType).toBe('personal');
        expect(transport!.isActive).toBe(true);
        expect(transport!.sendFromConfig).toEqual({
          aliases: ['centurion@legacyhotels.com', 'centurion@legacyhotel.com'],
        });
      },
      30000,
    );

    it(
      'upserts Centurion transport by id when owner_header_value was legacy',
      async () => {
        const transport = await withTestDb(async (db) => {
          await db.insert(mailboxTransport).values({
            id: 'transport-centurion',
            email: 'centurion@legacyhotel.com',
            ownerHeaderValue: 'centurion@legacyhotel.com',
            mailboxType: 'personal',
            displayName: 'Centurion Transport',
            isActive: true,
            sendFromConfig: { aliases: [] },
          });
          await seedAll(db, { rotatePasswords: false });
          const rows = await db
            .select()
            .from(mailboxTransport)
            .where(eq(mailboxTransport.id, 'transport-centurion'));
          return rows[0];
        });
        expect(transport).toBeDefined();
        expect(transport!.email).toBe('centurion@legacyhotels.co.za');
        expect(transport!.ownerHeaderValue).toBe('centurion@legacyhotels.co.za');
        expect(transport!.displayName).toBe('Centurion Hotel Reservations');
        expect(transport!.sendFromConfig).toEqual({
          aliases: ['centurion@legacyhotels.com', 'centurion@legacyhotel.com'],
        });
      },
      30000,
    );

    it(
        'seeds Nava owner on every active transport; Centurion-scoped staff own Centurion only',
      async () => {
        const result = await withSeededTestDb(async (db) => {
          const active = await db
            .select({ id: mailboxTransport.id })
            .from(mailboxTransport)
            .where(eq(mailboxTransport.isActive, true));
          const access = await db
            .select({
              userId: mailboxAccess.userId,
              transportId: mailboxAccess.transportId,
              role: mailboxAccess.role,
              isDefault: mailboxAccess.isDefault,
            })
            .from(mailboxAccess);
          return { activeIds: active.map((r) => r.id).sort(), access };
        });

        const navaRows = result.access.filter((r) => r.userId === NAVA_USER_ID);
        expect(navaRows).toHaveLength(result.activeIds.length);
        expect(navaRows.map((r) => r.transportId).sort()).toEqual(result.activeIds);
        expect(navaRows.every((r) => r.role === 'owner')).toBe(true);
        expect(navaRows.find((r) => r.transportId === 'transport-nava')?.isDefault).toBe(true);
        expect(navaRows.filter((r) => r.isDefault)).toHaveLength(1);

        for (const userId of [
          CENTURION_USER_ID,
          MARTHA_USER_ID,
          ROPPERMAN_USER_ID,
          DARREN_USER_ID,
          KAMALA_USER_ID,
        ]) {
          const rows = result.access.filter((r) => r.userId === userId);
          expect(rows).toEqual([
            {
              userId,
              transportId: 'transport-centurion',
              role: 'owner',
              isDefault: true,
            },
          ]);
        }
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
      'transport-centurion has Nava + Centurion + Martha + Ropperman + Darren + Kamala owner rows',
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
        expect(access).toHaveLength(6);
        expect(access).toEqual(
          expect.arrayContaining([
            { userId: NAVA_USER_ID, role: 'owner' },
            { userId: CENTURION_USER_ID, role: 'owner' },
            { userId: MARTHA_USER_ID, role: 'owner' },
            { userId: ROPPERMAN_USER_ID, role: 'owner' },
            { userId: DARREN_USER_ID, role: 'owner' },
            { userId: KAMALA_USER_ID, role: 'owner' },
          ]),
        );
      },
      30000,
    );

    it(
      'applyPilotMailboxAccess grants Nava a new active transport without static ACCESS_ROWS edit',
      async () => {
        const { applyPilotMailboxAccess } = await import('../src/db/seed.js');
        const outcome = await withSeededTestDb(async (db) => {
          await db.insert(mailboxTransport).values({
            id: 'transport-davinci',
            email: 'davinci@legacyhotels.co.za',
            ownerHeaderValue: 'davinci@legacyhotels.co.za',
            mailboxType: 'personal',
            displayName: 'Da Vinci Transport',
            isActive: true,
          });
          await applyPilotMailboxAccess(db);
          const nava = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, NAVA_USER_ID));
          const cen = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, CENTURION_USER_ID));
          const martha = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, MARTHA_USER_ID));
          const ropperman = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, ROPPERMAN_USER_ID));
          const darren = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, DARREN_USER_ID));
          const kamala = await db
            .select({ transportId: mailboxAccess.transportId })
            .from(mailboxAccess)
            .where(eq(mailboxAccess.userId, KAMALA_USER_ID));
          return {
            navaIds: nava.map((r) => r.transportId).sort(),
            cenIds: cen.map((r) => r.transportId),
            marthaIds: martha.map((r) => r.transportId),
            roppermanIds: ropperman.map((r) => r.transportId),
            darrenIds: darren.map((r) => r.transportId),
            kamalaIds: kamala.map((r) => r.transportId),
          };
        });
        expect(outcome.navaIds).toContain('transport-davinci');
        expect(outcome.navaIds).toContain('transport-nava');
        expect(outcome.navaIds).toContain('transport-centurion');
        expect(outcome.cenIds).toEqual(['transport-centurion']);
        expect(outcome.marthaIds).toEqual(['transport-centurion']);
        expect(outcome.roppermanIds).toEqual(['transport-centurion']);
        expect(outcome.darrenIds).toEqual(['transport-centurion']);
        expect(outcome.kamalaIds).toEqual(['transport-centurion']);
      },
      30000,
    );

    it(
      'seeds navaai@, centurion@, martha@, ropperman@, dbezuidenhout@, and kdouglas@ pilot users with emailVerified=true',
      async () => {
        const users = await withSeededTestDb(async (db) => {
          return db
            .select({
              id: userTable.id,
              email: userTable.email,
              emailVerified: userTable.emailVerified,
            })
            .from(userTable);
        });
        expect(users).toHaveLength(6);
        expect(users).toEqual(
          expect.arrayContaining([
            {
              id: NAVA_USER_ID,
              email: NAVA_USER_EMAIL,
              emailVerified: true,
            },
            {
              id: CENTURION_USER_ID,
              email: CENTURION_USER_EMAIL,
              emailVerified: true,
            },
            {
              id: MARTHA_USER_ID,
              email: MARTHA_USER_EMAIL,
              emailVerified: true,
            },
            {
              id: ROPPERMAN_USER_ID,
              email: ROPPERMAN_USER_EMAIL,
              emailVerified: true,
            },
            {
              id: DARREN_USER_ID,
              email: DARREN_USER_EMAIL,
              emailVerified: true,
            },
            {
              id: KAMALA_USER_ID,
              email: KAMALA_USER_EMAIL,
              emailVerified: true,
            },
          ]),
        );
      },
      30000,
    );

    it(
      'prunes stale pilot personas on re-seed',
      async () => {
        const remaining = await withTestDb(async (db) => {
          await seedAll(db);
          await db.insert(userTable).values({
            id: 'user-stale-ops',
            name: 'Stale Ops',
            email: 'nava-ops@legacyhotel.com',
            emailVerified: true,
          });
          await seedAll(db, { rotatePasswords: false });
          return db
            .select({ id: userTable.id, email: userTable.email })
            .from(userTable);
        });
        expect(remaining).toEqual(
          expect.arrayContaining([
            { id: NAVA_USER_ID, email: NAVA_USER_EMAIL },
            { id: CENTURION_USER_ID, email: CENTURION_USER_EMAIL },
            { id: MARTHA_USER_ID, email: MARTHA_USER_EMAIL },
            { id: ROPPERMAN_USER_ID, email: ROPPERMAN_USER_EMAIL },
            { id: DARREN_USER_ID, email: DARREN_USER_EMAIL },
            { id: KAMALA_USER_ID, email: KAMALA_USER_EMAIL },
          ]),
        );
        expect(remaining).toHaveLength(6);
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
          for (const slug of [...AI_WORKFLOW_PRIMARY_SLUGS, 'urgent'] as const) {
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

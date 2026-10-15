import {
  applyProvision,
  applyProvisionThenWriteCredentials,
  planProvision,
  type ProvisionSpec,
} from '../src/db/provision.js';
import {
  applyAfterReservingCredentialsFile,
  parseFlags,
  ProvisionUsageError,
} from '../scripts/provision-prod.js';
import { NAVA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { mailCategory, mailboxAccess, mailboxTransport, mailLabel } from '../src/db/schema/mail.js';
import { account, user as userTable } from '../src/db/schema/auth.js';
import { TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type UserRow = { id: string; name: string; email: string; emailVerified?: boolean };
type AccountRow = {
  id: string;
  userId: string;
  accountId?: string;
  providerId?: string;
  password: string;
};
type TransportRow = {
  id: string;
  email: string;
  ownerHeaderValue?: string;
  displayName?: string;
  isActive: boolean;
  mailboxType?: string;
  sendFromConfig?: unknown;
};
type GrantRow = {
  id: string;
  userId: string;
  transportId: string;
  role: string;
  isDefault: boolean;
};

type FakeState = {
  users: UserRow[];
  accounts: AccountRow[];
  transports: TransportRow[];
  grants: GrantRow[];
  labels: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
};

function tableKey(table: unknown): keyof FakeState | null {
  if (table === userTable) return 'users';
  if (table === account) return 'accounts';
  if (table === mailboxTransport) return 'transports';
  if (table === mailboxAccess) return 'grants';
  if (table === mailLabel) return 'labels';
  if (table === mailCategory) return 'categories';
  return null;
}

function createFakeDb(init: Partial<FakeState> = {}) {
  const state: FakeState = {
    users: [...(init.users ?? [])],
    accounts: [...(init.accounts ?? [])],
    transports: [...(init.transports ?? [])],
    grants: [...(init.grants ?? [])],
    labels: [...(init.labels ?? [])],
    categories: [...(init.categories ?? [])],
  };

  function makeHandle(): DB {
    const handle = {
      select() {
        const query: {
          table?: unknown;
          from: (table: unknown) => typeof query;
          where: () => typeof query;
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject: (err: unknown) => unknown,
          ) => Promise<unknown>;
        } = {
          from(table) {
            query.table = table;
            return query;
          },
          where() {
            return query;
          },
          then(resolve, reject) {
            const key = tableKey(query.table);
            const rows = key ? state[key] : [];
            return Promise.resolve(rows).then(resolve, reject);
          },
        };
        return query;
      },
      insert(table: unknown) {
        const query = {
          values(value: Record<string, unknown> | Record<string, unknown>[]) {
            const rows = Array.isArray(value) ? value : [value];
            const applyInsert = () => {
              const key = tableKey(table);
              if (!key) return [];
              const bucket = state[key] as Array<Record<string, unknown>>;
              const inserted: Record<string, unknown>[] = [];
              for (const row of rows) {
                if (bucket.some((existing) => existing.id === row.id)) continue;
                bucket.push(row);
                inserted.push(row);
              }
              return inserted;
            };
            const thenable = {
              onConflictDoNothing() {
                return thenable;
              },
              onConflictDoUpdate() {
                return thenable;
              },
              returning() {
                return thenable;
              },
              then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
                return Promise.resolve(applyInsert()).then(resolve, reject);
              },
            };
            return thenable;
          },
        };
        return query;
      },
      execute() {
        return Promise.resolve([]);
      },
      delete() {
        throw new Error('delete forbidden');
      },
      update() {
        throw new Error('update forbidden');
      },
      transaction(fn: (tx: DB) => Promise<unknown>) {
        return fn(handle as unknown as DB);
      },
    };
    return handle as unknown as DB;
  }

  return { db: makeHandle(), state };
}

const navaUser: UserRow = {
  id: NAVA_USER_ID,
  name: 'Nava AI',
  email: 'nava@example.test',
  emailVerified: true,
};

const hotel = (id: string, email: string, displayName: string) => ({
  id,
  email,
  ownerHeaderValue: email,
  displayName,
  aliases: [`${id}@example.com`] as const,
});

const TEST_SPEC: ProvisionSpec = {
  users: [
    { id: 'user-hotel-a', name: 'Hotel A', email: 'hotel-a@example.test' },
    { id: 'user-hotel-b', name: 'Hotel B', email: 'hotel-b@example.test' },
    { id: 'user-hotel-c', name: 'Hotel C', email: 'hotel-c@example.test' },
  ],
  transports: [
    hotel('transport-hotel-a', 'hotel-a@example.test', 'Hotel A'),
    hotel('transport-hotel-b', 'hotel-b@example.test', 'Hotel B'),
    hotel('transport-hotel-c', 'hotel-c@example.test', 'Hotel C'),
  ],
  grants: [
    {
      userId: 'user-hotel-a',
      transportId: 'transport-hotel-a',
      role: 'owner',
      isDefault: true,
    },
    {
      userId: 'user-hotel-b',
      transportId: 'transport-hotel-b',
      role: 'owner',
      isDefault: true,
    },
    {
      userId: 'user-hotel-c',
      transportId: 'transport-hotel-c',
      role: 'owner',
      isDefault: true,
    },
    { userId: NAVA_USER_ID, transportId: 'transport-hotel-a', role: 'owner', isDefault: false },
    { userId: NAVA_USER_ID, transportId: 'transport-hotel-b', role: 'owner', isDefault: false },
    { userId: NAVA_USER_ID, transportId: 'transport-hotel-c', role: 'owner', isDefault: false },
  ],
};

const ONE_HOTEL: ProvisionSpec = {
  users: [TEST_SPEC.users[0]!],
  transports: [TEST_SPEC.transports[0]!],
  grants: TEST_SPEC.grants.filter((g) => g.transportId === 'transport-hotel-a'),
};

describe('synthetic provision spec', () => {
  it('covers three hotel logins and grants each only its own transport; navaai non-default on all three', () => {
    expect(TEST_SPEC.users.map((u) => u.id).sort()).toEqual([
      'user-hotel-a',
      'user-hotel-b',
      'user-hotel-c',
    ]);
    expect(TEST_SPEC.users.map((u) => u.name)).toEqual(['Hotel A', 'Hotel B', 'Hotel C']);
    expect(TEST_SPEC.transports.map((t) => t.id).sort()).toEqual([
      'transport-hotel-a',
      'transport-hotel-b',
      'transport-hotel-c',
    ]);
    const byUser = (id: string) => TEST_SPEC.grants.filter((g) => g.userId === id);
    expect(byUser('user-hotel-a')).toEqual([
      {
        userId: 'user-hotel-a',
        transportId: 'transport-hotel-a',
        role: 'owner',
        isDefault: true,
      },
    ]);
    expect(byUser('user-hotel-b')).toEqual([
      {
        userId: 'user-hotel-b',
        transportId: 'transport-hotel-b',
        role: 'owner',
        isDefault: true,
      },
    ]);
    expect(byUser('user-hotel-c')).toEqual([
      {
        userId: 'user-hotel-c',
        transportId: 'transport-hotel-c',
        role: 'owner',
        isDefault: true,
      },
    ]);
    const nava = byUser(NAVA_USER_ID);
    expect(nava.every((g) => g.role === 'owner' && g.isDefault === false)).toBe(true);
    expect(nava.map((g) => g.transportId).sort()).toEqual([
      'transport-hotel-a',
      'transport-hotel-b',
      'transport-hotel-c',
    ]);
    expect(TEST_SPEC.grants.every((g) => g.transportId !== TRANSPORT_ID)).toBe(true);
  });
});

describe('planProvision', () => {
  it('on empty (navaai already present) creates 3 users, missing transports, and grants', async () => {
    const { db } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, TEST_SPEC);
    expect(plan.usersToCreate.map((u) => u.id).sort()).toEqual([
      'user-hotel-a',
      'user-hotel-b',
      'user-hotel-c',
    ]);
    expect(plan.transportsToCreate.map((t) => t.id).sort()).toEqual([
      'transport-hotel-a',
      'transport-hotel-b',
      'transport-hotel-c',
    ]);
    expect(plan.grantsToCreate).toHaveLength(6);
    expect(plan.inactiveTransports).toEqual([]);
    expect(plan.alreadyPresent.users).toEqual([]);
    expect(plan.alreadyPresent.transports).toEqual([]);
    expect(plan.alreadyPresent.grants).toEqual([]);
  });

  it('when all present returns an empty diff', async () => {
    const { db } = createFakeDb({
      users: [navaUser, ...TEST_SPEC.users.map((u) => ({ ...u, emailVerified: true }))],
      transports: TEST_SPEC.transports.map((t) => ({
        id: t.id,
        email: t.email,
        ownerHeaderValue: t.ownerHeaderValue,
        displayName: t.displayName,
        isActive: true,
      })),
      grants: TEST_SPEC.grants.map((g) => ({
        id: `access-${g.userId}-${g.transportId}`,
        ...g,
      })),
    });
    const plan = await planProvision(db, TEST_SPEC);
    expect(plan.usersToCreate).toEqual([]);
    expect(plan.transportsToCreate).toEqual([]);
    expect(plan.grantsToCreate).toEqual([]);
    expect(plan.inactiveTransports).toEqual([]);
    expect(plan.alreadyPresent.users.sort()).toEqual(['user-hotel-a', 'user-hotel-b', 'user-hotel-c']);
    expect(plan.alreadyPresent.transports.sort()).toEqual([
      'transport-hotel-a',
      'transport-hotel-b',
      'transport-hotel-c',
    ]);
    expect(plan.alreadyPresent.grants).toHaveLength(6);
  });

  it('email under another id is alreadyPresent; grants use the existing id', async () => {
    const { db } = createFakeDb({
      users: [
        navaUser,
        {
          id: 'legacy-7',
          name: 'Legacy Hotel A',
          email: 'HOTEL-A@example.test',
          emailVerified: true,
        },
      ],
    });
    const plan = await planProvision(db, ONE_HOTEL);
    expect(plan.usersToCreate).toEqual([]);
    expect(plan.alreadyPresent.users).toEqual(['legacy-7']);
    expect(plan.grantsToCreate).toEqual([
      {
        userId: 'legacy-7',
        transportId: 'transport-hotel-a',
        role: 'owner',
        isDefault: true,
      },
      { userId: NAVA_USER_ID, transportId: 'transport-hotel-a', role: 'owner', isDefault: false },
    ]);
  });

  it('id and email pointing at two different existing users is a plan error', async () => {
    const { db } = createFakeDb({
      users: [
        navaUser,
        {
          id: 'user-hotel-a',
          name: 'Other',
          email: 'other-hotel@example.test',
          emailVerified: true,
        },
        {
          id: 'legacy-7',
          name: 'Legacy Hotel A',
          email: 'hotel-a@example.test',
          emailVerified: true,
        },
      ],
    });
    await expect(planProvision(db, ONE_HOTEL)).rejects.toThrow(
      /provision plan error:.*different existing users/,
    );
  });

  it('reports inactive transports without implying apply will activate them', async () => {
    const transport = TEST_SPEC.transports[0]!;
    const { db } = createFakeDb({
      users: [navaUser],
      transports: [
        {
          id: transport.id,
          email: transport.email,
          ownerHeaderValue: transport.ownerHeaderValue,
          displayName: transport.displayName,
          isActive: false,
        },
      ],
    });
    const plan = await planProvision(db, ONE_HOTEL);
    expect(plan.transportsToCreate).toEqual([]);
    expect(plan.inactiveTransports).toEqual(['transport-hotel-a']);
    expect('transportsToActivate' in plan).toBe(false);
  });
});

describe('applyProvision', () => {
  it('never issues delete or update', async () => {
    const { db } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, TEST_SPEC);
    await applyProvision(
      db,
      plan,
      Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
    );
  });

  it('does not re-password an existing user', async () => {
    const existing = TEST_SPEC.users[0]!;
    const { db, state } = createFakeDb({
      users: [navaUser, { ...existing, emailVerified: true }],
      accounts: [
        {
          id: `cred-${existing.id}`,
          userId: existing.id,
          password: 'KEEP-HASH',
        },
      ],
    });
    const plan = await planProvision(db, TEST_SPEC);
    expect(plan.usersToCreate.map((u) => u.id)).not.toContain(existing.id);
    await applyProvision(
      db,
      plan,
      Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
    );
    expect(state.accounts.find((a) => a.userId === existing.id)?.password).toBe('KEEP-HASH');
  });

  it('grants hotel users only own transport; navaai non-default on all three', async () => {
    const { db, state } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, TEST_SPEC);
    await applyProvision(
      db,
      plan,
      Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
    );
    const grantsFor = (userId: string) =>
      state.grants
        .filter((g) => g.userId === userId)
        .map((g) => ({
          userId: g.userId,
          transportId: g.transportId,
          role: g.role,
          isDefault: g.isDefault,
        }));
    expect(grantsFor('user-hotel-a')).toEqual([
      { userId: 'user-hotel-a', transportId: 'transport-hotel-a', role: 'owner', isDefault: true },
    ]);
    expect(grantsFor('user-hotel-b')).toEqual([
      { userId: 'user-hotel-b', transportId: 'transport-hotel-b', role: 'owner', isDefault: true },
    ]);
    expect(grantsFor('user-hotel-c')).toEqual([
      { userId: 'user-hotel-c', transportId: 'transport-hotel-c', role: 'owner', isDefault: true },
    ]);
    expect(grantsFor(NAVA_USER_ID)).toEqual(
      expect.arrayContaining([
        {
          userId: NAVA_USER_ID,
          transportId: 'transport-hotel-a',
          role: 'owner',
          isDefault: false,
        },
        {
          userId: NAVA_USER_ID,
          transportId: 'transport-hotel-b',
          role: 'owner',
          isDefault: false,
        },
        {
          userId: NAVA_USER_ID,
          transportId: 'transport-hotel-c',
          role: 'owner',
          isDefault: false,
        },
      ]),
    );
    expect(grantsFor(NAVA_USER_ID)).toHaveLength(3);
    expect(state.grants.every((g) => g.transportId !== TRANSPORT_ID)).toBe(true);
    const second = await planProvision(db, TEST_SPEC);
    expect(second.usersToCreate).toEqual([]);
    expect(second.transportsToCreate).toEqual([]);
    expect(second.grantsToCreate).toEqual([]);
  });

  it('grants the existing user id when the spec email already belongs to another id', async () => {
    const { db, state } = createFakeDb({
      users: [
        navaUser,
        {
          id: 'legacy-7',
          name: 'Legacy Hotel A',
          email: 'hotel-a@example.test',
          emailVerified: true,
        },
      ],
      accounts: [{ id: 'cred-legacy-7', userId: 'legacy-7', password: 'KEEP-HASH' }],
    });
    const plan = await planProvision(db, ONE_HOTEL);
    await applyProvision(db, plan, {});
    expect(state.accounts.find((a) => a.userId === 'legacy-7')?.password).toBe('KEEP-HASH');
    expect(state.users.some((u) => u.id === 'user-hotel-a')).toBe(false);
    expect(state.grants.filter((g) => g.transportId === 'transport-hotel-a').map((g) => g.userId).sort()).toEqual(
      ['legacy-7', NAVA_USER_ID].sort(),
    );
  });

  it('throws on a stale user insert and does not write the credentials file', async () => {
    const existing = TEST_SPEC.users[0]!;
    const { db, state } = createFakeDb({
      users: [navaUser, { ...existing, emailVerified: true }],
      accounts: [{ id: `cred-${existing.id}`, userId: existing.id, password: 'KEEP-HASH' }],
    });
    const plan = await planProvision(db, TEST_SPEC);
    const stale = {
      ...plan,
      usersToCreate: [existing, ...plan.usersToCreate],
    };
    let wrote = false;
    await expect(
      applyProvisionThenWriteCredentials(
        db,
        stale,
        Object.fromEntries(
          stale.usersToCreate.map((u) => [u.email, `pw-${u.id}`]),
        ),
        () => {
          wrote = true;
        },
      ),
    ).rejects.toThrow('stale plan, re-run dry-run');
    expect(wrote).toBe(false);
    expect(state.accounts.find((a) => a.userId === existing.id)?.password).toBe('KEEP-HASH');
  });

  it('throws on a stale grant insert', async () => {
    const { db, state } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, ONE_HOTEL);
    const planned = plan.grantsToCreate[0]!;
    state.grants.push({
      id: `access-${planned.userId}-${planned.transportId}`,
      userId: planned.userId,
      transportId: planned.transportId,
      role: 'owner',
      isDefault: !planned.isDefault,
    });
    await expect(
      applyProvision(
        db,
        plan,
        Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
      ),
    ).rejects.toThrow('stale plan, re-run dry-run');
  });
});

describe('parseFlags', () => {
  it('rejects unknown flags with usage and exit 2', () => {
    expect(() => parseFlags(['--aply'])).toThrow(ProvisionUsageError);
    try {
      parseFlags(['--aply']);
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionUsageError);
      expect((err as ProvisionUsageError).exitCode).toBe(2);
      expect((err as Error).message).toMatch(/usage:/i);
    }
  });

  it('accepts --apply and --credentials-out', () => {
    expect(parseFlags(['--apply', '--credentials-out', '/tmp/out.json'])).toEqual({
      apply: true,
      credentialsOut: '/tmp/out.json',
    });
  });
});

describe('applyAfterReservingCredentialsFile', () => {
  it('fails before apply when credentials parent dir is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-creds-'));
    try {
      const apply = vi.fn(async () => ({ 'hotel-a@example.test': { password: 'secret' } }));
      await expect(
        applyAfterReservingCredentialsFile({
          path: join(root, 'missing-parent', 'creds.json'),
          apply,
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unlinks the reserved empty file when apply fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-creds-'));
    const path = join(root, 'creds.json');
    try {
      await expect(
        applyAfterReservingCredentialsFile({
          path,
          apply: async () => {
            throw new Error('db failed');
          },
        }),
      ).rejects.toThrow('db failed');
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!TEST_DB_AVAILABLE)('planProvision/applyProvision (disposable PostgreSQL)', () => {
  it('grants an existing-email user and rolls back a stale apply', async () => {
    await withSeededTestDb(async (db) => {
      await db.insert(userTable).values({
        id: 'legacy-7',
        name: 'Legacy Hotel A',
        email: 'hotel-a@example.test',
        emailVerified: true,
      });
      const plan = await planProvision(db, ONE_HOTEL);
      expect(plan.usersToCreate).toEqual([]);
      expect(plan.alreadyPresent.users).toEqual(['legacy-7']);
      expect(plan.grantsToCreate.map((g) => g.userId).sort()).toEqual(
        ['legacy-7', NAVA_USER_ID].sort(),
      );
      await applyProvision(db, plan, {});
      const grants = await db
        .select({ userId: mailboxAccess.userId, transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.transportId, 'transport-hotel-a'));
      expect(grants.map((g) => g.userId).sort()).toEqual(['legacy-7', NAVA_USER_ID].sort());

      const stale = {
        ...plan,
        usersToCreate: [{ id: 'user-hotel-a', name: 'Hotel A', email: 'hotel-a-new@example.test' }],
      };
      await db.insert(userTable).values({
        id: 'user-hotel-a',
        name: 'Already',
        email: 'hotel-a-new@example.test',
        emailVerified: true,
      });
      await expect(
        applyProvision(db, stale, { 'hotel-a-new@example.test': 'pw-should-not-land' }),
      ).rejects.toThrow('stale plan, re-run dry-run');
      const accounts = await db
        .select({ id: account.id, userId: account.userId })
        .from(account)
        .where(eq(account.userId, 'user-hotel-a'));
      expect(accounts).toEqual([]);
    });
  });
});

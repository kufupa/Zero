import {
  AYANDA_TRANSPORT_ID,
  DAVINCI_TRANSPORT_ID,
  FAITH_TRANSPORT_ID,
  NAVA_USER_EMAIL,
  NAVA_USER_ID,
  TRANSPORT_ID,
} from '../src/db/seed.js';
import { mailCategory, mailboxAccess, mailboxTransport, mailLabel } from '../src/db/schema/mail.js';
import { applyProvision, planProvision, PROVISION_SPEC } from '../src/db/provision.js';
import { account, user as userTable } from '../src/db/schema/auth.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';

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
              if (!key) return;
              const bucket = state[key] as Array<Record<string, unknown>>;
              for (const row of rows) {
                if (bucket.some((existing) => existing.id === row.id)) continue;
                bucket.push(row);
              }
            };
            const thenable = {
              onConflictDoNothing() {
                return thenable;
              },
              onConflictDoUpdate() {
                return thenable;
              },
              then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
                applyInsert();
                return Promise.resolve(undefined).then(resolve, reject);
              },
            };
            return thenable;
          },
        };
        return query;
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
  email: NAVA_USER_EMAIL,
  emailVerified: true,
};

describe('PROVISION_SPEC', () => {
  it('covers three hotel logins and grants each only its own transport; navaai non-default on all three', () => {
    expect(PROVISION_SPEC.users.map((u) => u.id).sort()).toEqual([
      'user-ayanda',
      'user-davinci',
      'user-faith',
    ]);
    expect(PROVISION_SPEC.transports.map((t) => t.id).sort()).toEqual([
      AYANDA_TRANSPORT_ID,
      DAVINCI_TRANSPORT_ID,
      FAITH_TRANSPORT_ID,
    ]);
    const byUser = (id: string) => PROVISION_SPEC.grants.filter((g) => g.userId === id);
    expect(byUser('user-davinci')).toEqual([
      { userId: 'user-davinci', transportId: DAVINCI_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    expect(byUser('user-faith')).toEqual([
      { userId: 'user-faith', transportId: FAITH_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    expect(byUser('user-ayanda')).toEqual([
      { userId: 'user-ayanda', transportId: AYANDA_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    const nava = byUser(NAVA_USER_ID);
    expect(nava.every((g) => g.role === 'owner' && g.isDefault === false)).toBe(true);
    expect(nava.map((g) => g.transportId).sort()).toEqual([
      AYANDA_TRANSPORT_ID,
      DAVINCI_TRANSPORT_ID,
      FAITH_TRANSPORT_ID,
    ]);
    expect(PROVISION_SPEC.grants.every((g) => g.transportId !== TRANSPORT_ID)).toBe(true);
  });
});

describe('planProvision', () => {
  it('on empty (navaai already present) creates 3 users, missing transports, and grants', async () => {
    const { db } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, PROVISION_SPEC);
    expect(plan.usersToCreate.map((u) => u.id).sort()).toEqual([
      'user-ayanda',
      'user-davinci',
      'user-faith',
    ]);
    expect(plan.transportsToCreate.map((t) => t.id).sort()).toEqual([
      AYANDA_TRANSPORT_ID,
      DAVINCI_TRANSPORT_ID,
      FAITH_TRANSPORT_ID,
    ]);
    expect(plan.grantsToCreate).toHaveLength(6);
    expect(plan.alreadyPresent.users).toEqual([]);
    expect(plan.alreadyPresent.transports).toEqual([]);
    expect(plan.alreadyPresent.grants).toEqual([]);
  });

  it('when all present returns an empty diff', async () => {
    const { db } = createFakeDb({
      users: [navaUser, ...PROVISION_SPEC.users.map((u) => ({ ...u, emailVerified: true }))],
      transports: PROVISION_SPEC.transports.map((t) => ({
        id: t.id,
        email: t.email,
        isActive: true,
      })),
      grants: PROVISION_SPEC.grants.map((g) => ({
        id: `access-${g.userId}-${g.transportId}`,
        ...g,
      })),
    });
    const plan = await planProvision(db, PROVISION_SPEC);
    expect(plan.usersToCreate).toEqual([]);
    expect(plan.transportsToCreate).toEqual([]);
    expect(plan.grantsToCreate).toEqual([]);
    expect(plan.alreadyPresent.users.sort()).toEqual(['user-ayanda', 'user-davinci', 'user-faith']);
    expect(plan.alreadyPresent.transports.sort()).toEqual([
      AYANDA_TRANSPORT_ID,
      DAVINCI_TRANSPORT_ID,
      FAITH_TRANSPORT_ID,
    ]);
    expect(plan.alreadyPresent.grants).toHaveLength(6);
  });
});

describe('applyProvision', () => {
  it('never issues delete or update', async () => {
    const { db } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, PROVISION_SPEC);
    await applyProvision(
      db,
      plan,
      Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
    );
  });

  it('does not re-password an existing user', async () => {
    const existing = PROVISION_SPEC.users[0]!;
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
    const plan = await planProvision(db, PROVISION_SPEC);
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
    const plan = await planProvision(db, PROVISION_SPEC);
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
    expect(grantsFor('user-davinci')).toEqual([
      { userId: 'user-davinci', transportId: DAVINCI_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    expect(grantsFor('user-faith')).toEqual([
      { userId: 'user-faith', transportId: FAITH_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    expect(grantsFor('user-ayanda')).toEqual([
      { userId: 'user-ayanda', transportId: AYANDA_TRANSPORT_ID, role: 'owner', isDefault: true },
    ]);
    expect(grantsFor(NAVA_USER_ID)).toEqual(
      expect.arrayContaining([
        {
          userId: NAVA_USER_ID,
          transportId: DAVINCI_TRANSPORT_ID,
          role: 'owner',
          isDefault: false,
        },
        { userId: NAVA_USER_ID, transportId: FAITH_TRANSPORT_ID, role: 'owner', isDefault: false },
        { userId: NAVA_USER_ID, transportId: AYANDA_TRANSPORT_ID, role: 'owner', isDefault: false },
      ]),
    );
    expect(grantsFor(NAVA_USER_ID)).toHaveLength(3);
    expect(state.grants.every((g) => g.transportId !== TRANSPORT_ID)).toBe(true);
    const second = await planProvision(db, PROVISION_SPEC);
    expect(second.usersToCreate).toEqual([]);
    expect(second.transportsToCreate).toEqual([]);
    expect(second.grantsToCreate).toEqual([]);
  });
});

import {
  applyProvision,
  applyProvisionThenWriteCredentials,
  planProvision,
  PROVISION_SPEC,
  type ProvisionSpec,
} from '../src/db/provision.js';
import {
  applyAfterReservingCredentialsFile,
  loadCredentialsIn,
  parseFlags,
  ProvisionUsageError,
  redactCredentialsOut,
} from '../scripts/provision-prod.js';
import {
  AYANDA_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_EMAIL,
  DAVINCI_TRANSPORT_ID,
  EPICK_TRANSPORT_EMAIL,
  EPICK_TRANSPORT_ID,
  FAITH_TRANSPORT_EMAIL,
  KMGIDI_TRANSPORT_EMAIL,
  KMGIDI_TRANSPORT_ID,
  NAVA_USER_ID,
  TRANSPORT_ID,
} from '../src/db/seed.js';
import { mailCategory, mailboxAccess, mailboxTransport, mailLabel } from '../src/db/schema/mail.js';
import { account, user as userTable } from '../src/db/schema/auth.js';
import { TEST_DB_AVAILABLE, withTestDb } from './helpers/test-db.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { inspect } from 'node:util';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function createFakeDb(init: Partial<FakeState> & { failCommit?: boolean } = {}) {
  const { failCommit = false, ...rows } = init;
  const state: FakeState = {
    users: [...(rows.users ?? [])],
    accounts: [...(rows.accounts ?? [])],
    transports: [...(rows.transports ?? [])],
    grants: [...(rows.grants ?? [])],
    labels: [...(rows.labels ?? [])],
    categories: [...(rows.categories ?? [])],
  };
  const conflictUpdates: unknown[] = [];

  function snapshotState(): FakeState {
    return {
      users: state.users.map((row) => ({ ...row })),
      accounts: state.accounts.map((row) => ({ ...row })),
      transports: state.transports.map((row) => ({ ...row })),
      grants: state.grants.map((row) => ({ ...row })),
      labels: state.labels.map((row) => ({ ...row })),
      categories: state.categories.map((row) => ({ ...row })),
    };
  }

  function restoreState(snapshot: FakeState): void {
    state.users.splice(0, state.users.length, ...snapshot.users);
    state.accounts.splice(0, state.accounts.length, ...snapshot.accounts);
    state.transports.splice(0, state.transports.length, ...snapshot.transports);
    state.grants.splice(0, state.grants.length, ...snapshot.grants);
    state.labels.splice(0, state.labels.length, ...snapshot.labels);
    state.categories.splice(0, state.categories.length, ...snapshot.categories);
  }

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
              onConflictDoUpdate(value?: unknown) {
                conflictUpdates.push(value ?? true);
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
      async transaction(fn: (tx: DB) => Promise<unknown>) {
        const snapshot = snapshotState();
        try {
          const result = await fn(handle as unknown as DB);
          if (failCommit) throw new Error('commit failed');
          return result;
        } catch (err) {
          restoreState(snapshot);
          throw err;
        }
      },
    };
    return handle as unknown as DB;
  }

  return { db: makeHandle(), state, conflictUpdates };
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

  it('existing user with a different name is alreadyPresent and is not a plan error', async () => {
    const existing = TEST_SPEC.users[0]!;
    const { db, state } = createFakeDb({
      users: [
        navaUser,
        { id: existing.id, name: 'Old Name', email: existing.email, emailVerified: true },
      ],
    });
    const plan = await planProvision(db, ONE_HOTEL);
    expect(plan.usersToCreate).toEqual([]);
    expect(plan.alreadyPresent.users).toEqual([existing.id]);
    await applyProvision(db, plan, {});
    expect(state.users.find((u) => u.id === existing.id)?.name).toBe('Old Name');
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
      /provision plan error:.*exists with a different email/,
    );
  });

  it('spec id present with a different email aborts the plan (no grants)', async () => {
    const { db } = createFakeDb({
      users: [
        navaUser,
        {
          id: 'user-hotel-a',
          name: 'Other',
          email: 'other-hotel@example.test',
          emailVerified: true,
        },
      ],
    });
    await expect(planProvision(db, ONE_HOTEL)).rejects.toThrow(
      /provision plan error:.*exists with a different email.*no grants/,
    );
  });

  it('email resolving to a different spec user id aborts the plan (no grants)', async () => {
    const twoHotels: ProvisionSpec = {
      users: [TEST_SPEC.users[0]!, TEST_SPEC.users[1]!],
      transports: [TEST_SPEC.transports[0]!, TEST_SPEC.transports[1]!],
      grants: TEST_SPEC.grants.filter(
        (g) => g.transportId === 'transport-hotel-a' || g.transportId === 'transport-hotel-b',
      ),
    };
    const { db } = createFakeDb({
      users: [
        navaUser,
        {
          id: 'user-hotel-b',
          name: 'Hotel B',
          email: 'hotel-a@example.test',
          emailVerified: true,
        },
      ],
    });
    await expect(planProvision(db, twoHotels)).rejects.toThrow(
      /provision plan error:.*different spec user.*no grants/,
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
    const { db, conflictUpdates } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, TEST_SPEC);
    await applyProvision(
      db,
      plan,
      Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
    );
    expect(conflictUpdates).toEqual([]);
  });

  it('rolls back users when credentials write fails', async () => {
    const { db, state } = createFakeDb({ users: [navaUser] });
    const plan = await planProvision(db, ONE_HOTEL);
    await expect(
      applyProvisionThenWriteCredentials(
        db,
        plan,
        Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
        () => {
          throw new Error('ENOSPC');
        },
      ),
    ).rejects.toThrow('ENOSPC');
    expect(state.users.map((u) => u.id)).toEqual([NAVA_USER_ID]);
    expect(state.transports).toEqual([]);
    expect(state.grants).toEqual([]);
    expect(state.accounts).toEqual([]);
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

describe('PROVISION_SPEC', () => {
  it('uses full names for new users and grants kmgidi own transport only', () => {
    expect(PROVISION_SPEC.users).toEqual([
      { id: 'user-davinci', name: 'Da Vinci Reservations', email: DAVINCI_TRANSPORT_EMAIL },
      { id: 'user-faith', name: 'Faith Khumalo', email: FAITH_TRANSPORT_EMAIL },
      { id: 'user-ayanda', name: 'Ayanda Dladla', email: AYANDA_TRANSPORT_EMAIL },
      { id: 'user-epick', name: 'Elizabeth Pick', email: EPICK_TRANSPORT_EMAIL },
      { id: 'user-kmgidi', name: 'Khanyisile Mgidi', email: KMGIDI_TRANSPORT_EMAIL },
    ]);
    const byUser = (id: string) => PROVISION_SPEC.grants.filter((g) => g.userId === id);
    expect(byUser('user-epick')).toEqual([
      {
        userId: 'user-epick',
        transportId: EPICK_TRANSPORT_ID,
        role: 'owner',
        isDefault: true,
      },
    ]);
    expect(byUser('user-kmgidi')).toEqual([
      {
        userId: 'user-kmgidi',
        transportId: KMGIDI_TRANSPORT_ID,
        role: 'owner',
        isDefault: true,
      },
    ]);
    expect(
      byUser('user-kmgidi').every(
        (g) => g.transportId !== DAVINCI_TRANSPORT_ID && g.transportId !== TRANSPORT_ID,
      ),
    ).toBe(true);
    expect(
      PROVISION_SPEC.grants.some(
        (g) =>
          g.userId === 'user-kmgidi' &&
          (g.transportId === DAVINCI_TRANSPORT_ID || g.transportId === TRANSPORT_ID),
      ),
    ).toBe(false);
    expect(byUser(NAVA_USER_ID).filter((g) => g.transportId === EPICK_TRANSPORT_ID)).toEqual([
      { userId: NAVA_USER_ID, transportId: EPICK_TRANSPORT_ID, role: 'owner', isDefault: false },
    ]);
    expect(byUser(NAVA_USER_ID).filter((g) => g.transportId === KMGIDI_TRANSPORT_ID)).toEqual([
      { userId: NAVA_USER_ID, transportId: KMGIDI_TRANSPORT_ID, role: 'owner', isDefault: false },
    ]);
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
      credentialsIn: null,
    });
  });

  it('accepts --credentials-in with --apply --credentials-out', () => {
    expect(
      parseFlags([
        '--apply',
        '--credentials-out',
        '/tmp/out.json',
        '--credentials-in',
        '/tmp/in.json',
      ]),
    ).toEqual({
      apply: true,
      credentialsOut: '/tmp/out.json',
      credentialsIn: '/tmp/in.json',
    });
  });

  it('rejects a missing or flag-like --credentials-in value with exit 2', () => {
    expect(() => parseFlags(['--credentials-in'])).toThrow(ProvisionUsageError);
    expect(() => parseFlags(['--credentials-in', '--apply'])).toThrow(ProvisionUsageError);
  });

  it('rejects --apply --credentials-in without --credentials-out', () => {
    expect(() => parseFlags(['--apply', '--credentials-in', '/tmp/in.json'])).toThrow(
      ProvisionUsageError,
    );
  });

  it('rejects a missing or flag-like --credentials-out value with exit 2 and no file', () => {
    expect(() => parseFlags(['--apply', '--credentials-out'])).toThrow(ProvisionUsageError);
    expect(() => parseFlags(['--apply', '--credentials-out', '--bogus'])).toThrow(
      ProvisionUsageError,
    );
    try {
      parseFlags(['--apply', '--credentials-out', '--bogus']);
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionUsageError);
      expect((err as ProvisionUsageError).exitCode).toBe(2);
    }
    expect(existsSync('--bogus')).toBe(false);
  });

  it('rejects --apply without --credentials-out with exit 2 before any file is created', () => {
    expect(() => parseFlags(['--apply'])).toThrow(ProvisionUsageError);
    try {
      parseFlags(['--apply']);
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionUsageError);
      expect((err as ProvisionUsageError).exitCode).toBe(2);
      expect((err as Error).message).toMatch(/usage:/i);
    }
    expect(existsSync('--apply')).toBe(false);
    expect(existsSync('--credentials-out')).toBe(false);
  });
});

const CREDENTIALS_LEAK_SECRET = 'NEVER-LOG-THIS-password-99';
const CREDENTIALS_OK = 'ninecharsX';
const SPEC_EMAILS = TEST_SPEC.users.map((u) => u.email);
const CREATE_EMAILS = [TEST_SPEC.users[0]!.email];

function writeCredentialsInFile(
  root: string,
  body: string,
  mode: number,
  name = 'in.json',
): string {
  const path = join(root, name);
  writeFileSync(path, body, { encoding: 'utf8', mode });
  chmodSync(path, mode);
  return path;
}

function captureConsoleAndStderr(run: () => void): string {
  const chunks: string[] = [];
  const spy = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
  };
  const origLog = console.log;
  const origErr = console.error;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  console.log = spy as typeof console.log;
  console.error = spy as typeof console.error;
  console.info = spy as typeof console.info;
  console.warn = spy as typeof console.warn;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return origStdout(chunk as never, ...(rest as []));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return origStderr(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;
  try {
    run();
  } catch (err) {
    spy(err);
    if (err instanceof Error) spy(err.message, err.stack);
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.info = origInfo;
    console.warn = origWarn;
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
  return chunks.join('\n');
}

describe('loadCredentialsIn', () => {
  const specEmails = SPEC_EMAILS;
  const usersToCreate = CREATE_EMAILS;

  it('reads 0600 object passwords for usersToCreate', () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-cin-'));
    try {
      const path = writeCredentialsInFile(
        root,
        JSON.stringify({
          [TEST_SPEC.users[0]!.email]: CREDENTIALS_OK,
          [TEST_SPEC.users[1]!.email]: CREDENTIALS_OK,
        }),
        0o600,
      );
      expect(loadCredentialsIn(path, specEmails, usersToCreate)).toEqual({
        [TEST_SPEC.users[0]!.email]: CREDENTIALS_OK,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never logs a password substring on every error path', () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-cin-err-'));
    const createEmail = TEST_SPEC.users[0]!.email;
    const extraEmail = 'outsider@example.test';
    const errorPaths: Array<() => void> = [
      () => loadCredentialsIn(join(root, 'missing.json'), specEmails, usersToCreate),
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify({ [createEmail]: CREDENTIALS_LEAK_SECRET }),
          0o644,
          'not-0600.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify([CREDENTIALS_LEAK_SECRET]),
          0o600,
          'array.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify({ [TEST_SPEC.users[1]!.email]: CREDENTIALS_LEAK_SECRET }),
          0o600,
          'missing-create.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify({ [createEmail]: 'shortpw' }),
          0o600,
          'short.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify({ [createEmail]: 'x'.repeat(65) }),
          0o600,
          'long.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          JSON.stringify({
            [createEmail]: CREDENTIALS_LEAK_SECRET,
            [extraEmail]: CREDENTIALS_LEAK_SECRET,
          }),
          0o600,
          'extra.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
      () => {
        const path = writeCredentialsInFile(
          root,
          `{"${createEmail}": "${CREDENTIALS_LEAK_SECRET}"`,
          0o600,
          'bad-json.json',
        );
        loadCredentialsIn(path, specEmails, usersToCreate);
      },
    ];
    try {
      for (const run of errorPaths) {
        const blob = captureConsoleAndStderr(run);
        expect(blob).not.toContain(CREDENTIALS_LEAK_SECRET);
        expect(blob).not.toContain('shortpw');
        expect(blob).not.toContain('x'.repeat(65));
      }
      const extraBlob = captureConsoleAndStderr(() => {
        loadCredentialsIn(join(root, 'extra.json'), specEmails, usersToCreate);
      });
      expect(extraBlob).toContain(extraEmail);
      expect(extraBlob).not.toContain(CREDENTIALS_LEAK_SECRET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts credentials-out when sourced from credentials-in', () => {
    const payload = { [TEST_SPEC.users[0]!.email]: { password: CREDENTIALS_LEAK_SECRET } };
    const redacted = redactCredentialsOut(payload);
    expect(redacted).toEqual({
      [TEST_SPEC.users[0]!.email]: { password: '<from credentials-in>' },
    });
    expect(inspect(redacted)).not.toContain(CREDENTIALS_LEAK_SECRET);
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
          apply: async () => {
            await apply();
          },
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes <from credentials-in> to credentials-out, never the password', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-creds-redact-'));
    const path = join(root, 'creds.json');
    try {
      await applyAfterReservingCredentialsFile({
        path,
        apply: async (writeCredentials) => {
          writeCredentials(
            redactCredentialsOut({
              [TEST_SPEC.users[0]!.email]: { password: CREDENTIALS_LEAK_SECRET },
            }),
          );
        },
      });
      const written = readFileSync(path, 'utf8');
      expect(written).toContain('<from credentials-in>');
      expect(written).not.toContain(CREDENTIALS_LEAK_SECRET);
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

  it('removes the credentials file when commit fails after a durable write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-creds-'));
    const path = join(root, 'creds.json');
    try {
      const { db, state } = createFakeDb({ users: [navaUser], failCommit: true });
      const plan = await planProvision(db, ONE_HOTEL);
      await expect(
        applyAfterReservingCredentialsFile({
          path,
          apply: async (writeCredentials) => {
            await applyProvisionThenWriteCredentials(
              db,
              plan,
              Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
              writeCredentials,
            );
          },
        }),
      ).rejects.toThrow('commit failed');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.ROLLED_BACK`)).toBe(false);
      expect(state.users.map((u) => u.id)).toEqual([NAVA_USER_ID]);
      expect(state.transports).toEqual([]);
      expect(state.grants).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws on a partial then 0-byte writeSync so commit never happens and the file is cleaned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'provision-creds-'));
    const path = join(root, 'creds.json');
    try {
      const { db, state } = createFakeDb({ users: [navaUser] });
      const plan = await planProvision(db, ONE_HOTEL);
      let calls = 0;
      const writePartialThenZero = (
        _fd: number,
        _buffer: NodeJS.ArrayBufferView,
        _offset?: number | null,
        length?: number | null,
      ): number => {
        calls += 1;
        if (calls === 1) {
          const remaining = length ?? 8;
          return Math.max(1, Math.min(4, remaining));
        }
        return 0;
      };
      await expect(
        applyAfterReservingCredentialsFile({
          path,
          writeSync: writePartialThenZero,
          apply: async (writeCredentials) => {
            await applyProvisionThenWriteCredentials(
              db,
              plan,
              Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
              writeCredentials,
            );
          },
        }),
      ).rejects.toThrow(/short write|0-byte|0 bytes/i);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.ROLLED_BACK`)).toBe(false);
      expect(state.users.map((u) => u.id)).toEqual([NAVA_USER_ID]);
      expect(state.transports).toEqual([]);
      expect(state.grants).toEqual([]);
      expect(state.accounts).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const TEST_PROVISION_USER_ID = 'user-test-provision-a';

const DISPOSABLE_ONE_HOTEL: ProvisionSpec = {
  users: ONE_HOTEL.users,
  transports: ONE_HOTEL.transports,
  grants: ONE_HOTEL.grants.map((g) =>
    g.userId === NAVA_USER_ID ? { ...g, userId: TEST_PROVISION_USER_ID } : g,
  ),
};

async function insertSyntheticProvisionUser(db: DB): Promise<void> {
  await db.insert(userTable).values({
    id: TEST_PROVISION_USER_ID,
    name: 'Provision Test User',
    email: 'provision-test@example.test',
    emailVerified: true,
  });
}

describe.skipIf(!TEST_DB_AVAILABLE)('planProvision/applyProvision (disposable PostgreSQL)', () => {
  it('grants an existing-email user and rolls back a stale apply', async () => {
    await withTestDb(async (db) => {
      await insertSyntheticProvisionUser(db);
      await db.insert(userTable).values({
        id: 'legacy-7',
        name: 'Legacy Hotel A',
        email: 'hotel-a@example.test',
        emailVerified: true,
      });
      const plan = await planProvision(db, DISPOSABLE_ONE_HOTEL);
      expect(plan.usersToCreate).toEqual([]);
      expect(plan.alreadyPresent.users).toEqual(['legacy-7']);
      expect(plan.grantsToCreate.map((g) => g.userId).sort()).toEqual(
        ['legacy-7', TEST_PROVISION_USER_ID].sort(),
      );
      await applyProvision(db, plan, {});
      const grants = await db
        .select({ userId: mailboxAccess.userId, transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .where(eq(mailboxAccess.transportId, 'transport-hotel-a'));
      expect(grants.map((g) => g.userId).sort()).toEqual(
        ['legacy-7', TEST_PROVISION_USER_ID].sort(),
      );

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

  it('write failure rolls back so no new users remain', async () => {
    await withTestDb(async (db) => {
      await insertSyntheticProvisionUser(db);
      const plan = await planProvision(db, DISPOSABLE_ONE_HOTEL);
      await expect(
        applyProvisionThenWriteCredentials(
          db,
          plan,
          Object.fromEntries(plan.usersToCreate.map((u) => [u.email, `pw-${u.id}`])),
          () => {
            throw new Error('ENOSPC');
          },
        ),
      ).rejects.toThrow('ENOSPC');
      const users = await db.select({ id: userTable.id }).from(userTable);
      expect(users.map((u) => u.id).sort()).toEqual([TEST_PROVISION_USER_ID]);
      const transports = await db
        .select({ id: mailboxTransport.id })
        .from(mailboxTransport)
        .where(eq(mailboxTransport.id, 'transport-hotel-a'));
      expect(transports).toEqual([]);
    });
  });
});

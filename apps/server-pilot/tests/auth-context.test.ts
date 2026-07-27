import { beforeAll, describe, expect, it } from 'vitest';
import {
  resolveMailboxContext,
  MailboxForbiddenError,
  MailboxNoAccessError,
} from '../src/trpc/context';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mailbox context (seeded, transaction-rollback)',
  () => {
    it(
      'returns owner access for centurion user on Centurion transport',
      async () => {
        const ctx = await withSeededTestDb((db) =>
          resolveMailboxContext('user-centurion', 'transport-centurion', db),
        );
        expect(ctx).toBeDefined();
        expect(ctx.transportEmail).toBe('centurion@legacyhotels.co.za');
        expect(ctx.accessRole).toBe('owner');
        expect(ctx.userId).toBe('user-centurion');
        expect(ctx.activeTransportId).toBe('transport-centurion');
      },
      30000,
    );

    it(
      'returns owner access for navaai on Centurion transport',
      async () => {
        const ctx = await withSeededTestDb((db) =>
          resolveMailboxContext('user-navaai', 'transport-centurion', db),
        );
        expect(ctx.userId).toBe('user-navaai');
        expect(ctx.activeTransportId).toBe('transport-centurion');
        expect(ctx.transportEmail).toBe('centurion@legacyhotels.co.za');
        expect(ctx.accessRole).toBe('owner');
      },
      30000,
    );

    it(
      'rejects users without mailboxAccess with FORBIDDEN',
      async () => {
        await expect(
          withSeededTestDb((db) =>
            resolveMailboxContext('user-frontdesk', 'transport-centurion', db),
          ),
        ).rejects.toThrow(/FORBIDDEN/);
      },
      30000,
    );

    it(
      'defaults to isDefault transport when none requested',
      async () => {
        const ctx = await withSeededTestDb((db) =>
          resolveMailboxContext('user-navaai', undefined, db),
        );
        expect(ctx.userId).toBe('user-navaai');
        expect(ctx.transportEmail).toBe('navaai@legacyhotels.co.za');
        expect(ctx.activeTransportId).toBe('transport-nava');
        expect(ctx.accessRole).toBe('owner');
      },
      30000,
    );

    it(
      'callerFor rejects users with no mailbox access before tRPC',
      async () => {
        await withSeededTestDb(async (db) => {
          await expect(callerFor('user-ghost', { db })).rejects.toBeInstanceOf(
            MailboxNoAccessError,
          );
        });
      },
      30000,
    );
  },
);

describe('resolveMailboxContext unit shape', () => {
  it('exposes MailboxForbiddenError carrying FORBIDDEN', () => {
    const err = new MailboxForbiddenError();
    expect(err.message).toBe('FORBIDDEN');
    expect(err.name).toBe('MailboxForbiddenError');
  });

  it('exposes MailboxNoAccessError carrying NO_MAILBOX', () => {
    const err = new MailboxNoAccessError();
    expect(err.message).toBe('NO_MAILBOX');
    expect(err.name).toBe('MailboxNoAccessError');
  });
});

void beforeAll;

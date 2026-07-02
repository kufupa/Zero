import { beforeAll, describe, expect, it } from 'vitest';
import { resolveMailboxContext, MailboxForbiddenError, MailboxNoAccessError } from '../src/trpc/context';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mailbox context (seeded, transaction-rollback)',
  () => {
    it(
      'returns owner access for Centurion manager',
      async () => {
        const ctx = await withSeededTestDb((db) =>
          resolveMailboxContext('user-manager', 'transport-centurion', db),
        );
        expect(ctx).toBeDefined();
        expect(ctx.transportEmail).toBe('centurion@legacyhotel.com');
        expect(ctx.accessRole).toBe('owner');
        expect(ctx.userId).toBe('user-manager');
        expect(ctx.activeTransportId).toBe('transport-centurion');
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
      'defaults to first accessible transport when none requested',
      async () => {
        const ctx = await withSeededTestDb((db) =>
          resolveMailboxContext('user-admin', undefined, db),
        );
        expect(ctx.userId).toBe('user-admin');
        expect(ctx.transportEmail).toBe('centurion@legacyhotel.com');
        expect(ctx.accessRole).toBe('admin');
      },
      30000,
    );

    it(
      'rejects unknown user with no accesses as NO_MAILBOX',
      async () => {
        await expect(
          withSeededTestDb((db) =>
            resolveMailboxContext('user-ghost', undefined, db),
          ),
        ).rejects.toBeInstanceOf(MailboxNoAccessError);
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

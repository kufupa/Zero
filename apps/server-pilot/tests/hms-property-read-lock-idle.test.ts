/**
 * Guards the production property-read lock postgres client options.
 * Live Guest Stay holds the advisory lock across HMS login with no SQL;
 * idle_timeout must not drop that connection mid-session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMock = vi.hoisted(() =>
  vi.fn(() => ({
    unsafe: vi.fn(async () => [{ pg_try_advisory_lock: true }]),
    end: vi.fn(async () => undefined),
  })),
);

vi.mock('postgres', () => ({
  default: postgresMock,
}));

describe('createPostgresPropertyReadLock client options', () => {
  beforeEach(() => {
    postgresMock.mockClear();
  });

  it('disables idle_timeout so long HMS login cannot drop the advisory lock', async () => {
    const { createPostgresPropertyReadLock } = await import(
      '../src/hms/property-read-lock.js'
    );
    const lock = createPostgresPropertyReadLock({
      tenantId: 'tenant-lock-idle',
      propertyCode: 'HRCEN',
      databaseUrl: 'postgres://lock-idle-test.invalid/db',
    });

    await lock.withLock(async (connection) => {
      await connection.query('SELECT 1');
      return 'ok';
    });

    expect(postgresMock).toHaveBeenCalledWith(
      'postgres://lock-idle-test.invalid/db',
      expect.objectContaining({
        max: 1,
        idle_timeout: 0,
        connect_timeout: 10,
      }),
    );
  });
});

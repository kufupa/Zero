import { createHash } from 'node:crypto';
import {
  createPropertyReadLock,
  isPropertyReadLockDeadline,
  isPropertyReadLockHeld,
  resolvePropertyReadLockMode,
  PROPERTY_READ_LOCK_DEADLINE_MESSAGE,
  propertyReadLockKey,
  type PropertyReadConnection,
} from '../src/hms/property-read-lock.js';
import { describe, expect, it, vi } from 'vitest';

function connection(): PropertyReadConnection {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ pg_try_advisory_lock: true }] : undefined,
    ),
    close: vi.fn(async () => undefined),
  };
}

describe('U8 property-scoped read lock', () => {
  it('defaults to per-credential mode and supports explicit per-property mode', () => {
    expect(resolvePropertyReadLockMode()).toBe('per-credential');
    expect(resolvePropertyReadLockMode('per-property')).toBe('per-property');
    expect(resolvePropertyReadLockMode('per-credential')).toBe('per-credential');
    expect(() => resolvePropertyReadLockMode('anything-else')).toThrow(
      'property_read_lock_mode_invalid',
    );

    const centurion = propertyReadLockKey({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'shared-user',
      mode: 'per-property',
    });
    const davinci = propertyReadLockKey({
      tenantId: 'tenant-davinci',
      propertyCode: 'DVIN',
      username: 'shared-user',
      mode: 'per-property',
    });
    expect(centurion).not.toBe(davinci);
  });
  it('preserves legacy advisory key for explicit per-property mode', () => {
    const expected = String(
      createHash('sha256')
        .update('tenant-centurion\0HRCEN', 'utf8')
        .digest()
        .readInt32BE(0),
    );
    expect(
      propertyReadLockKey({
        tenantId: 'tenant-centurion',
        propertyCode: 'HRCEN',
        mode: 'per-property',
      }),
    ).toBe(expected);
  });

  it('gives up at the acquisition deadline with an error isPropertyReadLockDeadline recognises, and closes the connection', async () => {
    const handle: PropertyReadConnection = {
      query: vi.fn(async () => [{ pg_try_advisory_lock: false }]),
      close: vi.fn(async () => undefined),
    };
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: async () => handle,
    });
    const failure = await lock.withLock(async () => 'never reached', { deadlineAt: Date.now() + 60 }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(isPropertyReadLockDeadline(failure)).toBe(true);
    expect(isPropertyReadLockDeadline(new Error('some other failure'))).toBe(false);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('recognizes the sanitized deadline cause used by staff quote jobs', () => {
    expect(
      isPropertyReadLockDeadline({
        cause: {
          name: 'Error',
          code: 'HMS_LOCK_BUSY',
          message: PROPERTY_READ_LOCK_DEADLINE_MESSAGE,
        },
      }),
    ).toBe(true);
  });

  it('derives a stable credential advisory key without raw identifiers in output', () => {
    const first = propertyReadLockKey({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'shared-user',
    });
    expect(first).toBe(
      propertyReadLockKey({
        tenantId: 'tenant-davinci',
        propertyCode: 'DVIN',
        username: 'shared-user',
      }),
    );
    expect(first).not.toBe(
      propertyReadLockKey({
        tenantId: 'tenant-centurion',
        propertyCode: 'HRCEN',
        username: 'different-user',
      }),
    );
    expect(first).toMatch(/^-?\d+$/);
    expect(first).not.toContain('tenant-centurion');
    expect(first).not.toContain('HRCEN');
  });

  it('acquires and releases a dedicated connection around one read session', async () => {
    const handle = connection();
    const factory = vi.fn(async () => handle);
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: factory,
    });
    const result = await lock.withLock(async (held) => {
      expect(held).toBe(handle);
      return 'read-result';
    });

    expect(result).toBe('read-result');
    expect(factory).toHaveBeenCalledOnce();
    expect(handle.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'));
    expect(handle.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'));
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('reuses a held per-credential lock for nested entrypoints', async () => {
    const handle = connection();
    const factory = vi.fn(async () => handle);
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'shared-user',
      connectionFactory: factory,
    });

    await lock.withLock(async (outerConnection) => {
      expect(isPropertyReadLockHeld(lock.key)).toBe(true);
      await lock.withLock(async (innerConnection) => {
        expect(innerConnection).toBe(outerConnection);
        expect(isPropertyReadLockHeld(lock.key)).toBe(true);
      });
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(handle.query).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(isPropertyReadLockHeld(lock.key)).toBe(false);
  });

  it('does not run the read callback when lock acquisition fails', async () => {
    const handle = connection();
    handle.query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock') || sql.includes('pg_advisory_lock')) {
        throw Object.assign(new Error('lock lost'), { code: 'LOCK_LOST' });
      }
    });
    const callback = vi.fn();
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: async () => handle,
    });
    await expect(lock.withLock(callback)).rejects.toMatchObject({
      code: 'PROPERTY_READ_LOCK_LOST',
    });
    expect(callback).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('rejects an already-aborted acquisition before opening the read callback', async () => {
    const handle = connection();
    const callback = vi.fn(async () => 'unexpected-read');
    const controller = new AbortController();
    controller.abort(new Error('read deadline expired'));
    const factory = vi.fn(async () => handle);
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: factory,
    });

    await expect(lock.withLock(callback, { signal: controller.signal })).rejects.toBeInstanceOf(
      Error,
    );
    expect(factory).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
  });

  it('bounds cancellation while an independent acquisition is waiting', async () => {
    const handle = connection();
    let markAcquisitionStarted!: () => void;
    let releaseAcquisition = () => undefined;
    const acquisitionStarted = new Promise<void>((resolve) => {
      markAcquisitionStarted = resolve;
      handle.query = vi.fn(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          markAcquisitionStarted();
          return [{ pg_try_advisory_lock: false }];
        }
        if (sql.includes('pg_advisory_lock')) {
          await new Promise<void>((resolveWaiting) => {
            releaseAcquisition = resolveWaiting;
          });
        }
        return undefined;
      });
    });
    const callback = vi.fn(async () => 'unexpected-read');
    const controller = new AbortController();
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: async () => handle,
    });

    const attempt = lock.withLock(callback, { signal: controller.signal });
    await Promise.race([
      acquisitionStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('lock acquisition did not start')), 250),
      ),
    ]);
    controller.abort(new Error('read deadline expired'));
    const outcome = await Promise.race([
      attempt.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 250)),
    ]);

    try {
      expect(outcome).toBe('rejected');
      expect(callback).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    } finally {
      releaseAcquisition();
      await attempt.catch(() => undefined);
    }
  });
});

describe('U23 try-once acquisition', () => {
  it('a background acquisition makes one attempt and reports the deadline at once when the lock is busy', async () => {
    const handle: PropertyReadConnection = {
      query: vi.fn(async () => [{ pg_try_advisory_lock: false }]),
      close: vi.fn(async () => undefined),
    };
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: async () => handle,
    });
    const body = vi.fn(async () => 'never reached');
    const started = Date.now();
    const failure = await lock.withLock(body, { tryOnce: true }).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(isPropertyReadLockDeadline(failure)).toBe(true);
    expect(body).not.toHaveBeenCalled();
    expect(handle.query).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledOnce();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a try-once acquisition still takes a free lock', async () => {
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      username: 'synthetic-user',
      connectionFactory: async () => connection(),
    });
    await expect(lock.withLock(async () => 'read-result', { tryOnce: true })).resolves.toBe(
      'read-result',
    );
  });
});

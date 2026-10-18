import {
  createPropertyReadLock,
  isPropertyReadLockDeadline,
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
  it('gives up at the acquisition deadline with an error isPropertyReadLockDeadline recognises, and closes the connection', async () => {
    const handle: PropertyReadConnection = {
      query: vi.fn(async () => [{ pg_try_advisory_lock: false }]),
      close: vi.fn(async () => undefined),
    };
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
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

  it('derives a stable tenant/property advisory key without raw identifiers in output', () => {
    const first = propertyReadLockKey('tenant-centurion', 'HRCEN');
    expect(first).toBe(propertyReadLockKey('tenant-centurion', 'HRCEN'));
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
      connectionFactory: async () => connection(),
    });
    await expect(lock.withLock(async () => 'read-result', { tryOnce: true })).resolves.toBe(
      'read-result',
    );
  });
});

describe('two hotel slots', () => {
  it('two properties can hold locks at once', async () => {
    const hrcenHeld = deferred();
    const hrdavHeld = deferred();
    const hrcen = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      connectionFactory: async () => connection(),
    });
    const hrdav = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRDAV',
      connectionFactory: async () => connection(),
    });
    const first = hrcen.withLock(async () => {
      hrcenHeld.resolve();
      await hrdavHeld.promise;
      return 'HRCEN';
    });
    const second = hrdav.withLock(async () => {
      hrdavHeld.resolve();
      await hrcenHeld.promise;
      return 'HRDAV';
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['HRCEN', 'HRDAV']);
  });
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

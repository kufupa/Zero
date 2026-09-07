import { describe, expect, it, vi } from 'vitest';
import {
  createPropertyReadLock,
  propertyReadLockKey,
  type PropertyReadConnection,
} from '../src/hms/property-read-lock.js';

function connection(): PropertyReadConnection {
  return {
    query: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('U8 property-scoped read lock', () => {
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
    expect(handle.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_lock'));
    expect(handle.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'));
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('does not run the read callback when lock acquisition fails', async () => {
    const handle = connection();
    handle.query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_lock')) throw Object.assign(new Error('lock lost'), { code: 'LOCK_LOST' });
    });
    const callback = vi.fn();
    const lock = createPropertyReadLock({
      tenantId: 'tenant-centurion',
      propertyCode: 'HRCEN',
      connectionFactory: async () => handle,
    });
    await expect(lock.withLock(callback)).rejects.toMatchObject({ code: 'PROPERTY_READ_LOCK_LOST' });
    expect(callback).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { paneStayCloudTargetLock, paneStayPropertyLock } from '../src/ai/pane-stay-save.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { propertyReadLockKey } from '../src/hms/property-read-lock.js';

afterEach(() => vi.unstubAllEnvs());

describe('independently owned Cloud session locks', () => {
  it('normalizes one target, separates other targets, and retains the native property key', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://synthetic@127.0.0.1:5432/test');
    vi.stubEnv('PANE_STAY_TENANT_ID', 'test');
    const create = { propertyCode: 'HRCEN' as const, kind: 'create' as const,
      firstName: '  Alice  ', lastName: 'EXAMPLE', arrival: '2027-01-01' };
    const owned = { kind: 'independent_cloud' as const };
    const key = (target: typeof create) => (paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, target, owned) as
      unknown as { key: string }).key;
    expect(key(create)).toBe(key({ ...create, firstName: 'alice', lastName: 'example' }));
    expect(key(create)).not.toBe(key({ ...create, firstName: 'Other' }));
    const property = paneStayPropertyLock(CENTURION_HMS_READ_TARGET) as unknown as { key: string };
    expect(property.key).toBe(propertyReadLockKey('test', 'HRCEN'));
    expect(property.key).not.toBe(key(create));
  });

  it('refuses borrowed, missing, wrong-property and invalid target scopes', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://synthetic@127.0.0.1:5432/test');
    const saved = { propertyCode: 'HRCEN' as const, kind: 'saved' as const, confirmation: '123456-1' };
    const owned = { kind: 'independent_cloud' as const };
    expect(paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, saved, { kind: 'borrowed' } as never)).toBeNull();
    expect(paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, saved, undefined as never)).toBeNull();
    expect(paneStayCloudTargetLock(DAVINCI_HMS_READ_TARGET, saved, owned)).toBeNull();
    expect(paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, { ...saved, confirmation: '' }, owned)).toBeNull();
    expect(paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, saved, owned)).toBeNull();
  });

  it('uses the same native session lock for full and native-only saved identities', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://synthetic@127.0.0.1:5432/test');
    vi.stubEnv('PANE_STAY_TENANT_ID', 'test');
    const owned = { kind: 'independent_cloud' as const };
    const full = { propertyCode: 'HRCEN' as const, kind: 'saved' as const, confirmation: '123456-1', nativeStayId: '42' };
    const only = { propertyCode: 'HRCEN' as const, kind: 'saved' as const, nativeStayId: '00042' };
    const first = paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, full, owned) as unknown as { key: string };
    const second = paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, only, owned) as unknown as { key: string };
    expect(first.key).toBe(second.key);
    expect(first.key).not.toBe((paneStayCloudTargetLock(CENTURION_HMS_READ_TARGET, { ...only, nativeStayId: '43' }, owned) as
      unknown as { key: string }).key);
  });
});

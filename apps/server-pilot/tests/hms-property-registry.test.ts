import { describe, expect, it } from 'vitest';
import {
  createHmsPropertyRegistry,
  type HmsPropertyRegistration,
} from '../src/hms/property-registry.js';

const centurion: HmsPropertyRegistration = {
  propertyCode: 'HRCEN',
  tenantId: 'HMS_LEGACY',
  username: 'shared-hms-user',
  mailboxTransportId: 'transport-centurion',
  hmsBaseUrl: 'https://appsrv-1.legacyhotels.co.za',
  credentialSecretRef: 'hms/centurion/read-only',
};

describe('HMS property registry', () => {
  it('resolves the configured HRCEN identity without changing its bindings', () => {
    const registry = createHmsPropertyRegistry([centurion]);

    expect(registry.resolve('HRCEN')).toEqual(centurion);
    expect(registry.list()).toEqual([centurion]);
  });

  it('rejects duplicate property codes and mailbox routes', () => {
    expect(() => createHmsPropertyRegistry([centurion, { ...centurion }])).toThrow(
      'hms_property_registry_duplicate_property',
    );
    expect(() =>
      createHmsPropertyRegistry([
        centurion,
        { ...centurion, propertyCode: 'OTHER', credentialSecretRef: 'hms/other/read-only' },
      ]),
    ).toThrow('hms_property_registry_duplicate_mailbox');
    expect(() =>
      createHmsPropertyRegistry([
        centurion,
        {
          ...centurion,
          propertyCode: 'OTHER',
          mailboxTransportId: 'transport-other',
        },
      ]),
    ).toThrow('hms_property_registry_duplicate_secret');
  });

  it('rejects incomplete entries and unknown property lookups', () => {
    expect(() =>
      createHmsPropertyRegistry([{ ...centurion, username: ' ' }]),
    ).toThrow('hms_property_registry_invalid_entry');
    expect(() =>
      createHmsPropertyRegistry([{ ...centurion, hmsBaseUrl: 'not-a-url' }]),
    ).toThrow('hms_property_registry_invalid_origin');
    expect(() => createHmsPropertyRegistry([{ ...centurion, tenantId: ' ' }])).toThrow(
      'hms_property_registry_invalid_entry',
    );
    expect(() => createHmsPropertyRegistry([centurion]).resolve('UNKNOWN')).toThrow(
      'hms_property_unknown',
    );
  });
});

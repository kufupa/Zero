import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseStayProperty, profileFor } from '../tooling/hms-cloud/property-profile.mjs';
import { normalizeQuoteRequest } from '../tooling/hms-cloud/quote-contract.mjs';
import {
  PROPERTY_REGISTRY,
  getHmsPropertyRegistration,
  installRegisteredAvailabilityReadOnlyGuard,
  resolvePropertyTransport,
  resolveSecretSource,
  validatePropertyRegistry,
  validateHmsPropertySecret,
} from '../tooling/hms-cloud/property-registry.mjs';

const DAVINCI_SECRET = {
  loginUrl: 'https://hms.example.invalid',
  username: 'NAVAAI',
  password: 'test-only',
  expectedTenant: 'DAVINCI_PRD',
  expectedPropertyCode: 'HRDAV',
  expectedPropertyName: 'Davinci Hotel',
  mailboxTransportId: 'transport-davinci',
  mailboxTransportIds: ['transport-davinci', 'transport-faith', 'transport-ayanda', 'transport-epick', 'transport-kmgidi'],
  credentialMode: 'view_only',
};

describe('read-only HMS property registry', () => {
  it('requires an explicit CLI property and reads profiles through the registry', () => {
    expect(parseStayProperty(['--mode', 'preview'])).toEqual({
      ok: false,
      exitCode: 2,
      error: 'PROPERTY_REQUIRED',
    });
    expect(parseStayProperty(['--property', 'HRDAV', '--mode', 'preview'])).toEqual({
      ok: true,
      propertyCode: 'HRDAV',
      rest: ['--mode', 'preview'],
    });
    expect(profileFor('HRCEN')?.propertyCode).toBe('HRCEN');
    expect(profileFor('HRDAV')?.propertyCode).toBe('HRDAV');
    expect(profileFor('NOTAPROP')).toBeNull();
  });

  it('resolves every hotel mailbox to its property and transport-nava to a no-hotel collector', () => {
    for (const [transportId, propertyCode] of [
      ['transport-centurion', 'HRCEN'],
      ['transport-davinci', 'HRDAV'],
      ['transport-faith', 'HRDAV'],
      ['transport-ayanda', 'HRDAV'],
      ['transport-epick', 'HRDAV'],
      ['transport-kmgidi', 'HRDAV'],
    ]) {
      expect(resolvePropertyTransport(transportId)).toMatchObject({
        kind: 'property',
        transportId,
        property: { propertyCode },
      });
    }
    expect(resolvePropertyTransport('transport-nava')).toEqual({
      kind: 'collector',
      transportId: 'transport-nava',
    });
  });

  it('returns typed unknown/inactive refusals and rejects a transport assigned to two properties', () => {
    expect(resolvePropertyTransport('')).toMatchObject({ kind: 'refusal', code: 'property_unknown' });
    expect(resolvePropertyTransport('transport-unknown')).toMatchObject({
      kind: 'refusal',
      code: 'property_unknown',
    });

    const centurion = PROPERTY_REGISTRY.properties.find((property) => property.propertyCode === 'HRCEN')!;
    const davinci = PROPERTY_REGISTRY.properties.find((property) => property.propertyCode === 'HRDAV')!;
    const inactiveRegistry = {
      properties: [{
        ...centurion,
        active: false,
        transportIds: ['transport-retired'],
        mailboxTransportId: 'transport-retired',
      }],
      collectorTransportIds: [],
    };
    expect(resolvePropertyTransport('transport-retired', inactiveRegistry)).toMatchObject({
      kind: 'refusal',
      code: 'property_inactive',
    });

    const duplicateRegistry = {
      properties: [
        { ...centurion, transportIds: ['transport-shared'], mailboxTransportId: 'transport-shared' },
        { ...davinci, transportIds: ['transport-shared'], mailboxTransportId: 'transport-shared' },
      ],
      collectorTransportIds: [],
    };
    expect(() => validatePropertyRegistry(duplicateRegistry)).toThrow('hms_property_duplicate_transport');
  });

  it('resolves transport-davinci to HRDAV and the Da Vinci read secret', () => {
    const property = getHmsPropertyRegistration('transport-davinci');
    expect(Object.isFrozen(property)).toBe(true);
    expect(property).toMatchObject({
      transportId: 'transport-davinci',
      propertyCode: 'HRDAV',
      expectedTenant: 'DAVINCI_PRD',
      expectedPropertyName: 'Davinci Hotel',
      username: 'NAVAAI',
      mailboxTransportId: 'transport-davinci',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
      credentialUse: 'shared',
    });
    expect(resolveSecretSource({ HMS_PROPERTY_TRANSPORT_ID: 'transport-davinci' })).toMatchObject({
      source: 'aws',
      secretId: 'nava-zero/server-pilot/infor-hms-read-davinci',
    });
  });

  it('keeps Centurion HRCEN secret resolution unchanged unless a property transport is explicit', () => {
    expect(getHmsPropertyRegistration('transport-centurion')).toMatchObject({
      propertyCode: 'HRCEN',
      expectedTenant: 'THECENTURION_PRD',
      mailboxTransportId: 'transport-centurion',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read',
    });
    expect(
      resolveSecretSource({ HMS_PROPERTY_TRANSPORT_ID: 'transport-centurion' }),
    ).toMatchObject({ secretId: 'nava-zero/server-pilot/infor-hms-read' });
    expect(
      resolveSecretSource({ HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read' }),
    ).toEqual({ source: 'aws', secretId: 'nava-zero/server-pilot/infor-hms-read', property: null });
    expect(
      resolveSecretSource({
        HMS_QUOTE_SECRET_PATH: '/private/centurion.json',
        HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
      }),
    ).toEqual({ source: 'file', path: '/private/centurion.json', property: null });
  });

  it.each(['view_only', 'audited_write', 'write_capable'] as const)(
    'accepts a Centurion shared secret in %s mode without relaxing its identity',
    (credentialMode) => {
      const centurion = getHmsPropertyRegistration('transport-centurion');
      const secret = {
        ...DAVINCI_SECRET,
        expectedTenant: 'THECENTURION_PRD',
        expectedPropertyCode: 'HRCEN',
        expectedPropertyName: 'Centurion Hotel',
        mailboxTransportId: 'transport-centurion',
        mailboxTransportIds: undefined,
        credentialMode,
      };
      expect(validateHmsPropertySecret(centurion, secret)).toEqual(secret);
      expect(() => validateHmsPropertySecret(centurion, { ...secret, username: 'OTHER' }))
        .toThrow('hms_property_credential_mismatch');
      expect(() => validateHmsPropertySecret(centurion, { ...secret, expectedTenant: 'DAVINCI_PRD' }))
        .toThrow('hms_property_credential_mismatch');
    },
  );

  it('rejects a Da Vinci secret bound to the Centurion property code', () => {
    const davinci = getHmsPropertyRegistration('transport-davinci');
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, expectedPropertyCode: 'HRCEN' }),
    ).toThrow('hms_property_credential_mismatch');
  });

  it('fails closed for unknown transports, conflicting secret sources, or an invalid credential mode', () => {
    expect(() => getHmsPropertyRegistration('transport-unknown')).toThrow('hms_property_unknown');
    expect(() =>
      resolveSecretSource({
        HMS_PROPERTY_TRANSPORT_ID: 'transport-davinci',
        HMS_QUOTE_SECRET_PATH: '/private/centurion.json',
      }),
    ).toThrow('hms_property_credential_source_conflict');
    expect(() =>
      resolveSecretSource({
        HMS_PROPERTY_TRANSPORT_ID: 'transport-davinci',
        HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
      }),
    ).toThrow('hms_property_credential_source_conflict');

    const davinci = getHmsPropertyRegistration('transport-davinci');
    expect(validateHmsPropertySecret(davinci, DAVINCI_SECRET)).toEqual(DAVINCI_SECRET);
    expect(validateHmsPropertySecret(getHmsPropertyRegistration('transport-faith'), DAVINCI_SECRET)).toEqual(DAVINCI_SECRET);
    expect(validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, mailboxTransportIds: undefined }))
      .toMatchObject({ mailboxTransportId: 'transport-davinci' });
    expect(() => validateHmsPropertySecret(getHmsPropertyRegistration('transport-faith'),
      { ...DAVINCI_SECRET, mailboxTransportIds: undefined })).toThrow('hms_property_credential_mismatch');
    expect(validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, credentialMode: 'write_capable' }))
      .toMatchObject({ credentialMode: 'write_capable' });
    expect(validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, credentialMode: 'audited_write' }))
      .toMatchObject({ credentialMode: 'audited_write' });
    expect(() => validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, credentialMode: 'invalid' }))
      .toThrow('hms_property_credential_mismatch');
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, expectedTenant: 'THECENTURION_PRD' }),
    ).toThrow('hms_property_credential_mismatch');
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, mailboxTransportId: 'transport-centurion' }),
    ).toThrow('hms_property_credential_mismatch');
  });

  it('allows only the availability search POST and aborts other HRDAV writes', async () => {
    let handleRoute:
      | ((route: {
          request: () => { method: () => string; url: () => string };
          abort: () => Promise<void>;
          continue: () => Promise<void>;
        }) => Promise<void>)
      | undefined;
    const context = {
      route: vi.fn(async (_pattern: string, handler: typeof handleRoute) => {
        handleRoute = handler;
      }),
    };
    await installRegisteredAvailabilityReadOnlyGuard(
      context,
      'transport-davinci',
      'https://hms.example.invalid',
    );
    expect(context.route).toHaveBeenCalledOnce();

    const action = async (method: string, url: string) => {
      const result: { value: 'abort' | 'continue' | null } = { value: null };
      await handleRoute?.({
        request: () => ({ method: () => method, url: () => url }),
        abort: async () => { result.value = 'abort'; },
        continue: async () => { result.value = 'continue'; },
      });
      return result.value;
    };

    expect(
      await action('POST', 'https://hms.example.invalid/api/internalBooking/hotelAvail/inquiryForGrid'),
    ).toBe('continue');
    expect(await action('GET', 'https://hms.example.invalid/api/reservation/list')).toBe('continue');
    expect(
      await action('POST', 'https://other.example.invalid/api/internalBooking/hotelAvail/inquiryForGrid'),
    ).toBe('abort');
    expect(await action('POST', 'https://hms.example.invalid/api/unknown')).toBe('abort');
    expect(await action('POST', 'https://hms.example.invalid/api/reservation/create')).toBe('abort');
    expect(await action('POST', 'https://hms.example.invalid/api/reservation/save')).toBe('abort');
    expect(await action('PUT', 'https://hms.example.invalid/api/reservation/update')).toBe('abort');
    expect(await action('PATCH', 'https://hms.example.invalid/api/reservation/update')).toBe('abort');
    expect(await action('DELETE', 'https://hms.example.invalid/api/reservation/1')).toBe('abort');
  });

  it('provides one valid HRDAV availability request for the coordinator proof command', () => {
    const request = JSON.parse(
      readFileSync(new URL('../tooling/hms-cloud/examples/davinci-availability.json', import.meta.url), 'utf8'),
    ) as unknown;
    const normalized = normalizeQuoteRequest(request);
    expect(normalized).toMatchObject({
      ok: true,
      request: {
        propertyCode: 'HRDAV',
        details: 'summary',
        arrivalDate: '2026-10-26',
        departureDate: '2026-10-27',
      },
    });
  });
});

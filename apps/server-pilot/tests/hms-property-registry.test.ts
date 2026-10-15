import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeQuoteRequest } from '../tooling/playwright-quote/quote-contract.mjs';
import {
  getHmsPropertyRegistration,
  installRegisteredAvailabilityReadOnlyGuard,
  resolveSecretSource,
  validateHmsPropertySecret,
} from '../tooling/playwright-quote/property-registry.mjs';

const DAVINCI_SECRET = {
  loginUrl: 'https://hms.example.invalid',
  username: 'NAVAAI',
  password: 'test-only',
  expectedTenant: 'HMS_DAVINCI',
  expectedPropertyCode: 'HRDAV',
  expectedPropertyName: 'Davinci Hotel',
  mailboxTransportId: 'transport-davinci',
  credentialMode: 'view_only',
};

describe('read-only HMS property registry', () => {
  it('resolves transport-davinci to HRDAV and the Da Vinci read secret', () => {
    const property = getHmsPropertyRegistration('transport-davinci');
    expect(Object.isFrozen(property)).toBe(true);
    expect(property).toMatchObject({
      transportId: 'transport-davinci',
      propertyCode: 'HRDAV',
      expectedTenant: 'HMS_DAVINCI',
      expectedPropertyName: 'Davinci Hotel',
      username: 'NAVAAI',
      mailboxTransportId: 'transport-davinci',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
      credentialMode: 'view_only',
    });
    expect(resolveSecretSource({ HMS_PROPERTY_TRANSPORT_ID: 'transport-davinci' })).toMatchObject({
      source: 'aws',
      secretId: 'nava-zero/server-pilot/infor-hms-read-davinci',
    });
  });

  it('keeps Centurion HRCEN secret resolution unchanged unless a property transport is explicit', () => {
    expect(getHmsPropertyRegistration('transport-centurion')).toMatchObject({
      propertyCode: 'HRCEN',
      expectedTenant: 'HMS_LEGACY',
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

  it('rejects a Da Vinci secret bound to the Centurion property code', () => {
    const davinci = getHmsPropertyRegistration('transport-davinci');
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, expectedPropertyCode: 'HRCEN' }),
    ).toThrow('hms_property_credential_mismatch');
  });

  it('fails closed for unknown transports, conflicting secret sources, or a non-view-only secret', () => {
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
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, credentialMode: 'write_capable' }),
    ).toThrow('hms_property_credential_mismatch');
    expect(() =>
      validateHmsPropertySecret(davinci, { ...DAVINCI_SECRET, expectedTenant: 'HMS_LEGACY' }),
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
      readFileSync(new URL('../tooling/playwright-quote/examples/davinci-availability.json', import.meta.url), 'utf8'),
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

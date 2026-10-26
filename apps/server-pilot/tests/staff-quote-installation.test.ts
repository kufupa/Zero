import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CENTURION_DINNER_ADD_ON,
  readInstalledStaffQuoteConfiguration,
  resolveStaffQuoteRatePolicyPath,
  validateStaffQuoteInstallationConfiguration,
} from '../src/ai/staff-quote-installation.js';
import { DAVINCI_STAFF_TRANSPORT_IDS } from '../src/hms/hms-read-target.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const privateRoot = resolve(repo, '.private');

function configuration(propertyCode: string, dinnerAddOn?: unknown) {
  return {
    tenantId: 'test-tenant',
    owner: {
      cdpUrl: 'http://127.0.0.1:8765',
      browserOwnership: 'borrowed',
      propertyCode,
      secretPath: resolve(repo, 'private-secret'),
    },
    outputDir: resolve(privateRoot, 'playwright-quote', 'test-output'),
    ratePolicyConfigurationPath: resolve(privateRoot, 'rate-policy.json'),
    ...(dinnerAddOn !== undefined ? { dinnerAddOn } : {}),
  };
}

describe('staff quote installation defaults', () => {
  it('defaults Centurion dinner to an editable R350 per person per night', () => {
    const installed = validateStaffQuoteInstallationConfiguration(configuration('HRCEN'));

    expect(installed.dinnerAddOn).toEqual({
      amountMinor: 35_000,
      unit: 'per_person_per_night',
      label: 'Dinner Allowance',
    });
  });

  it('leaves generic installations unpriced and preserves an explicit hotel price', () => {
    const generic = validateStaffQuoteInstallationConfiguration(configuration('OTHER'));
    const davinci = validateStaffQuoteInstallationConfiguration(configuration('HRDAV'));
    const explicit = validateStaffQuoteInstallationConfiguration(
      configuration('HRCEN', {
        amountMinor: 40_000,
        unit: 'per_person',
        label: 'Staff configured',
      }),
    );

    expect(generic.dinnerAddOn).toBeUndefined();
    expect(davinci.dinnerAddOn).toBeUndefined();
    expect(explicit.dinnerAddOn).toEqual({
      amountMinor: 40_000,
      unit: 'per_person',
      label: 'Staff configured',
    });
  });

  it('returns a fresh dinner default so mutating one result does not change the next', () => {
    expect(Object.isFrozen(CENTURION_DINNER_ADD_ON)).toBe(true);
    const first = validateStaffQuoteInstallationConfiguration(configuration('HRCEN'));
    expect(first.dinnerAddOn).toBeDefined();
    first.dinnerAddOn!.amountMinor = 1;
    const second = validateStaffQuoteInstallationConfiguration(configuration('HRCEN'));

    expect(second.dinnerAddOn).toEqual({
      amountMinor: 35_000,
      unit: 'per_person_per_night',
      label: 'Dinner Allowance',
    });
    expect(CENTURION_DINNER_ADD_ON.amountMinor).toBe(35_000);
  });
});

describe('readInstalledStaffQuoteConfiguration property install', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses HRDAV when its install file is missing and never reads Centurion', () => {
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION', '/tmp/centurion-quote.json');
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '');
    expect(() => readInstalledStaffQuoteConfiguration('HRDAV')).toThrow(
      'staff_quote_installation_unavailable',
    );
  });

  it('keeps HRCEN and an omitted property on the Centurion env', () => {
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION', '');
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV', '/tmp/hrdav-quote.json');
    expect(() => readInstalledStaffQuoteConfiguration()).toThrow(
      'staff_quote_installation_unavailable',
    );
    expect(() => readInstalledStaffQuoteConfiguration('HRCEN')).toThrow(
      'staff_quote_installation_unavailable',
    );
  });

  it('names a non-Centurion install from the property code, not an HRDAV-only branch', () => {
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION', '/tmp/centurion-quote.json');
    vi.stubEnv('RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRBAK', '');
    expect(() => readInstalledStaffQuoteConfiguration('HRBAK')).toThrow(
      'staff_quote_installation_unavailable',
    );
  });
});

describe('staff quote rate policy by transport', () => {
  it('transport selects its matching policy and never falls back to Centurion', () => {
    const centurionPolicy = resolve(privateRoot, 'centurion-rate-policy.json');
    const byOwnerRef = Object.fromEntries(
      DAVINCI_STAFF_TRANSPORT_IDS.map((ownerRef) => [
        ownerRef,
        resolve(privateRoot, `hrdav-rate-policy-${ownerRef}.json`),
      ]),
    );
    const hrdav = validateStaffQuoteInstallationConfiguration({
      ...configuration('HRDAV'),
      ratePolicyConfigurationPath: centurionPolicy,
      ratePolicyByOwnerRef: byOwnerRef,
    });
    const hrcen = validateStaffQuoteInstallationConfiguration(configuration('HRCEN'));

    for (const ownerRef of DAVINCI_STAFF_TRANSPORT_IDS) {
      expect(resolveStaffQuoteRatePolicyPath(hrdav, ownerRef)).toBe(byOwnerRef[ownerRef]);
      expect(resolveStaffQuoteRatePolicyPath(hrdav, ownerRef)).not.toBe(centurionPolicy);
    }
    expect(() => resolveStaffQuoteRatePolicyPath(hrdav, 'transport-centurion')).toThrow(
      'staff_quote_policy_scope_invalid',
    );
    expect(() => resolveStaffQuoteRatePolicyPath(hrdav, 'transport-unknown')).toThrow(
      'staff_quote_policy_scope_invalid',
    );
    expect(() =>
      resolveStaffQuoteRatePolicyPath(
        validateStaffQuoteInstallationConfiguration(configuration('HRDAV')),
        'transport-faith',
      ),
    ).toThrow('staff_quote_policy_scope_invalid');
    expect(resolveStaffQuoteRatePolicyPath(hrcen, 'transport-centurion')).toBe(
      hrcen.ratePolicyConfigurationPath,
    );
    expect(() => resolveStaffQuoteRatePolicyPath(hrcen, 'transport-faith')).toThrow(
      'staff_quote_policy_scope_invalid',
    );
  });
});

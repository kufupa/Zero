import { describe, expect, it } from 'vitest';
import {
  quotePaneConfigForProperty,
  quoteSalesStrategiesFromRegistry,
  type QuoteSalesStrategy,
} from '../src/hms/rate-catalogue.js';
import { profileFor } from '../tooling/playwright-quote/property-profile.mjs';
import { PROPERTY_REGISTRY } from '../tooling/playwright-quote/property-registry.mjs';

function expectedStrategies(raw: unknown): QuoteSalesStrategy[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const strategies: QuoteSalesStrategy[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const row = candidate as { value?: unknown; display?: unknown };
    const code = typeof row.value === 'string' ? row.value.trim().toUpperCase() : '';
    const label = typeof row.display === 'string' ? row.display.trim() : '';
    if (!code || seen.has(code) || !label) continue;
    seen.add(code);
    const safeCode = code as QuoteSalesStrategy['code'];
    strategies.push({
      code: safeCode,
      label,
      requestValue: safeCode === 'GOV' ? 'Government' : safeCode,
    });
  }
  return strategies.sort((left, right) => Number(right.code === 'BAR') - Number(left.code === 'BAR'));
}

describe('rate catalogue strategies from property profiles', () => {
  it('loads each registered profile’s exact strategies and fails closed for an unknown profile', async () => {
    const registered = PROPERTY_REGISTRY.properties.filter(
      (property) => property.active && property.profileFile,
    );
    expect(registered.length).toBeGreaterThan(0);

    for (const property of registered) {
      const profile = profileFor(property.propertyCode) as {
        propertyCode: string;
        salesStrategies?: unknown;
      } | null;
      expect(profile?.propertyCode).toBe(property.propertyCode);
      const expected = expectedStrategies(profile?.salesStrategies);
      expect(expected.length, `${property.propertyCode} has configured strategies`).toBeGreaterThan(0);

      expect(quoteSalesStrategiesFromRegistry(property.propertyCode, profile?.salesStrategies)).toEqual(
        expected,
      );
      expect(quoteSalesStrategiesFromRegistry(property.propertyCode, null)).toEqual(expected);

      const pane = await quotePaneConfigForProperty(
        property.propertyCode,
        property.mailboxTransportId,
      );
      expect(pane?.salesStrategies).toEqual(expected);
    }

    expect(profileFor('NOTAPROP')).toBeNull();
    expect(quoteSalesStrategiesFromRegistry('NOTAPROP', null)).toEqual([]);
    expect(
      quoteSalesStrategiesFromRegistry('NOTAPROP', [{ value: 'BAR', display: 'BAR' }]),
    ).toEqual([]);
    await expect(quotePaneConfigForProperty('NOTAPROP', 'transport-unknown')).resolves.toBeNull();
  });
});

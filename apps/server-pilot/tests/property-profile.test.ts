import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  getProfileBoards,
  getProfileLetter,
  getProfileRates,
  profileFor,
  validateProfile,
} from '../tooling/playwright-quote/property-profile.mjs';

const hrcenUrl = new URL('../tooling/playwright-quote/property-profiles/HRCEN.json', import.meta.url);

it('loads rates, boards and letter for both hotels and throws for an unknown property', () => {
  const hrcen = profileFor('HRCEN');
  const hrdav = profileFor('HRDAV');
  expect(hrcen).not.toBeNull();
  expect(hrdav).not.toBeNull();
  expect(getProfileRates('HRCEN').public).toEqual(['BAR', 'BARRO', 'WAL']);
  expect(hrcen!.classifyRate('BAR', 'BAR', false)).toBe('public');
  expect(hrcen!.classifyRate('NGOVB', 'GOV', false, 'Local Government Rate Breakfast')).toBe(
    'government',
  );
  expect(hrcen!.classifyRate('ZZZUNK', 'BAR', false)).toBe('unknown');
  expect(getProfileBoards('HRCEN')['bed & breakfast r']).toBe('breakfast');
  expect(getProfileLetter('HRCEN').hotel.source).toMatch(/The Centurion Hotel/);
  expect(hrcen!.cancellation).toBeUndefined();

  expect(getProfileRates('HRDAV').public).toEqual(['BAR', 'BARRO', 'WAL']);
  expect(getProfileRates('HRDAV').strategies?.WS?.plans).toContain('BWS1B');
  expect(getProfileRates('HRDAV').strategies?.WS?.scope).toBe('agency');
  expect(hrdav!.classifyRate('BWS1B', 'WS', false)).toBe('contextual');
  expect(getProfileBoards('HRDAV')['bed & breakfast nr']).toBe('breakfast');
  expect(getProfileLetter('HRDAV').hotel.source).toMatch(/Da \?Vinci Hotel/);
  expect(hrdav!.cancellation?.noticeHours).toBe(48);

  expect(() => getProfileRates('NOTAPROP')).toThrow(/property_profile_unknown/);
  expect(() => getProfileRates(undefined as unknown as string)).toThrow(/property_profile_unknown/);
});

it('rejects a letter regex that does not compile', async () => {
  const raw = JSON.parse(await readFile(hrcenUrl, 'utf8')) as Record<string, unknown>;
  raw.letter = { hotel: '[', confirmation: '/The Centurion Hotel/' };
  expect(() => validateProfile(raw, 'HRCEN')).toThrow(/not a valid regular expression/);
});

it('classifies a public-scoped strategy plan as public', async () => {
  const raw = JSON.parse(await readFile(hrcenUrl, 'utf8')) as {
    rates: { strategies?: Record<string, { plans: string[]; scope: string }> };
  };
  raw.rates.strategies = { PROMO: { plans: ['BWKPB'], scope: 'public' } };
  const profile = validateProfile(raw, 'HRCEN');
  expect(profile.classifyRate('BWKPB', 'PROMO', false)).toBe('public');
});

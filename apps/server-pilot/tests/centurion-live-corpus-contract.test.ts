// apps/server-pilot/tests/centurion-live-corpus-contract.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, 'fixtures/centurion-live');
const DENYLIST = [
  'Frielingdorf',
  'Trip.com.na',
  'bestytravel',
  'tirisano-travel',
  '542997',
  'Klaus Frielingdorf',
  'Tshidiso Moloko',
  'Nelda Coetzee',
];

describe('centurion-live corpus', () => {
  it('has manifest covering all primary categories + urgent + hotel_sent', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    const cats = new Set(manifest.cases.filter((c: { kind: string }) => c.kind === 'guest').map((c: { expectedCategory: string }) => c.expectedCategory));
    for (const need of ['spam', 'individual', 'group', 'travel-agents', 'internal']) {
      expect(cats.has(need)).toBe(true);
    }
    expect(manifest.cases.some((c: { expectedUrgent: boolean }) => c.expectedUrgent)).toBe(true);
    expect(manifest.cases.some((c: { kind: string }) => c.kind === 'hotel_sent')).toBe(true);
  });

  it('every eml is stamped and denylist-clean; dates are 2026-07-ish', () => {
    const files = readdirSync(ROOT).filter((f) => f.endsWith('.eml'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const raw = readFileSync(join(ROOT, file), 'utf8');
      expect(raw).toMatch(/X-Zero-Mailbox:\s*centurion@legacyhotel\.com/i);
      for (const bad of DENYLIST) {
        expect(raw.toLowerCase().includes(bad.toLowerCase())).toBe(false);
      }
      expect(raw).toMatch(/2026/);
    }
  });
});

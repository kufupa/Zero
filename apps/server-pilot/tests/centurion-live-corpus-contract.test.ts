// apps/server-pilot/tests/centurion-live-corpus-contract.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/** ISO month, RFC2822 month, or DD/MM/YYYY with July 2026 */
const JULY_2026_DATE = /(?:2026-07|Jul(?:y)? 2026|\d{2}\/07\/2026)/i;

function loadManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
}

function listEmlFiles() {
  return readdirSync(ROOT)
    .filter((f) => f.endsWith('.eml'))
    .sort();
}

describe('centurion-live corpus', () => {
  it('has manifest covering all primary categories + urgent + hotel_sent', () => {
    const manifest = loadManifest();
    expect(manifest.version).toBe(1);
    const cats = new Set(manifest.cases.filter((c: { kind: string }) => c.kind === 'guest').map((c: { expectedCategory: string }) => c.expectedCategory));
    for (const need of ['spam', 'new-bookings', 'groups-events', 'ops', 'at-risk']) {
      expect(cats.has(need)).toBe(true);
    }
    expect(manifest.cases.some((c: { expectedUrgent: boolean }) => c.expectedUrgent)).toBe(true);
    expect(manifest.cases.some((c: { kind: string }) => c.kind === 'hotel_sent')).toBe(true);
  });

  it('manifest lists every eml on disk and vice versa', () => {
    const manifest = loadManifest();
    const manifestFiles = manifest.cases.map((c: { file: string }) => c.file).sort();
    const diskFiles = listEmlFiles();

    for (const file of manifestFiles) {
      expect(existsSync(join(ROOT, file)), `missing fixture: ${file}`).toBe(true);
    }

    const manifestSet = new Set(manifestFiles);
    const orphans = diskFiles.filter((f) => !manifestSet.has(f));
    expect(orphans, `orphan .eml files not in manifest: ${orphans.join(', ')}`).toEqual([]);
    expect(manifestFiles).toEqual(diskFiles);
  });

  it('every eml is stamped and denylist-clean; dates are July 2026', () => {
    const files = listEmlFiles();
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const file of files) {
      const raw = readFileSync(join(ROOT, file), 'utf8');
      expect(raw).toMatch(/X-Zero-Mailbox:\s*centurion@legacyhotel\.com/i);
      for (const bad of DENYLIST) {
        expect(raw.toLowerCase().includes(bad.toLowerCase())).toBe(false);
      }
      expect(raw, `${file} missing July 2026 date`).toMatch(JULY_2026_DATE);
    }
  });
});

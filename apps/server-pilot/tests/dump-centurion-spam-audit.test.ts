import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Centurion spam audit v6 metrics contract', () => {
  it('reads the canonicalOutput workflow decision instead of legacy category metrics', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../scripts/dump-centurion-spam-audit.mjs'), 'utf8');
    expect(source).toMatch(/metrics->'canonicalOutput'/);
    expect(source).toMatch(/primaryFolder/);
    expect(source).toMatch(/isSpam/);
    expect(source).toMatch(/canonicalOutput/);
  });
});

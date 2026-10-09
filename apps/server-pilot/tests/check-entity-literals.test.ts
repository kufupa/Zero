import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEntityLiterals } from '../scripts/check-entity-literals.mjs';

const EMPTY_BASELINE = { schema: 'entity-literals-baseline-v1', entries: [] };
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'entity-literals-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, text: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('check-entity-literals', () => {
  it('fails a new company literal in src and names the file and line', () => {
    write('src/ai/pricing.ts', "const rate = 1;\nconst partner = 'Woolworths';\n");

    const { violations } = checkEntityLiterals({ root, baseline: EMPTY_BASELINE });

    expect(violations).toEqual([
      "new literal in src/ai/pricing.ts: 'woolworths' x1 (baseline 0) at line 2",
    ]);
  });

  it('allows the same literal under tests/', () => {
    write('src/clean.ts', 'export const rate = 1;\n');
    write('tests/pricing.test.ts', "const partner = 'Woolworths';\n");

    expect(checkEntityLiterals({ root, baseline: EMPTY_BASELINE }).violations).toEqual([]);
  });

  it('matches whole tokens, so a sender domain inside a longer domain counts only as a subdomain', () => {
    write('src/a.ts', "const a = 'mybooking.com';\nconst b = 'property.booking.com';\n");

    const { findings } = checkEntityLiterals({ root, terms: ['booking.com'], baseline: EMPTY_BASELINE });

    expect(findings.map((f) => [f.file, f.term, f.count, f.lines])).toEqual([
      ['src/a.ts', 'booking.com', 1, [2]],
    ]);
  });

  it('counts every occurrence, so a second literal on a baselined line still fails', () => {
    write('src/ai/triage.ts', "const a = 'travelit'; const b = 'travelit';\n");
    const baseline = {
      schema: 'entity-literals-baseline-v1',
      entries: [{ file: 'src/ai/triage.ts', term: 'travelit', count: 1 }],
    };

    const { violations } = checkEntityLiterals({ root, baseline });

    expect(violations).toEqual([
      "new literal in src/ai/triage.ts: 'travelit' x2 (baseline 1) at line 1, 1",
    ]);
  });

  it('lets a baselined literal pass at its recorded count and fails stale entries until lowered', () => {
    write('src/ai/triage.ts', "const a = 'synxis';\nconst b = 'synxis';\n");
    const exact = {
      schema: 'entity-literals-baseline-v1',
      entries: [{ file: 'src/ai/triage.ts', term: 'synxis', count: 2 }],
    };
    expect(checkEntityLiterals({ root, baseline: exact }).violations).toEqual([]);

    const stale = {
      schema: 'entity-literals-baseline-v1',
      entries: [{ file: 'src/ai/triage.ts', term: 'synxis', count: 3 }],
    };
    expect(checkEntityLiterals({ root, baseline: stale }).violations).toEqual([
      "stale baseline in src/ai/triage.ts: 'synxis' baseline 3, found 2; lower it",
    ]);

    rmSync(path.join(root, 'src/ai/triage.ts'));
    expect(checkEntityLiterals({ root, baseline: exact }).violations).toEqual([
      "stale baseline in src/ai/triage.ts: 'synxis' baseline 2, found 0; lower it",
    ]);
  });

  it('passes on the committed server source with the committed baseline', () => {
    const baseline = JSON.parse(
      readFileSync(path.join(SERVER_ROOT, 'scripts', 'entity-literals-baseline.json'), 'utf8'),
    );

    expect(checkEntityLiterals({ root: SERVER_ROOT, baseline }).violations).toEqual([]);
  });
});

#!/usr/bin/env node
/**
 * Blocks new company, agency and sender literals in apps/server-pilot/src (R19, KTD10).
 *
 * Existing offenders are listed in scripts/entity-literals-baseline.json. A literal's count per
 * file may only go down: more occurrences fail as new literals, fewer fail as stale entries until
 * the baseline is lowered. tests/ is not scanned.
 *
 *   node scripts/check-entity-literals.mjs                   check (pnpm check:entities)
 *   node scripts/check-entity-literals.mjs --print-baseline  print the baseline lowered to current counts
 *
 * --print-baseline only shrinks: it drops entries that are gone and lowers counts, but never adds a
 * new file/term pair or raises a count, so it cannot be used to launder a new literal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASELINE_PATH = path.join(SERVER_ROOT, 'scripts', 'entity-literals-baseline.json');

/**
 * Seeds come from what src/ contains today (agency and OTA domain lists in ai/triage.ts,
 * ai/party-aliases.ts, the Centurion sender lists, the seeded approver names) plus the
 * counterparties named in the acceptance examples. Matching is case-insensitive and whole-token:
 * 'booking.com' matches 'property.booking.com' but not 'mybooking.com'. The property's own names
 * (its brand, its mail domain, its HMS host) are tenant identity, not counterparties, so they are
 * not seeds.
 */
export const SEEDS = [
  'booking.com',
  'expedia',
  'expediapartnercentral',
  'profitroom',
  'synxis',
  'webbeds',
  'tbo.com',
  'travelclick',
  'hotelbeds',
  'agoda',
  'erevmax',
  'travelit',
  'reservecloud',
  'hospitality.cloud',
  'nexus',
  'nexustravel',
  'nexct',
  'rennies',
  'renniesbcdtravel',
  'xlturners',
  'xl turners',
  'tourvest',
  'bidvest',
  'cwt',
  'mycwt',
  'destini',
  'atlantiscorporate',
  'planettours',
  '360travel',
  'corporatetraveller',
  'bcdtravel',
  'woolworths',
  'tailormade',
  'new frontiers',
  'pmbobo',
  'kdouglas',
  'kamala',
  'martha',
  'mthembu',
  'seabi',
  'bongi',
  'kolanisi',
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

/** Occurrence groups `{ file, term, count, lines }` for each seed term found under `<root>/src`. */
export function findEntityLiterals({ root = SERVER_ROOT, terms = SEEDS } = {}) {
  const patterns = terms.map((term) => ({
    term,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term)}(?![A-Za-z0-9])`, 'gi'),
  }));
  const groups = [];
  for (const abs of files(path.join(root, 'src'))) {
    const text = readFileSync(abs, 'utf8');
    if (text.includes('\0')) continue;
    const file = path.relative(root, abs).split(path.sep).join('/');
    const lines = text.split('\n');
    for (const { term, re } of patterns) {
      const found = [];
      lines.forEach((line, index) => {
        for (let hit = 0; hit < (line.match(re)?.length ?? 0); hit += 1) found.push(index + 1);
      });
      if (found.length) groups.push({ file, term, count: found.length, lines: found });
    }
  }
  return groups.sort((a, b) => a.file.localeCompare(b.file) || a.term.localeCompare(b.term));
}

/** The baseline lowered to `findings`: gone entries dropped, counts lowered, nothing added or raised. */
export function shrinkBaseline(findings, baseline) {
  const found = new Map(findings.map((f) => [`${f.file}\0${f.term}`, f.count]));
  return {
    schema: 'entity-literals-baseline-v1',
    entries: baseline.entries.flatMap(({ file, term, count }) => {
      const now = Math.min(count, found.get(`${file}\0${term}`) ?? 0);
      return now > 0 ? [{ file, term, count: now }] : [];
    }),
  };
}

/** Compares current occurrences with the baseline; returns `{ findings, violations }`. */
export function checkEntityLiterals({ root = SERVER_ROOT, terms = SEEDS, baseline } = {}) {
  const findings = findEntityLiterals({ root, terms });
  const allowed = new Map(baseline.entries.map((e) => [`${e.file}\0${e.term}`, e.count]));
  const found = new Map(findings.map((f) => [`${f.file}\0${f.term}`, f.count]));
  const violations = [];
  for (const f of findings) {
    const max = allowed.get(`${f.file}\0${f.term}`) ?? 0;
    if (f.count > max) {
      violations.push(
        `new literal in ${f.file}: '${f.term}' x${f.count} (baseline ${max}) at line ${f.lines.join(', ')}`,
      );
    }
  }
  for (const [key, count] of allowed) {
    const now = found.get(key) ?? 0;
    if (now < count) {
      const [file, term] = key.split('\0');
      violations.push(`stale baseline in ${file}: '${term}' baseline ${count}, found ${now}; lower it`);
    }
  }
  return { findings, violations };
}

function main(argv) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(shrinkBaseline(findEntityLiterals(), baseline), null, 2)}\n`);
    return 0;
  }
  const { findings, violations } = checkEntityLiterals({ baseline });
  if (violations.length) {
    for (const violation of violations) console.error(`check:entities ${violation}`);
    console.error(
      `check:entities failed: ${violations.length} violation(s). Use data or config instead of a literal in src/.`,
    );
    return 1;
  }
  console.log(`check:entities ok: ${findings.length} baselined literal groups, ${SEEDS.length} seeds.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

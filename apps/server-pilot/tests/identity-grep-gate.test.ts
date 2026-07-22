import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Built so this file itself never contains the forbidden literal. */
const FORBIDDEN_INGEST = ['nava', '@legacyhotel.com'].join('');
const ALLOWED_DIRS = ['src', 'tests', 'deploy', 'scripts'] as const;
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.sh',
  '.md',
  '.eml',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
  '.env',
  '.conf',
  '.css',
  '.html',
]);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
      continue;
    }
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
    if (TEXT_EXT.has(ext) || name.startsWith('.env')) {
      out.push(full);
    }
  }
  return out;
}

describe('identity grep gate', () => {
  it(`forbids ${FORBIDDEN_INGEST} under src/tests/deploy/scripts`, () => {
    const hits: string[] = [];
    for (const dir of ALLOWED_DIRS) {
      const root = join(packageRoot, dir);
      let files: string[];
      try {
        files = walkFiles(root);
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes(FORBIDDEN_INGEST)) continue;
        const rel = relative(packageRoot, file).replaceAll('\\', '/');
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(FORBIDDEN_INGEST)) {
            hits.push(`${rel}:${i + 1}`);
          }
        }
      }
    }
    expect(hits, `stale ingest identity:\n${hits.join('\n')}`).toEqual([]);
  });
});

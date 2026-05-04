import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const mailRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const BAD_IMPORT =
  /import\s*\{[^}]*\bisFrontendOnlyDemo\b[^}]*\}\s*from\s*['"]@\/lib\/demo\/runtime['"]/;

function stripCommentsForScan(code: string): string {
  const noBlock = code.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function* walkTsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'paraglide' || name === '.react-router') {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (st.isFile() && /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('no old demo-runtime isFrontendOnlyDemo in app code', () => {
  it('UI/hooks/config use mail-mode for isFrontendOnlyDemo', { timeout: 30_000 }, () => {
    for (const file of walkTsFiles(mailRoot)) {
      const rel = relative(mailRoot, file).replace(/\\/g, '/');
      if (rel.startsWith('tests/')) continue;
      if (rel.startsWith('lib/demo/')) continue;

      const src = readFileSync(file, 'utf8');
      if (BAD_IMPORT.test(stripCommentsForScan(src))) {
        expect.fail(
          `${rel}: import isFrontendOnlyDemo from @/lib/demo/runtime — use @/lib/runtime/mail-mode instead`,
        );
      }
    }
  });
});

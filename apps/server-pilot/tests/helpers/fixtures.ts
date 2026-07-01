/** Test fixture helpers. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

export function readFixture(name: string): Buffer {
  return readFileSync(join(fixturesDir, name));
}

export function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('tRPC method override', () => {
  it('enables allowMethodOverride in fetchRequestHandler', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/fetchRequestHandler\s*\(\s*\{[\s\S]*allowMethodOverride:\s*true/);
  });
});

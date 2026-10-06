import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('tRPC method override', () => {
  it('initializes draft artifact adapters before mounting application routes', () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'), 'utf8');
    expect(main).toContain("import { initializeDraftArtifactServices } from './trpc/routes/drafts.js'");
    expect(main.indexOf('initializeDraftArtifactServices();')).toBeLessThan(main.indexOf("app.on(['GET', 'POST'], '/api/trpc/*'"));
    expect(main).toContain("process.env.NODE_ENV !== 'production' || (process.env.S3_BUCKET && process.env.AWS_REGION)");
  });
  it('enables allowMethodOverride in fetchRequestHandler', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');
    expect(main).toMatch(/fetchRequestHandler\s*\(\s*\{[\s\S]*allowMethodOverride:\s*true/);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('EC2 deployment workflow navigation flag', () => {
  it('exports VITE_WORKFLOW_NAV_V6 before the mail build', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../deploy/deploy-ec2.sh'), 'utf8');
    const exportIndex = source.indexOf('export VITE_WORKFLOW_NAV_V6=');
    const buildIndex = source.indexOf('pnpm --filter @zero/mail build');
    expect(exportIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(exportIndex);
    expect(source.slice(exportIndex, buildIndex)).toMatch(
      /VITE_WORKFLOW_NAV_V6="\$\{VITE_WORKFLOW_NAV_V6:-\}"/,
    );
    expect(source.slice(0, buildIndex)).toMatch(/VITE_WORKFLOW_NAV_V6.*WORKFLOW_NAV_V6/);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';

type NavigationModule = typeof import('../../mail/config/navigation.js');
type DemoFolderMapModule = typeof import('../../mail/lib/demo/folder-map.js');
type LiveCategoryNavInput = Parameters<NavigationModule['buildLiveCategoryNavItems']>[0][number];
type NavSection = Parameters<NavigationModule['injectLiveCategoryNavSection']>[0][number];

const here = dirname(fileURLToPath(import.meta.url));
const ACTIVE_INPUTS = [
  join(here, '../../mail/config/navigation.ts'),
  join(here, '../../mail/components/ui/app-sidebar.tsx'),
  join(here, '../../mail/hooks/use-threads.ts'),
  join(here, '../../mail/lib/demo/folder-map.ts'),
  join(here, '../src/env.ts'),
  join(here, '../deploy/deploy-ec2.sh'),
  join(here, '../deploy/write-ec2-env.sh'),
];
const helperPath = join(here, '../deploy/workflow-nav-v6.sh');

describe('workflow navigation rollout removal', () => {
  it('removes the rollout identifiers from active production inputs', () => {
    for (const file of ACTIVE_INPUTS) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /VITE_WORKFLOW_NAV_V6|WORKFLOW_NAV_V6|WorkflowNavEnv|isWorkflowNavV6Enabled/,
      );
      expect(source, file).not.toMatch(/\bworkflowNav\b/);
    }

    const appSidebar = readFileSync(ACTIVE_INPUTS[1], 'utf8');
    expect(appSidebar).not.toContain('sortOrder: category.order');
  });

  it('removes the obsolete resolver helper and keeps the mail build command', () => {
    const deploy = readFileSync(join(here, '../deploy/deploy-ec2.sh'), 'utf8');

    expect(existsSync(helperPath)).toBe(false);
    expect(deploy).toContain('pnpm --filter @zero/mail build');
    expect(deploy).not.toContain('resolve_workflow_nav_v6');
  });

  it('keeps the mode-free navigation and demo folder function signatures', () => {
    expectTypeOf(null as unknown as NavigationModule['buildLiveCategoryNavItems']).parameters.toEqualTypeOf<
      [LiveCategoryNavInput[]]
    >();
    expectTypeOf(null as unknown as NavigationModule['injectLiveCategoryNavSection']).parameters.toEqualTypeOf<
      [NavSection[], LiveCategoryNavInput[]]
    >();
    expectTypeOf(null as unknown as NavigationModule['buildDemoMailFolderNavItems']).parameters.toEqualTypeOf<[]>();
    expectTypeOf(null as unknown as DemoFolderMapModule['getDemoMailFolderDefinition']).parameters.toEqualTypeOf<
      [string]
    >();
    expectTypeOf(null as unknown as DemoFolderMapModule['normalizeDemoMailFolderSlug']).parameters.toEqualTypeOf<
      [string?]
    >();
  });
});

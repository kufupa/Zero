import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const navMainSource = readFileSync(
  new URL('../components/ui/nav-main.tsx', import.meta.url),
  'utf8',
);

describe('mail sidebar section disclosures', () => {
  it('makes named mail sections default-open disclosure controls', () => {
    expect(navMainSource).toContain(
      "const isMailSidebar = !isBottomNav && !pathname.includes('/settings');",
    );
    expect(navMainSource).toMatch(
      /\{items\.map\(\(section\) => \{[\s\S]*?const isCollapsibleSection = isMailSidebar && Boolean\(section\.title\);[\s\S]*?defaultOpen=\{isCollapsibleSection \|\| section\.isActive\}[\s\S]*?<CollapsibleTrigger asChild>[\s\S]*?<ChevronRight[\s\S]*?\{section\.title\}[\s\S]*?<CollapsibleContent>/,
    );
  });

  it('keeps section item links visible in the icon-collapsed sidebar', () => {
    expect(navMainSource).toMatch(
      /isCollapsibleSection && state !== 'collapsed'\s*\?\s*\(\s*<CollapsibleContent>[\s\S]*?sectionItems[\s\S]*?<\/CollapsibleContent>\s*\)\s*:\s*\(\s*sectionItems\s*\)/,
    );
  });
});

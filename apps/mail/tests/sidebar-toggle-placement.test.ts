import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const sidebarToggleSource = readSource('../components/ui/sidebar-toggle.tsx');
const navUserSource = readSource('../components/ui/nav-user.tsx');
const mailSource = readSource('../components/mail/mail.tsx');

describe('sidebar toggle placement', () => {
  it('uses directional chevrons while preserving accessible sidebar state', () => {
    expect(sidebarToggleSource).toMatch(
      /import\s*\{\s*ChevronLeft,\s*ChevronRight\s*\}\s*from\s*['"]\.\.\/icons\/icons['"];/,
    );
    expect(sidebarToggleSource).toContain('const isOpen = isMobile ? openMobile : open;');
    expect(sidebarToggleSource).toContain(
      '<ChevronLeft className="h-3 w-3 dark:fill-iconDark fill-iconLight" />',
    );
    expect(sidebarToggleSource).toContain(
      '<ChevronRight className="h-3 w-3 dark:fill-iconDark fill-iconLight" />',
    );
    expect(sidebarToggleSource).not.toMatch(/PanelLeftClose|PanelLeftOpen/);
    expect(sidebarToggleSource).toContain("const label = isOpen ? 'Hide sidebar' : 'Show sidebar';");
    expect(sidebarToggleSource).toContain('onClick={toggleSidebar}');
    expect(sidebarToggleSource).toContain('aria-expanded={isOpen}');
    expect(sidebarToggleSource).toContain('aria-label={label}');
    expect(sidebarToggleSource).toContain("data-state={isOpen ? 'expanded' : 'collapsed'}");
    expect(sidebarToggleSource).toContain('<span className="sr-only">{label}</span>');
    expect(sidebarToggleSource).toContain('<TooltipContent side="bottom">{label}</TooltipContent>');
  });

  it('places exactly one expanded toggle at the end of NavUser top row', () => {
    const topRowStart = navUserSource.indexOf(
      '<div className="flex w-full items-center justify-between gap-2">',
    );
    const accountRowStart = navUserSource.indexOf(
      '<div className="flex items-start gap-2">',
      topRowStart,
    );
    expect(topRowStart).toBeGreaterThanOrEqual(0);
    expect(accountRowStart).toBeGreaterThan(topRowStart);

    const expandedHeader = navUserSource.slice(topRowStart, accountRowStart);
    expect(expandedHeader.match(/<SidebarToggle\b/g) ?? []).toHaveLength(1);
    expect(expandedHeader.indexOf('<ThreeDots')).toBeGreaterThanOrEqual(0);
    expect(expandedHeader.indexOf('<SidebarToggle')).toBeGreaterThan(
      expandedHeader.indexOf('<ThreeDots'),
    );
    expect(expandedHeader).toMatch(/<SidebarToggle\b[^>]*\/>\s*<\/div>\s*$/);
  });

  it('keeps one collapsed opener below NavUser account avatar', () => {
    const collapsedBranchStart = navUserSource.indexOf("state === 'collapsed' ? (");
    const expandedBranchStart = navUserSource.indexOf(
      '<div className="flex w-full flex-col gap-2">',
      collapsedBranchStart,
    );
    expect(collapsedBranchStart).toBeGreaterThanOrEqual(0);
    expect(expandedBranchStart).toBeGreaterThan(collapsedBranchStart);

    const collapsedBranch = navUserSource.slice(collapsedBranchStart, expandedBranchStart);
    expect(collapsedBranch.match(/<SidebarToggle\b/g) ?? []).toHaveLength(1);
    expect(collapsedBranch.indexOf('<Avatar')).toBeGreaterThanOrEqual(0);
    expect(collapsedBranch.indexOf('<SidebarToggle')).toBeGreaterThan(
      collapsedBranch.indexOf('<Avatar'),
    );
  });

  it('keeps one mobile-only sidebar opener outside desktop mail controls', () => {
    expect(mailSource.match(/<SidebarToggle\b/g) ?? []).toHaveLength(1);
    expect(mailSource).toContain('<SidebarToggle className="h-10 w-10 md:hidden" />');
    expect(mailSource.indexOf('<SidebarToggle')).toBeLessThan(
      mailSource.indexOf('{isWideSplit && !listCollapsed ? ('),
    );
    expect(mailSource).toContain('aria-label="Hide inbox"');
    expect(mailSource).toContain('aria-label="Show inbox"');
  });
});

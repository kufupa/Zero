import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const navMainSource = readFileSync(
  new URL('../components/ui/nav-main.tsx', import.meta.url),
  'utf8',
);

describe('My folders sidebar', () => {
  it('defaults open while retaining its collapse trigger', () => {
    expect(navMainSource).toMatch(
      /<Collapsible\s+defaultOpen=\{true\}\s+className="group\/collapsible flex-col">[\s\S]*?<CollapsibleTrigger asChild>[\s\S]*?MY_FOLDERS_SIDEBAR_TITLE/,
    );
  });
});

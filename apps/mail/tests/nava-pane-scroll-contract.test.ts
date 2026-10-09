import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
// The root layout and the tool's <main> stay in the shell. The first-run screens live in screens/.
const navaPane = join(root, 'components/nava-pane');
const pane = readFileSync(join(navaPane, 'nava-pane.tsx'), 'utf8');
const screens = readdirSync(join(navaPane, 'screens'))
  .map((file) => readFileSync(join(navaPane, 'screens', file), 'utf8'))
  .join('\n');
const css = readFileSync(join(root, 'app/globals.css'), 'utf8');

// Staff saw no scrollbar (2026-10-09): the pane grew with its content (min-h-screen), so its scroll area never
// overflowed and the page scrolled with the body's 0px bar instead.
describe('the Outlook pane scrolls inside itself with a visible bar', () => {
  it('fixes the pane to the window height instead of growing with its content', () => {
    expect(pane).toContain('flex h-screen w-full justify-center overflow-hidden');
    expect(pane).not.toContain('flex min-h-screen w-full justify-center bg-[#f1f3f6] font-[');
    expect(pane).not.toContain('relative flex min-h-screen');
  });

  it('scrolls the tool body and the first-run screens in a visible-bar area', () => {
    expect(pane).toMatch(/<main className="nava-pane-scroll [^"]*overflow-y-auto/);
    expect(`${pane}\n${screens}`.match(/nava-pane-scroll/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('styles that area with a standard, always-visible scrollbar', () => {
    expect(css).toMatch(/\.nava-pane-scroll \{[^}]*scrollbar-width: auto;[^}]*scrollbar-color: #94a3b8 #f1f5f9;/);
  });
});

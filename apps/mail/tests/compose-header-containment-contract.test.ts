import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const emailComposerSource = readFileSync(
  new URL('../components/create/email-composer.tsx', import.meta.url),
  'utf8',
);

describe('reply composer header containment', () => {
  it('allows the To recipient row to surrender space to reply actions', () => {
    const toLabelIndex = emailComposerSource.indexOf('<p className="text-sm font-medium text-[#8C8C8C]">To:</p>');
    expect(toLabelIndex).toBeGreaterThanOrEqual(0);

    const toRowStart = emailComposerSource.lastIndexOf('<div', toLabelIndex);
    const toRowEnd = emailComposerSource.indexOf('>', toRowStart);
    const toRow = emailComposerSource.slice(toRowStart, toRowEnd + 1);

    expect(toRow).toContain('min-w-0');
    expect(toRow).toContain('flex-1');
    expect(toRow).not.toContain('w-full');
  });
});

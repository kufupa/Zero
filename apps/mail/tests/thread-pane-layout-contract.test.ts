import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const threadSource = readFileSync(
  new URL('../components/mail/thread-display.tsx', import.meta.url),
  'utf8',
);
const mailDisplaySource = readFileSync(
  new URL('../components/mail/mail-display.tsx', import.meta.url),
  'utf8',
);
const pillSource = readFileSync(
  new URL('../components/mail/centurion-category-pill.tsx', import.meta.url),
  'utf8',
);
const navMainSource = readFileSync(
  new URL('../components/ui/nav-main.tsx', import.meta.url),
  'utf8',
);
const mailContentSource = readFileSync(
  new URL('../components/mail/mail-content.tsx', import.meta.url),
  'utf8',
);

describe('thread attachments placement', () => {
  it('renders ThreadAttachments once before the message map, not on oldest MailDisplay', () => {
    const mapIndex = threadSource.indexOf('displayMessages.map((message, index)');
    const stripIndex = threadSource.indexOf('<ThreadAttachments attachments=');
    expect(stripIndex).toBeGreaterThan(-1);
    expect(mapIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeLessThan(mapIndex);
    expect(threadSource).not.toContain('isChronologicallyOldest');
    expect(threadSource).not.toContain('threadAttachments={');
    expect(mailDisplaySource).not.toContain('threadAttachments');
  });

  it('MessageList message wrappers advertise min-w-0 for chip scrollports', () => {
    expect(threadSource).toMatch(
      /displayMessages\.map\([\s\S]*?<div key=\{message\.id\} className=\{?["'][^"']*min-w-0/,
    );
  });
});

describe('hotel folder label readability', () => {
  it('pill does not hard-cap at 14ch; keeps max-w-full truncate + title tooltip', () => {
    expect(pillSource).not.toMatch(/max-w-\[14ch\]/);
    expect(pillSource).toMatch(/max-w-full/);
    expect(pillSource).toMatch(/truncate/);
    expect(pillSource).toMatch(/title=\{title\}/);
  });

  it('sidebar folder rows show title only; subtitle stays in tooltip, not a second truncated line', () => {
    // Visible dual-line subtitle block must be gone.
    expect(navMainSource).not.toMatch(
      /\{item\.subtitle \? \(\s*<span[\s\S]*?\{item\.subtitle\}/,
    );
    // Tooltip still concatenates title — subtitle for hover.
    expect(navMainSource).toContain(
      "item.subtitle ? `${item.title} — ${item.subtitle}` : item.title",
    );
  });
});

describe('mail content host containment', () => {
  it('Shadow host advertises min-w-0 max-w-full so nested tables cannot inflate the pane', () => {
    expect(mailContentSource).toMatch(
      /className="[^"]*mail-content[^"]*\bmin-w-0\b[^"]*\bmax-w-full\b/,
    );
  });
});

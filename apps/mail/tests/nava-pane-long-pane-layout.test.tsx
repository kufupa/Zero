import { ContactBlock } from '@/components/nava-pane/blocks/contact-block';
import { Section } from '@/components/nava-pane/pane-ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { compile } from 'tailwindcss';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// H6b (2026-10-10): on a long pane the Contact card shrank to a 1px line. The scroll body is a flex column and the
// card is overflow-hidden, so its automatic minimum height was 0 and it shrank instead of the body scrolling.
// This lays the real shell and cards out in Chromium, with the real Tailwind classes, at the Outlook pane's width.

const require = createRequire(import.meta.url);
const tailwindRoot = dirname(require.resolve('tailwindcss/package.json'));
const pane = readFileSync(join(__dirname, '..', 'components', 'nava-pane', 'nava-pane.tsx'), 'utf8');
const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((path) => existsSync(path));

/** The class of the first element in nava-pane.tsx whose class starts with `start`. */
function paneClass(start: string): string {
  const found = pane.match(new RegExp(`className="(${start}[^"]*)"`))?.[1];
  if (!found) throw new Error(`nava-pane.tsx has no element with class "${start}…"`);
  return found;
}

async function tailwindFor(html: string): Promise<string> {
  const compiler = await compile('@import "tailwindcss";', {
    base: tailwindRoot,
    loadStylesheet: async (id: string, base: string) => {
      const path = id === 'tailwindcss' ? join(tailwindRoot, 'index.css') : join(base, id);
      return { path, base: dirname(path), content: readFileSync(path, 'utf8') };
    },
  });
  const candidates = [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1]!.split(/\s+/));
  return compiler.build(candidates);
}

function LongPane() {
  return (
    <div className={paneClass('flex h-screen ')}>
      <div className={paneClass('shadow-xs relative flex h-full')}>
        <header className="flex h-11 shrink-0 items-center">Nava Reservationist</header>
        <main className={paneClass('nava-pane-scroll ')}>
          <Section title="Selected email">
            <p>Re: Accommodation request</p>
          </Section>
          <ContactBlock contact={null} onEdit={() => undefined} />
          <Section title="Stay details" step={1}>
            <div style={{ height: 900 }}>Two stays, four room rows</div>
          </Section>
          <Section title="Get rates" step={2}>
            <div style={{ height: 600 }}>Rate rows</div>
          </Section>
          <Section title="Reply" step={4}>
            <div style={{ height: 200 }}>Reply body</div>
          </Section>
        </main>
      </div>
    </div>
  );
}

describe('a long pane at the Outlook pane width', () => {
  it.skipIf(!chromiumBinary)('scrolls the body and keeps every card, Contact included, at its full height', async () => {
    const markup = renderToStaticMarkup(<LongPane />);
    const css = await tailwindFor(markup);
    const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`);
      const layout = await page.evaluate(() => {
        const body = document.querySelector('main.nava-pane-scroll') as HTMLElement;
        const cards = Array.from(body.children).map((card) => ({
          title: card.getAttribute('aria-label'),
          height: card.getBoundingClientRect().height,
          content: (card as HTMLElement).scrollHeight,
        }));
        const contact = document.getElementById('quote-contact')!.getBoundingClientRect();
        const inputs = Array.from(document.querySelectorAll('#quote-contact input')).map((input) =>
          input.getBoundingClientRect(),
        );
        return {
          overflow: body.scrollHeight - body.clientHeight,
          cards,
          contactBottom: contact.bottom,
          inputs: inputs.map((box) => ({ height: box.height, bottom: box.bottom })),
        };
      });
      // The pane is long: its body scrolls.
      expect(layout.overflow).toBeGreaterThan(0);
      // No card is squeezed below its content.
      for (const card of layout.cards) expect(card.height, card.title ?? '').toBeGreaterThanOrEqual(card.content);
      // Every contact input is shown inside the card. Company and End client are one read-only "Named in email" line now, so Name, Email and Phone are the inputs.
      expect(layout.inputs).toHaveLength(3);
      for (const input of layout.inputs) {
        expect(input.height).toBeGreaterThan(20);
        expect(input.bottom).toBeLessThanOrEqual(layout.contactBottom);
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});

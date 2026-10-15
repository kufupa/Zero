import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUOTE_SELECTORS } from '../scripts/nava-quote-proof';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, '../../mail/components');
const scripts = join(here, '../scripts');
const quotePanel = readFileSync(
  join(components, 'quote-workflow', 'quote-workflow-panel.tsx'),
  'utf8',
);
const contactBlock = readFileSync(
  join(components, 'nava-pane', 'blocks', 'contact-block.tsx'),
  'utf8',
);
const workflowBadge = readFileSync(
  join(components, 'quote-workflow', 'workflow-badge.tsx'),
  'utf8',
);
const requirementCard = readFileSync(join(components, 'quote-workflow', 'requirement-card.tsx'), 'utf8');
const ae1Proof = readFileSync(join(scripts, 'nava-ae1-rates-proof.ts'), 'utf8');
const ae4Proof = readFileSync(join(scripts, 'nava-ae4-override-proof.ts'), 'utf8');
const browserProofs = readFileSync(join(here, 'nava-proof-drivers-browser.test.ts'), 'utf8');
const ae4FakePane = browserProofs.match(/function ae4Page\([\s\S]*?(?=\nconst ae4Handlers)/)?.[0] ?? '';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const accessibleName = (value: string) =>
  new RegExp(`(?:title|aria-label)\\s*=\\s*["']${escapeRegExp(value)}["']`);

describe('quote proof selectors stay aligned with pane labels', () => {
  it('matches contact, stay, rates, and documents section names in the mail source', () => {
    expect(contactBlock).toMatch(accessibleName(QUOTE_SELECTORS.contactRegion));
    expect(quotePanel).toMatch(accessibleName(QUOTE_SELECTORS.stayRegion));
    expect(quotePanel).toMatch(accessibleName(QUOTE_SELECTORS.ratesRegion));
    expect(quotePanel).toMatch(accessibleName(QUOTE_SELECTORS.docsRegion));
  });

  it('matches the search button names rendered by the quote pane', () => {
    const buttonNames = [
      {
        source: />\s*Search availability\s*<\/SecondaryButton>/,
        name: 'Search availability',
      },
      {
        source: /\{`Search this date range for Stay \$\{stayIndex \+ 1\}`\}/,
        name: 'Search this date range for Stay 1',
      },
      {
        source: /\?\s*`Retry date range for Stay \$\{stayIndex \+ 1\}`/,
        name: 'Retry date range for Stay 1',
      },
    ] as const;

    for (const { source, name } of buttonNames) {
      expect(quotePanel).toMatch(source);
      expect(QUOTE_SELECTORS.searchButton.test(name)).toBe(true);
    }
  });

  it('tracks the read-as data attribute rendered by the workflow badge', () => {
    expect(workflowBadge).toMatch(/data-read-as=\{current\}/);
    expect(QUOTE_SELECTORS.intent).toContain('[data-read-as]');
  });

  it('keeps both live proof drivers on the shared search selector', () => {
    expect(ae1Proof).toContain('name: QUOTE_SEARCH_BUTTON');
    expect(ae4Proof).toContain('name: QUOTE_SEARCH_BUTTON');
  });

  it('keeps AE4 adults and meal-plan selectors aligned with the real stay card', () => {
    expect(requirementCard).toContain('<article aria-label={`Stay ${stayNumber} details`}');
    expect(requirementCard).toContain('aria-label="Meal plan"');
    expect(requirementCard).toContain('aria-label="Room type"');
    expect(requirementCard).toContain('aria-label="Rooms"');
    expect(requirementCard).toContain('label={`Adult guests per room for ${where}`}');
    expect(requirementCard).toContain('aria-label={`Edit adults per room for ${where}`}');
    expect(ae4Proof).toContain('article[aria-label$=" details"]');
    expect(ae4Proof).toContain('select[aria-label="Meal plan"]');
    expect(ae4Proof).toContain('select[aria-label="Room type"]');
    expect(ae4Proof).toContain('input[aria-label="Rooms"]');
    expect(ae4Proof).toContain('Adults per room not set');
    expect(ae4Proof).toContain('READ_ROWS_JS');
    expect(ae4Proof).toContain('fillAdults(');
    expect(ae4Proof).not.toContain('input[aria-label="Adults"]');
    expect(ae4FakePane).not.toContain('aria-label="Adults"');
    expect(ae4FakePane).toContain('aria-label="Meal plan"');
    expect(ae4FakePane).toContain('aria-label="Room type"');
    expect(ae4FakePane).toContain('aria-label="Rooms"');
    expect(ae4FakePane).toContain('aria-label="Edit adults per room for ${where}"');
    expect(ae4FakePane).toContain('aria-label="Adult guests per room for ${where}"');
  });
});

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A dependency-free contract for the standalone, image-locked gallery.
const page = process.argv[2] ?? fileURLToPath(new URL('../docs/superpowers/specs/2026-10-03-hermes-background-gradient-gallery.html', import.meta.url));
const html = readFileSync(page, 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
const catalog = [
  ['arc-bands', 'Arc Bands'], ['aurora', 'Aurora Background'],
  ['cherry-petal', 'Cherry Petal'], ['coral-glow', 'Coral Glow'],
  ['dark-arc-bands', 'Dark Arc Bands'], ['dark-aurora', 'Dark Aurora'],
  ['dark-carbon-spotlight', 'Dark Carbon Spotlight'], ['dark-ember', 'Dark Ember'],
  ['dark-ink-field', 'Dark Ink Field'], ['dark-midnight-mesh', 'Dark Midnight Mesh'],
  ['dark-rose-noir', 'Dark Rose Noir'], ['dark-teal-depth', 'Dark Teal Depth'],
  ['frost-mesh', 'Frost Mesh'], ['halftone-pop', 'Halftone Pop'],
  ['honey-ember', 'Honey Ember'], ['ink-wash', 'Ink Wash'],
  ['linen-weave', 'Linen Weave'], ['mint-lagoon', 'Mint Lagoon'],
  ['paper-fold', 'Paper Fold'], ['rain-prism', 'Rain Prism'],
  ['sand-drift', 'Sand Drift'], ['soft-spotlight', 'Soft Spotlight'],
  ['sunrise-horizon', 'Sunrise Horizon'], ['sunset-bloom', 'Sunset Bloom'],
  ['terrazzo-fragment', 'Terrazzo Fragment'], ['tropical-tide', 'Tropical Tide'],
];
const palette = new Map([
  ['teal-edge', '#113f3f'], ['teal', '#13454c'], ['blue', '#35598d'],
  ['blue-lift', '#41699a'], ['indigo', '#6a5bb1'], ['violet', '#986bcd'],
  ['magenta', '#a566d1'], ['magenta-lift', '#ac6ed7'],
]);
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }));
const failures = [];
function check(name, run) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
}

check('exact catalog order, slugs, accessible names, and outside captions', () => {
  const figures = [...html.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)];
  assert.equal(figures.length, 26, 'expected 26 captioned figures');
  assert.equal([...html.matchAll(/\bdata-gradient=/g)].length, 26, 'expected 26 unique artworks');
  figures.forEach(([, body], index) => {
    const [effect, name] = catalog[index];
    const slug = `${effect}-background`;
    assert.match(body, new RegExp(`<div class="swatch ${effect}" data-gradient="${slug}" role="img" aria-label="${name}"><\\/div>`));
    assert.match(body, new RegExp(`<figcaption>${name}<\\/figcaption>`));
    assert.equal([...body.matchAll(/<figcaption>/g)].length, 1);
  });
  const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1];
  const visibleText = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(visibleText, catalog.map(([, name]) => name).join(' '), 'only captions may be visible');
  for (const { selector, declarations } of rules) {
    const content = declarations.match(/(?:^|;)\s*content\s*:\s*([^;]+)/i);
    if (content) assert.match(content[1].trim(), /^(?:""|'')$/, `${selector} generates visible text`);
  }
});

check('reference tokens and one common composition', () => {
  const root = rules.find(({ selector }) => selector === ':root')?.declarations ?? '';
  for (const [token, color] of palette) assert.match(root, new RegExp(`--${token}:\\s*${color}\\s*;`), `missing sampled token ${token}`);
  const base = rules.find(({ selector }) => selector === '.swatch')?.declarations ?? '';
  assert.match(base, /background:/, 'shared artwork must own its background');
  for (const token of ['teal-edge', 'teal', 'blue', 'blue-lift', 'indigo', 'violet', 'magenta', 'magenta-lift']) {
    assert.ok(base.includes(`var(--${token})`), `shared composition missing ${token}`);
  }
  for (const anchor of ['46% 8%', '0% 88%', '48% 100%']) assert.ok(base.includes(anchor), `missing reference bloom anchor ${anchor}`);
});

check('artwork color boundary and distinct treatment for every entry', () => {
  const allowed = new Set(palette.values());
  const signatures = [];
  for (const [effect] of catalog) {
    const treatment = rules.filter(({ selector }) => selector.split(',').some((part) => part.trim().startsWith(`.${effect}::`)));
    assert.ok(treatment.length, `missing distinct treatment selector .${effect}`);
    const declarations = treatment.map((rule) => rule.declarations.trim()).join('\n');
    assert.match(declarations, /background:|box-shadow:|border:/, `missing geometry or texture for ${effect}`);
    signatures.push(declarations.replace(/\s+/g, ' '));
    assert.ok(!rules.some(({ selector, declarations }) => selector === `.${effect}` && /background\s*:/.test(declarations)), `${effect} replaces the shared substrate`);
  }
  assert.equal(new Set(signatures).size, 26, 'treatments must not duplicate one another');
  // Only the page surround and captions may use neutral interface colors.
  const interfaceSelectors = new Set(['*', 'html', 'body', '.gallery', 'figure', 'figcaption']);
  const artworkRules = rules.filter(({ selector }) => !interfaceSelectors.has(selector));
  for (const { selector, declarations } of artworkRules) {
    for (const [literal] of declarations.matchAll(/#[\da-f]{3,8}\b/gi)) assert.ok(allowed.has(literal.toLowerCase()), `${selector} has off-palette color ${literal}`);
    assert.ok(!/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(declarations), `${selector} has an unapproved literal color function`);
    const literalDeclarations = declarations.replace(/var\(--[\w-]+\)/g, '').replace(/--[\w-]+\s*:/g, '');
    assert.ok(!/\b(?:white|black|red|green|yellow|orange|pink|purple|cyan|lime|coral|cream|navy|blue|teal|magenta|indigo|violet|silver|gray|grey|gold|brown|rebeccapurple)\b(?![\w-])/i.test(literalDeclarations), `${selector} has a named color`);
    for (const [, token] of declarations.matchAll(/var\(--([\w-]+)\)/g)) assert.ok(palette.has(token), `${selector} has unknown artwork color token ${token}`);
  }
});

check('722:334 proportion, responsive 3/2/1 grid, and normal vertical flow', () => {
  assert.match(css, /aspect-ratio:\s*722\s*\/\s*334\s*;/);
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*920px\)\s*\{\s*\.gallery\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*620px\)\s*\{\s*\.gallery\s*\{\s*grid-template-columns:\s*1fr/);
  for (const { selector, declarations } of rules.filter(({ selector }) => ['html', 'body', '.gallery'].includes(selector))) {
    assert.ok(!/(?:^|;)\s*(?:height|max-height):|overflow(?:-y)?:\s*(?:hidden|clip)|position:\s*fixed/i.test(declarations), `${selector} clamps vertical flow`);
  }
  assert.match(css, /min-width:\s*0/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

check('standalone HTML/CSS, no branding or requests', () => {
  assert.ok(!/<(?:script|img|svg|canvas|iframe|video|audio|object|embed|link)\b/i.test(html), 'page has script or asset markup');
  assert.ok(!/@import|url\s*\(|https?:|\/\/|\b(?:src|href)\s*=|\bon\w+\s*=|@font-face/i.test(html), 'page has external resource or script hook');
  assert.ok(!/nava|autonomous agents|big insurance|wordmark|tagline|logo/i.test(html), 'page has branding');
  assert.equal([...html.matchAll(/<style>/g)].length, 1, 'expected one inline style');
  assert.match(html, /<html lang="en">/);
});

console.log(`Gallery contract: ${5 - failures.length}/5 checks passed.`);
process.exitCode = failures.length ? 1 : 0;

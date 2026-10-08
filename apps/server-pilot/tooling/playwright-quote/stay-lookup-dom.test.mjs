// Offline checks of the DOM snapshots in stay-lookup-dom.mjs. The same source that Playwright runs in the HMS page runs
// here over a small DOM adapter on cheerio (a direct dependency of apps/server-pilot), against the HTML fixtures in
// fixtures/stay-lookup/. Replace a fixture with a live --debug-html dump to re-test the captured page offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { snapshotPanel, snapshotRecordForm } from './stay-lookup-dom.mjs';
import {
  formPairsFromSnapshot, parsePanelSnapshot, parseRecordsFooter, searchGuestOutcome, stayFromFormPairs,
} from './cancel-stay-rules.mjs';

// ---- A DOM adapter over cheerio: the members the snapshot functions use, with innerText approximated. ----

const ELEMENTS = new Set(['tag', 'script', 'style']);
const BLOCKS = new Set(['body', 'div', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'p', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'form', 'fieldset']);
const wrapped = new WeakMap();

function selfHidden(node) {
  const attribs = node.attribs ?? {};
  return 'hidden' in attribs || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attribs.style ?? '');
}

function hiddenChain(node) {
  for (let n = node; n && ELEMENTS.has(n.type); n = n.parent) if (selfHidden(n)) return true;
  return false;
}

function textOf(node) {
  if (node.type === 'text') return node.data;
  return (node.children ?? []).map(textOf).join('');
}

// Approximates element.innerText: hidden subtrees are skipped, blocks and <br> break lines, and a cell that has a
// later cell in its row is followed by a tab. A cell's own innerText has no tab.
function hasLaterCell(cell) {
  const siblings = cell.parent?.children ?? [];
  return siblings.slice(siblings.indexOf(cell) + 1).some((s) => s.type === 'tag' && (s.name === 'td' || s.name === 'th'));
}

function innerTextOf(node) {
  let out = '';
  const walk = (n, isRoot) => {
    if (n.type === 'text') {
      out += n.data.replace(/\s+/g, ' ');
      return;
    }
    if (!ELEMENTS.has(n.type) || selfHidden(n)) return;
    if (n.name === 'br') {
      out += '\n';
      return;
    }
    const block = BLOCKS.has(n.name);
    if (block) out += '\n';
    for (const child of n.children) walk(child, false);
    if (!isRoot && (n.name === 'td' || n.name === 'th') && hasLaterCell(n)) out += '\t';
    if (block) out += '\n';
  };
  walk(node, true);
  return out;
}

class TextNode {
  constructor(node) {
    this.node = node;
  }

  get nodeType() {
    return 3;
  }

  get textContent() {
    return this.node.data;
  }
}

class Elem {
  constructor(node, $) {
    this.node = node;
    this.$ = $;
  }

  get nodeType() {
    return 1;
  }

  get tagName() {
    return this.node.name.toUpperCase();
  }

  get id() {
    return this.node.attribs.id ?? '';
  }

  get htmlFor() {
    return this.node.attribs.for ?? '';
  }

  get type() {
    return this.node.attribs.type ?? '';
  }

  get value() {
    return this.node.name === 'textarea' ? textOf(this.node) : (this.node.attribs.value ?? '');
  }

  get children() {
    return this.node.children.filter((c) => ELEMENTS.has(c.type)).map((c) => wrap(c, this.$));
  }

  get childNodes() {
    return this.node.children
      .filter((c) => c.type === 'text' || ELEMENTS.has(c.type))
      .map((c) => wrap(c, this.$));
  }

  get classList() {
    const names = new Set((this.node.attribs.class ?? '').split(/\s+/).filter(Boolean));
    return { contains: (name) => names.has(name) };
  }

  get parentElement() {
    const parent = this.node.parent;
    return parent && ELEMENTS.has(parent.type) ? wrap(parent, this.$) : null;
  }

  get textContent() {
    return textOf(this.node);
  }

  get innerText() {
    return innerTextOf(this.node);
  }

  get outerHTML() {
    return this.$.html(this.node);
  }

  getAttribute(name) {
    return this.node.attribs[name] ?? null;
  }

  getBoundingClientRect() {
    const shown = !hiddenChain(this.node);
    return { width: shown ? 1 : 0, height: shown ? 1 : 0 };
  }

  closest(selector) {
    for (let n = this.node; n && ELEMENTS.has(n.type); n = n.parent) {
      if (this.$(n).is(selector)) return wrap(n, this.$);
    }
    return null;
  }

  querySelectorAll(selector) {
    return this.$(this.node).find(selector).toArray().map((n) => wrap(n, this.$));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(other) {
    for (let n = other.node; n; n = n.parent) {
      if (n === this.node) return true;
    }
    return false;
  }
}

function wrap(node, $) {
  if (!node) return null;
  if (!wrapped.has(node)) wrapped.set(node, ELEMENTS.has(node.type) ? new Elem(node, $) : new TextNode(node));
  return wrapped.get(node);
}

function domFromHtml(html) {
  const $ = cheerio.load(html);
  const doc = {
    body: wrap($('body')[0], $),
    querySelectorAll: (selector) => $.root().find(selector).toArray().map((n) => wrap(n, $)),
    querySelector: (selector) => doc.querySelectorAll(selector)[0] ?? null,
  };
  return doc;
}

async function fixture(name) {
  return readFile(new URL(`./fixtures/stay-lookup/${name}`, import.meta.url), 'utf8');
}

function stayFromHtml(html) {
  const entries = snapshotRecordForm(false, domFromHtml(html)).entries;
  return stayFromFormPairs(formPairsFromSnapshot(entries));
}

function panelFromHtml(html) {
  return snapshotPanel(domFromHtml(html).querySelector('#quick-panel'));
}

// ---- Record form ----

const EXPECTED_STAY = {
  status: 'Cancelled',
  confirmation: '57291630-1',
  lastName: 'Labtest',
  firstName: 'Nava',
  arrival: '2027-09-14',
  departure: '2027-09-15',
  nights: 1,
  adults: 1,
  children: 0,
  roomType: 'STQN',
  ratePlan: 'BAR',
  mealPlan: 'Bed & Breakfast R',
  averageRate: '2060.00',
  grandTotal: '2060.00',
  balance: '0.00',
  sourceOfBusiness: 'Walk in',
  guaranteeType: 'Non-Guaranteed Individual',
  bookingAgency: null,
  organization: null,
};

test('record form fixture: every shown field pairs with its label, across for attributes, span labels and nested trigger wrappers', async () => {
  const { stay, conflicts } = stayFromHtml(await fixture('record-form.html'));
  assert.deepEqual(conflicts, []);
  assert.deepEqual(stay, EXPECTED_STAY);
});

test('record form fixture: the hidden twin of the departure input is never read as the value', async () => {
  const html = await fixture('record-form.html');
  const { stay } = stayFromHtml(html.replace('<td><input name="departuredate" value="15-SEP-2027" readonly></td>', '<td><input name="departuredate" value="" readonly></td>'));
  assert.equal(stay.departure, null, 'an empty visible input stays null even though the hidden twin holds a value');
});

test('record form: a value in another row is not paired with a label above it', () => {
  const html = `<html><body><div id="v">
    <table><tbody>
      <tr><td><label>Nights:</label></td></tr>
      <tr><td><input name="nights" value="1"></td></tr>
    </tbody></table></div></body></html>`;
  assert.equal(stayFromHtml(html).stay.nights, null);
});

test('record form: an unknown label between a known label and its input does not steal the input', () => {
  const html = `<html><body><div id="v">
    <table><tbody><tr>
      <td><label>Adults:</label></td>
      <td><label>Walk In:</label></td>
      <td><input name="adults" value="2"></td>
    </tr></tbody></table></div></body></html>`;
  assert.equal(stayFromHtml(html).stay.adults, 2, 'unknown labels never claim an input, so Adults still pairs');
});

// ---- Quick panel ----

const PANEL_ROW = {
  confirmation: '57291630-1',
  lastName: 'Labtest',
  firstName: 'Nava',
  status: 'Cancelled',
  arrival: '2027-09-14',
  departure: '2027-09-15',
};

test('panel fixture: the highlighted surname still makes one guest cell, and the two date lines parse', async () => {
  const snapshot = panelFromHtml(await fixture('panel-search.html'));
  const parsed = parsePanelSnapshot(snapshot);
  assert.deepEqual(parsed.rows, [PANEL_ROW]);
  assert.equal(parsed.unreadable, 0);
  assert.deepEqual(parsed.unreadableRows, []);
  const records = parseRecordsFooter(snapshot.footer);
  assert.deepEqual(records, { shown: 1, total: 1 });
  assert.deepEqual(searchGuestOutcome({ records, rows: parsed.rows, unreadable: parsed.unreadable }), { outcome: 'ok', reason: null });
});

function panelHtml(rowInner, footer = 'Records: 1 of 1') {
  return `<html><body><div id="quick-panel">
    <table class="x-grid-item"><tbody>
      <tr class="x-grid-row">${rowInner}</tr>
    </tbody></table>
    <div class="x-footer">${footer}</div>
  </div></body></html>`;
}

test('panel: dates stacked in two divs parse the same as a line break inside one cell', () => {
  const twoDivs = panelHtml(`<td><div>57291630-1</div></td>
    <td><div><span>Labtest</span>, Nava</div></td>
    <td><div>Cancelled</div></td>
    <td><div>14-SEP-2027</div><div>15-SEP-2027</div></td>`);
  const parsed = parsePanelSnapshot(panelFromHtml(twoDivs));
  assert.deepEqual(parsed.rows, [PANEL_ROW]);
});

test('panel: a row without a readable status is unreadable, and its cells are kept for the dump', () => {
  const noStatus = panelHtml(`<td>57291630-1</td><td><span>Labtest</span>, Nava</td><td>14-SEP-2027<br>15-SEP-2027</td>`);
  const snapshot = panelFromHtml(noStatus);
  const parsed = parsePanelSnapshot(snapshot);
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.unreadable, 1);
  assert.deepEqual(parsed.unreadableRows[0].cells, ['57291630-1', 'Labtest, Nava', '14-SEP-2027\n15-SEP-2027']);
  assert.deepEqual(
    searchGuestOutcome({ records: parseRecordsFooter(snapshot.footer), rows: parsed.rows, unreadable: parsed.unreadable }),
    { outcome: 'execution_failure', reason: 'rows_unreadable' },
  );
});

test('panel without table rows: the nearest dated block is read, and its lines parse past a highlighted surname', () => {
  const divRows = `<html><body><div id="quick-panel">
    <div class="hit"><div>57291630-1</div><div><span class="x-search-hit">Labtest</span>, Nava</div><div>Cancelled</div><div>14-SEP-2027</div><div>15-SEP-2027</div></div>
    <div class="x-footer">Records: 1 of 1</div>
  </div></body></html>`;
  const snapshot = panelFromHtml(divRows);
  assert.equal(snapshot.unresolved, 0);
  const parsed = parsePanelSnapshot(snapshot);
  assert.deepEqual(parsed.rows, [PANEL_ROW]);
  assert.equal(parsed.unreadable, 0);
});

test('panel: a confirmation outside any row is counted as unresolved, so the search fails closed', () => {
  const orphan = `<html><body><div id="quick-panel">
    <div class="x-hit">57291630-1</div>
    <div class="x-footer">Records: 1 of 1</div>
  </div></body></html>`;
  const snapshot = panelFromHtml(orphan);
  assert.equal(snapshot.unresolved, 1);
  assert.equal(parsePanelSnapshot(snapshot).unreadable, 1);
});

// DOM snapshots for stay-lookup.mjs. Each export is self-contained: Playwright serializes its source and runs it in the
// HMS page, and the offline fixture test runs the same source over a DOM adapter. Do not reference module-level names
// inside them. Pairing and parsing of the snapshots live in cancel-stay-rules.mjs.

// Flat, document-ordered snapshot of the visible record form: colon-ended labels and visible value inputs. Each entry
// lists the ids of the table rows and form items that contain it, innermost first, so a label and its input match by
// shared row rather than by DOM adjacency (ExtJS puts a field's trigger wrapper in a nested table). region is the outer
// HTML of the element that holds the labels; it is only built in debug mode.
export function snapshotRecordForm(debug = false, doc = document) {
  const ELEMENT = 1;
  const TEXT = 3;
  const SKIPPED_INPUT = /^(hidden|button|submit|reset|image|file|checkbox|radio)$/i;
  const rowIds = new Map();
  const rowIdsOf = (node) => {
    const ids = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      if (el.tagName === 'TR' || el.classList.contains('x-form-item')) {
        if (!rowIds.has(el)) rowIds.set(el, rowIds.size + 1);
        ids.push(rowIds.get(el));
      }
    }
    return ids;
  };
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  // A label's text. A <label> also reads its inline children (a <span> inside it); any other element reads only its own
  // text nodes, so a cell that wraps a labelled span is not a second label for the same field.
  const labelText = (el) => {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === TEXT) {
        text += child.textContent;
      } else if (el.tagName === 'LABEL' && child.nodeType === ELEMENT && child.children.length === 0
        && /^(SPAN|B|STRONG|EM|I|FONT)$/.test(child.tagName)) {
        text += child.textContent;
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  const entries = [];
  const labels = [];
  for (const el of doc.querySelectorAll('*')) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (tag === 'INPUT' && SKIPPED_INPUT.test(el.type || '')) continue;
      if (!shown(el)) continue;
      entries.push({
        kind: 'field',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        value: el.value || '',
        rows: rowIdsOf(el),
      });
      continue;
    }
    const text = labelText(el);
    if (!text || !text.replace(/[\s•·*●]+$/u, '').endsWith(':') || !shown(el)) continue;
    const owner = el.closest('label');
    entries.push({ kind: 'label', text, forId: owner?.htmlFor || '', rows: rowIdsOf(el) });
    labels.push(el);
  }
  let region = null;
  if (debug && labels.length > 0) {
    let common = labels[0];
    for (const el of labels.slice(1)) {
      while (common && !common.contains(el)) common = common.parentElement;
    }
    region = common ? common.outerHTML : null;
  }
  return { entries, region };
}

// Dropdown rows of the quick panel below root. Each leaf row (a row that holds no other row) yields its cell texts
// (td, th and grid cells, so a highlighted fragment stays inside its cell) and its line texts. A confirmation-shaped
// leaf outside every captured row is counted as unresolved. footer is the "Records: N of M" text, or ''.
export function snapshotPanel(root) {
  const ROW = 'tr, .x-grid-row, .x-grid-item, [role="row"]';
  const CELL = 'td, th, .x-grid-cell, [role="gridcell"], [role="cell"]';
  const shown = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const rows = [];
  const captured = new Set();
  for (const row of root.querySelectorAll(ROW)) {
    if (!shown(row) || row.querySelector(ROW)) continue;
    const cells = [...row.querySelectorAll(CELL)].filter((cell) => shown(cell) && cell.closest(ROW) === row);
    rows.push({
      cells: cells.map((cell) => cell.innerText || cell.textContent || ''),
      lines: (row.innerText || row.textContent || '').split(/\t|\n/),
    });
    captured.add(row);
  }
  // Fallback for a panel without table rows (the same idea as rowCells in cancel-stay.mjs): a confirmation leaf outside
  // every captured row takes its nearest ancestor whose text holds a date. Anything left over is unresolved.
  const DATED = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/;
  const textOf = (node) => node.innerText || node.textContent || '';
  let unresolved = 0;
  for (const leaf of root.querySelectorAll('*')) {
    if (leaf.children.length !== 0 || !shown(leaf)) continue;
    if (!/^\d+-\d+$/.test(textOf(leaf).trim())) continue;
    const tableRow = leaf.closest(ROW);
    if (tableRow && captured.has(tableRow)) continue;
    let block = leaf.parentElement;
    while (block && block !== root && !DATED.test(textOf(block))) block = block.parentElement;
    if (!block || block === root) {
      unresolved += 1;
      continue;
    }
    if (captured.has(block)) continue;
    captured.add(block);
    rows.push({
      cells: [...block.querySelectorAll('*')].filter((node) => node.children.length === 0 && shown(node)).map(textOf),
      lines: textOf(block).split(/\t|\n/),
    });
  }
  const footer = (root.innerText || root.textContent || '').match(/Records:\s*\d+\s+of\s+\d+/i);
  return { rows, unresolved, footer: footer ? footer[0] : '' };
}

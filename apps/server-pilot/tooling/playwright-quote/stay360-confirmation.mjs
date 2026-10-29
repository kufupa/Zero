// Read-only confirmation lookup on an already-open Centurion Stay 360 page.
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';

const SEARCH_TIMEOUT_MS = 8_000;

function saveNotePrivately(note) {
  const privateRoot = fileURLToPath(new URL('../../../../.private/', import.meta.url));
  const noteRoot = join(privateRoot, 'stay360-confirmation');
  for (const directory of [privateRoot, noteRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = statSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error('NOTE_PRIVATE_DIRECTORY_UNSAFE');
  }
  const directory = mkdtempSync(join(noteRoot, 'note-'));
  const path = join(directory, 'note.json');
  writeFileSync(path, JSON.stringify(note, null, 2), { mode: 0o600, flag: 'wx' });
  return path;
}

async function findSearchWindow(page, searchBox) {
  const windows = page.locator('.x-window.x-menu:visible');
  const candidates = [];
  for (let index = 0, count = await windows.count(); index < count; index += 1) {
    const window = windows.nth(index);
    const box = await window.boundingBox().catch(() => null);
    if (box && Math.abs(box.x - searchBox.x) <= 20 && Math.abs(box.width - searchBox.width) <= 40 &&
        box.y >= searchBox.y + searchBox.height - 5 && box.y <= searchBox.y + searchBox.height + 100) {
      candidates.push(window);
    }
  }
  if (candidates.length > 1) throw new Error('AMBIGUOUS_SEARCH_WINDOW');
  return candidates[0] ?? null;
}

async function waitForSearch(page, searchBox) {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  let emptySince = null;
  while (Date.now() < deadline) {
    const popup = await findSearchWindow(page, searchBox);
    if (popup) {
      const state = await popup.evaluate((element) => {
        const text = element.innerText || '';
        const footer = text.match(/Records:\s*(\d+)\s+of\s+(\d+)/i);
        const masks = [...element.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')];
        const loading = masks.some((mask) => {
          const box = mask.getBoundingClientRect();
          const style = getComputedStyle(mask);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        return {
          displayed: footer ? Number(footer[1]) : null,
          total: footer ? Number(footer[2]) : null,
          history: /No previous searches/i.test(text),
          loading,
        };
      });
      const rowCount = await popup.locator('.x-grid-row:visible').count();
      if (state.displayed !== null && !state.history && !state.loading && rowCount >= state.displayed) {
        if (state.total > state.displayed) throw new Error('SEARCH_RESULTS_CAPPED');
        if (state.displayed > 0) return popup;
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 500) return popup;
      } else {
        emptySince = null;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('CONFIRMATION_SEARCH_TIMEOUT');
}

// Only dismiss the explicitly titled Notes dialog, never an unrelated prompt.
export async function dismissNotesOrThrow(root, { allowRecordFrame = false } = {}) {
  const dialogs = root.locator('.x-window:visible:not(.x-menu)');
  const notes = [];
  let noteDialog = null;
  let recordFrames = 0;
  for (let index = 0, count = await dialogs.count(); index < count; index += 1) {
    const dialog = dialogs.nth(index);
    const frames = dialog.locator('iframe:visible');
    if (allowRecordFrame && await frames.count() === 1) {
      const isRecordFrame = await frames.evaluate((element) => {
        const url = new URL(element.src, location.href);
        return url.origin === location.origin && url.searchParams.get('initpath') === 'OSRESV';
      });
      if (isRecordFrame && ++recordFrames === 1) continue;
    }
    const titles = dialog.locator('.x-window-header-text:visible');
    const title = await titles.count() === 1 ? (await titles.innerText()).trim() : '';
    if (!/^(Note|Notes)$/.test(title) || noteDialog) throw new Error('UNEXPECTED_DIALOG');
    noteDialog = dialog;
  }
  if (noteDialog) {
    const close = noteDialog.locator('a.x-btn:visible').filter({ hasText: /^Close$/ });
    if (await close.count() !== 1) throw new Error('NOTE_CLOSE_NOT_UNIQUE');
    const note = await noteDialog.evaluate((element) => ({
      title: element.querySelector('.x-window-header-text')?.innerText.trim() || '',
      text: element.innerText.trim(),
      fields: [...element.querySelectorAll('input:not([type="hidden"]):not([type="password"]), textarea, select')]
        .filter((field) => field.getBoundingClientRect().width && field.getBoundingClientRect().height)
        .map((field) => ({
          name: field.name || null,
          type: field.type || field.tagName.toLowerCase(),
          value: field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value,
        })),
    }));
    note.privateCapture = saveNotePrivately(note);
    notes.push(note);
    const handle = await noteDialog.elementHandle();
    await close.click({ timeout: 2_500 });
    await handle.waitForElementState('hidden', { timeout: 2_500 });
  }
  return notes;
}

async function waitForSelectedDetails(page, popup, wanted) {
  const deadline = Date.now() + 8_000;
  const notes = [];
  let readySince = null;
  while (Date.now() < deadline) {
    const newNotes = await dismissNotesOrThrow(page);
    notes.push(...newNotes);
    if (newNotes.length) readySince = null;
    const ready = await page.evaluate((value) => {
      const shown = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const header = [...document.querySelectorAll('h1.recordcode')]
        .some((element) => shown(element) && element.innerText.trim() === value);
      const masked = [...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(shown);
      const fields = [...document.querySelectorAll('.gs-panel [name="arrivaldate"], .gs-panel [name="departuredate"], ' +
        '.gs-panel [name="status"], .gs-panel [name="guestfullname"]')];
      return header && !masked && fields.some((field) => shown(field) && String(field.value ?? field.innerText ?? '').trim());
    }, wanted);
    if (ready && !(await popup.isVisible())) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= 300) return notes;
    } else {
      readySince = null;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('CONFIRMATION_DETAILS_NOT_LOADED');
}

// Kept as an action on the caller's page so record-view reads can build on it.
export async function readConfirmationFromStay360(page, confirmation) {
  if (typeof confirmation !== 'string' || !confirmation.trim() || confirmation.length > 128 || /[\r\n]/.test(confirmation)) {
    throw new Error('INVALID_CONFIRMATION');
  }
  const wanted = confirmation.trim();
  await installReadOnlyGuard(page.context());

  const search = page.locator('input[name="search"]:visible');
  await search.waitFor({ state: 'visible', timeout: 4_000 });
  const searchBox = await search.boundingBox();
  if (!searchBox) throw new Error('CONFIRMATION_SEARCH_NOT_VISIBLE');
  await search.fill(wanted);

  // The page may also contain a grid Run button; use the one next to this search.
  const runs = page.locator('a.x-btn:visible').filter({ hasText: /^Run$/ });
  const adjacentRuns = [];
  for (let index = 0, count = await runs.count(); index < count; index += 1) {
    const run = runs.nth(index);
    const box = await run.boundingBox().catch(() => null);
    if (box && Math.abs(box.y - searchBox.y) <= 10 && box.x >= searchBox.x + searchBox.width &&
        box.x <= searchBox.x + searchBox.width + 100) adjacentRuns.push(run);
  }
  if (adjacentRuns.length !== 1) throw new Error('CONFIRMATION_RUN_BUTTON_NOT_UNIQUE');
  await adjacentRuns[0].click({ timeout: 2_500 });

  const popup = await waitForSearch(page, searchBox);
  const rows = popup.locator('.x-grid-row:visible');
  const matches = await rows.evaluateAll((elements, value) => elements.flatMap((row, index) => {
    const cells = [...row.querySelectorAll('td, [role="gridcell"], .x-grid-cell')]
      .filter((cell) => cell.closest('.x-grid-row') === row);
    const cellIndex = cells.findIndex((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim() === value);
    return cellIndex < 0 ? [] : [{ index, cellIndex }];
  }), wanted);
  if (matches.length === 0) throw new Error('CONFIRMATION_NOT_FOUND');
  if (matches.length !== 1) throw new Error('AMBIGUOUS_CONFIRMATION');

  const row = rows.nth(matches[0].index);
  const selectedRow = (await row.innerText()).trim();
  await row.locator('td, [role="gridcell"], .x-grid-cell').nth(matches[0].cellIndex).click({ timeout: 2_500 });
  const notes = await waitForSelectedDetails(page, popup, wanted);

  const details = await page.evaluate(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const readControl = (element) => {
      if (element.tagName === 'SELECT') {
        return [...element.selectedOptions].map((option) => normalize(option.textContent)).join(', ');
      }
      if (element.type === 'checkbox' || element.type === 'radio') return element.checked;
      return (element.value ?? element.innerText ?? element.textContent ?? '').trim();
    };
    const controlSelector = 'input:not([type="hidden"]):not([type="password"]), textarea, select, ' +
      '[contenteditable="true"], .x-form-display-field';
    const cards = [...document.querySelectorAll('.gs-panel')].filter(shown).map((card) => {
      const title = [...card.querySelectorAll('.x-panel-header-text')]
        .find((element) => element.closest('.gs-panel') === card && shown(element));
      const fields = [...card.querySelectorAll('.x-form-item')].filter(shown).flatMap((item) => {
        if (item.closest('.gs-panel') !== card) return [];
        const label = [...item.querySelectorAll('label, .x-form-item-label')]
          .find((element) => element.closest('.x-form-item') === item && shown(element));
        const controls = [...item.querySelectorAll(controlSelector)].filter((element) => {
          if (element.tagName === 'LABEL' || element.closest('.x-form-item') !== item) return false;
          if (shown(element)) return true;
          const style = getComputedStyle(element);
          return element.classList.contains('x-form-display-field') &&
            style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (label && controls.length === 0) {
          return [{ label: normalize(label.innerText), name: null, type: null, value: null }];
        }
        return controls.map((control) => ({
          label: normalize(label?.innerText || control.getAttribute('aria-label') || control.getAttribute('name') || ''),
          name: control.getAttribute('name') || null,
          type: control.getAttribute('type') || control.tagName.toLowerCase(),
          value: readControl(control),
        }));
      });
      const grids = [...card.querySelectorAll('.x-grid')].filter(shown)
        .filter((grid, _, all) => !all.some((outer) => outer !== grid && outer.contains(grid)))
        .map((grid) => grid.innerText.trim());
      return { title: normalize(title?.innerText) || null, fields, visibleText: card.innerText.trim(), grids };
    });
    const visibleFormFields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
      .filter(shown).filter((element) => !['hidden', 'password'].includes(element.type))
      .filter((element) => !['search', 'appmenusearch'].includes(element.name) && !element.closest('.x-grid'))
      .map((element) => {
        const item = element.closest('.x-form-item, .x-form-fieldcontainer');
        const label = item?.querySelector('.x-form-item-label, label');
        return {
          label: normalize(label?.innerText || element.getAttribute('aria-label') || element.name || ''),
          name: element.name || null,
          type: element.getAttribute('type') || element.tagName.toLowerCase(),
          value: readControl(element),
        };
      });
    const text = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const content = normalize(node.textContent);
      if (!content || !node.parentElement || !shown(node.parentElement) ||
          node.parentElement.closest('.x-grid, .x-window.x-menu') ||
          /^(Processing request|Loading\.\.\.)$/i.test(content)) continue;
      text.push(content);
    }
    const header = [...document.querySelectorAll('h1.recordcode')].find((element) => shown(element));
    return {
      confirmationInHeader: normalize(header?.innerText) || null,
      cards,
      visibleFormFields,
      visiblePageTextOutsideGrids: text.join('\n'),
      captureScope: 'Rendered Stay 360 page and card grids; other reservation lists and unopened tabs excluded.',
    };
  });
  if (details.confirmationInHeader !== wanted || details.cards.length === 0) {
    throw new Error('CONFIRMATION_DETAILS_NOT_LOADED');
  }
  return {
    ok: true,
    confirmation: wanted,
    selectedRow,
    notes,
    details,
    method: 'Playwright UI search and selection; no direct HMS API calls.',
  };
}

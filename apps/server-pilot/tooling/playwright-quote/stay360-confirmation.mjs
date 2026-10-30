// Read-only confirmation lookup on an already-open Centurion Stay 360 page.
import { readFileSync } from 'node:fs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';
import { dismissNotesOrThrow, installStay360NotesHandler, takeHandledNotes } from './stay360-notes.mjs';

export { dismissNotesOrThrow } from './stay360-notes.mjs';

const SEARCH_TIMEOUT_MS = 30_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function parseArrivalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('INVALID_ARRIVAL_DATE');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error('INVALID_ARRIVAL_DATE');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error('INVALID_ARRIVAL_DATE');
  return date;
}

function parseSearchResultDate(value) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value ?? '');
  const month = match && MONTHS.findIndex((name) => name.slice(0, 3).toLowerCase() === match[2].toLowerCase());
  if (!match || month < 0) return null;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  if (date.getUTCFullYear() !== Number(match[3]) || date.getUTCMonth() !== month ||
      date.getUTCDate() !== Number(match[1])) return null;
  return date.toISOString().slice(0, 10);
}

function parseSearchDate(value) {
  const match = /^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  const month = match && MONTHS.findIndex((name) => name.slice(0, 3).toLowerCase() === match[1].toLowerCase());
  if (!match || month < 0) throw new Error('SEARCH_DATE_RANGE_UNREADABLE');
  return Date.UTC(Number(match[3]), month, Number(match[2]));
}

async function readSearchDateRange(popup) {
  const title = popup.locator('[name="gridTitle"]:visible');
  if (await title.count() !== 1) throw new Error('SEARCH_DATE_RANGE_UNREADABLE');
  const range = (await title.innerText()).split(/\s+-\s+/);
  if (range.length !== 2) throw new Error('SEARCH_DATE_RANGE_UNREADABLE');
  return {
    from: new Date(parseSearchDate(range[0])).toISOString().slice(0, 10),
    to: new Date(parseSearchDate(range[1])).toISOString().slice(0, 10),
  };
}

async function adjustSearchWindow(page, popup, arrival) {
  const range = await readSearchDateRange(popup);
  const arrivalDate = arrival.toISOString().slice(0, 10);
  if (arrivalDate >= range.from && arrivalDate <= range.to) {
    return null;
  }

  const start = new Date(arrival.getTime() - 14 * 24 * 60 * 60 * 1000);
  const calendarButton = popup.locator('[data-testid="calendarbtn"]:visible');
  if (await calendarButton.count() !== 1) throw new Error('SEARCH_DATE_PICKER_NOT_UNIQUE');
  await calendarButton.click();
  const picker = page.locator('.x-datepicker:visible');
  await picker.waitFor({ state: 'visible', timeout: 10_000 });
  const monthTitle = picker.locator('.x-datepicker-month .x-btn-inner');
  for (let i = 0; i < 36; i += 1) {
    const current = (await monthTitle.innerText()).trim();
    const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(current);
    const month = match && MONTHS.indexOf(match[1]);
    if (!match || month < 0) throw new Error('SEARCH_DATE_PICKER_UNREADABLE');
    const difference = (start.getUTCFullYear() - Number(match[2])) * 12 + start.getUTCMonth() - month;
    if (!difference) break;
    await picker.locator(difference < 0 ? '.x-datepicker-prev' : '.x-datepicker-next').click();
    await page.waitForFunction((previous) => [...document.querySelectorAll('.x-datepicker')].some((element) => {
      const box = element.getBoundingClientRect();
      const nextTitle = element.querySelector('.x-datepicker-month .x-btn-inner')?.textContent?.trim();
      return box.width > 0 && box.height > 0 && nextTitle && nextTitle !== previous;
    }), current, { timeout: 5_000 });
  }
  const expectedMonth = `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  if ((await monthTitle.innerText()).trim() !== expectedMonth) throw new Error('SEARCH_DATE_PICKER_OUT_OF_RANGE');
  const day = String(start.getUTCDate()).padStart(2, '0');
  const dateTitle = `${MONTHS[start.getUTCMonth()]} ${day}, ${start.getUTCFullYear()}`;
  await picker.locator(`td[title="${dateTitle}"] a`).click();
  const expectedStart = `${MONTHS[start.getUTCMonth()].slice(0, 3)} ${day}, ${start.getUTCFullYear()} - `;
  await page.waitForFunction((prefix) => [...document.querySelectorAll('[name="gridTitle"]')].some((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && element.textContent.trim().startsWith(prefix);
  }), expectedStart, { timeout: 10_000 });
  return { arrivalDateHint: arrival.toISOString().slice(0, 10), searchStartDate: start.toISOString().slice(0, 10) };
}

async function exactSearchMatches(popup, wanted) {
  const rows = await popup.locator('.x-grid-row:visible').evaluateAll((elements, value) => elements.flatMap((row, index) => {
    const cells = [...row.querySelectorAll('td, [role="gridcell"], .x-grid-cell')]
      .filter((cell) => cell.closest('.x-grid-row') === row);
    const text = cells.map((cell) => (cell.innerText || '').split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim()));
    const cellIndex = text.findIndex((lines) => lines.includes(value));
    return cellIndex < 0 ? [] : [{ index, cellIndex, text }];
  }), wanted);
  return rows.map((row) => {
    const dates = (row.text[row.cellIndex + 3] ?? []).filter(Boolean);
    const guestName = row.text[row.cellIndex + 1]?.[0] || '';
    return {
      ...row,
      candidate: {
        guestName: /\p{L}/u.test(guestName) ? guestName : null,
        arrivalDate: dates.length === 2 ? parseSearchResultDate(dates[0]) : null,
        departureDate: dates.length === 2 ? parseSearchResultDate(dates[1]) : null,
      },
    };
  });
}

function nameTokens(value) {
  const titles = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'judge']);
  const words = (value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [])
    .filter((word) => !titles.has(word));
  return words.filter((word, index) => word !== 'and' || index === 0 || index === words.length - 1).sort();
}

function legacyLookupOptions(confirmation) {
  const evidenceFile = process.env.STAY360_DATE_HINTS_FILE;
  let guestName;
  if (evidenceFile) {
    try {
      guestName = JSON.parse(readFileSync(evidenceFile, 'utf8')).candidates
        .find((candidate) => candidate.confirmation === confirmation)?.guestNameHint;
    } catch { /* Existing batch callers can still search without a usable name hint. */ }
  }
  return { guestName, arrivalDate: process.env.STAY360_PDF_ARRIVAL_DATE };
}

export function normalizeLookupOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('INVALID_LOOKUP_OPTIONS');
  if (options.guestName != null && (typeof options.guestName !== 'string' ||
      options.guestName.length > 256 || /[\r\n]/.test(options.guestName))) {
    throw new Error('INVALID_GUEST_NAME');
  }
  return { guestName: options.guestName?.trim() || null, arrivalDate: parseArrivalDate(options.arrivalDate) };
}

function lookupError(code, matches, searchedDateRange, searchResults) {
  return Object.assign(new Error(code), {
    candidates: matches.map((match) => match.candidate),
    searchedDateRange,
    searchResults,
  });
}

function matchHints(matches, guestName, arrivalDate) {
  const expectedName = guestName ? nameTokens(guestName) : null;
  const expectedDate = arrivalDate?.toISOString().slice(0, 10);
  return matches.map((match) => {
    let contradicted = false;
    let verified = true;
    if (expectedName) {
      const candidateName = nameTokens(match.candidate.guestName || '');
      if (expectedName.filter((word) => word.length > 1).length < 2 ||
          candidateName.filter((word) => word.length > 1).length < 2) verified = false;
      else if (candidateName.join('\0') !== expectedName.join('\0')) contradicted = true;
    }
    if (expectedDate) {
      if (!match.candidate.arrivalDate) verified = false;
      else if (match.candidate.arrivalDate !== expectedDate) contradicted = true;
    }
    return { match, contradicted, verified };
  });
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
        if (state.displayed > 0) return { popup, displayed: state.displayed, total: state.total };
        emptySince ??= Date.now();
        if (Date.now() - emptySince >= 500) return { popup, displayed: state.displayed, total: state.total };
      } else {
        emptySince = null;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('CONFIRMATION_SEARCH_TIMEOUT');
}

async function waitForSelectedDetails(page, popup, wanted) {
  const deadline = Date.now() + 30_000;
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

// Options: { guestName?, arrivalDate? (YYYY-MM-DD) }; omitted options retain legacy batch hints.
// Lookup errors include candidates, searchedDateRange and searchResults when available.
// Kept as an action on the caller's page so record-view reads can build on it.
export async function readConfirmationFromStay360(page, confirmation, options) {
  if (typeof confirmation !== 'string' || !confirmation.trim() || confirmation.length > 128 || /[\r\n]/.test(confirmation)) {
    throw new Error('INVALID_CONFIRMATION');
  }
  const wanted = confirmation.trim();
  // Keep the existing diagnostic batch working; explicit options never read process-wide hints.
  const hints = options === undefined ? legacyLookupOptions(wanted) : options;
  const { guestName, arrivalDate } = normalizeLookupOptions(hints);
  await installReadOnlyGuard(page.context());
  await installStay360NotesHandler(page);

  const search = page.locator('input[name="search"]:visible');
  await search.waitFor({ state: 'visible' });
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
  await adjacentRuns[0].click();

  let searchResult = await waitForSearch(page, searchBox);
  let popup = searchResult.popup;
  let searchWindow;
  if (arrivalDate) {
    searchWindow = await adjustSearchWindow(page, popup, arrivalDate);
    if (searchWindow) {
      searchResult = await waitForSearch(page, searchBox);
      popup = searchResult.popup;
    }
  }
  const searchedDateRange = await readSearchDateRange(popup).catch(() => null);
  const searchResults = {
    displayed: searchResult.displayed,
    total: searchResult.total,
    complete: searchResult.total <= searchResult.displayed,
  };
  const matches = await exactSearchMatches(popup, wanted);
  if (!searchResults.complete) throw lookupError('SEARCH_RESULTS_CAPPED', matches, searchedDateRange, searchResults);
  if (matches.length === 0) throw lookupError('CONFIRMATION_NOT_FOUND', matches, searchedDateRange, searchResults);

  const viable = matchHints(matches, guestName, arrivalDate).filter((item) => !item.contradicted);
  if (viable.length === 0) throw lookupError('CONFIRMATION_HINT_MISMATCH', matches, searchedDateRange, searchResults);
  if (viable.length !== 1 || !viable[0].verified) {
    const error = matches.length === 1 ? 'CONFIRMATION_HINT_UNVERIFIED' : 'AMBIGUOUS_CONFIRMATION';
    throw lookupError(error, matches, searchedDateRange, searchResults);
  }
  const selected = viable[0].match;
  const matchedHints = [guestName && 'guestName', arrivalDate && 'arrivalDate'].filter(Boolean);
  const matchSelection = matches.length > 1 ? `unique ${matchedHints.join(' and ')} match` : null;

  // The popup can refresh; never click an index whose displayed identity changed.
  const current = await exactSearchMatches(popup, wanted);
  if (current.length !== matches.length || current.some((item, index) => item.index !== matches[index].index ||
      JSON.stringify(item.text) !== JSON.stringify(matches[index].text))) {
    throw lookupError('SEARCH_RESULTS_CHANGED', current, searchedDateRange, { ...searchResults, complete: false });
  }

  const row = popup.locator('.x-grid-row:visible').nth(selected.index);
  const selectedRow = (await row.innerText()).trim();
  await row.locator('td, [role="gridcell"], .x-grid-cell').nth(selected.cellIndex).click();
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
    notes: [...notes, ...await takeHandledNotes(page)],
    details,
    searchedDateRange,
    searchResults,
    ...(matchedHints.length ? { matchedHints } : {}),
    ...(searchWindow ? { searchWindow } : {}),
    ...(matchSelection ? { matchSelection } : {}),
    method: 'Playwright UI search and selection; no direct HMS API calls.',
  };
}

/*
1a return (reader): { ok, confirmation, selectedRow, notes, details, method,
  searchedDateRange, searchResults, matchedHints?, searchWindow?, matchSelection? }.
Search failures carry candidates (guestName, arrivalDate, departureDate),
searchedDateRange and searchResults. searchWindow has arrivalDateHint and
searchStartDate. notes[] has title, text, fields and privateCapture.
details: { confirmationInHeader, cards, visibleFormFields,
  visiblePageTextOutsideGrids, captureScope }.
cards[]: { title, fields, visibleText, grids }; fields[] and
  visibleFormFields[]: { label, name, type, value }; notes[].fields[] has
  name, type, value. The CLI adds elapsedMs.

Observed field inventory from 892 HRCEN reads (2026-10-29/30), including blank
fields when rendered. Some fields appear conditionally; other tabs and
unrendered content are excluded. These are observations, not a write schema.
Below: label [DOM name]; type is div for all observed fields.

Stay:
  Add-On Total [enhancedexptotal] | adults [adults] | Arrival [arrivaldate] | Average Nightly [averagenightly]
  Departure [departuredate] | Meal Plan [mealplan] | nights [nights] | Rate Plan [rateplan]
  Reservation Note [reservationnote] | Room [room] | Room Type [roomtype]
  Room Type for Charge [roomtypecharge] | Status [status] | Stay Grand Total [grandtotal] | Tax [tax]

Associations:
  A/R Account [araccountname] | Booking Agency [ta1] | Channel [channeldesc] | Group [groupname]
  Lease [leasenumber] | Market Segment [marketsegmentdesc] | Organization [company]
  Source of Business [sourceofbusinessdesc]

*/

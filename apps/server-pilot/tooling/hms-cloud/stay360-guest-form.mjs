// Read each rendered Guest Details row's form in the already-open Guest Stay.
import { dismissNotesOrThrow, takeHandledNotes } from './stay360-notes.mjs';
import { openStay360RecordTab } from './stay360-record-tabs.mjs';

/** Run after readGuest: select each loaded guest row and return its rendered form. */
export async function readGuestFormsFromStay360(page, confirmation) {
  const { frame, notes } = await openStay360RecordTab(page, confirmation, 'Guest Details');

  const grid = frame.locator('.x-grid:visible').filter({
    has: frame.locator('.x-column-header-text').filter({ hasText: /^Primary Guest$/ }),
  });
  if (await grid.count() !== 1) throw new Error('GUEST_GRID_NOT_UNIQUE');
  const gridState = () => grid.evaluate((element) => {
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const columns = [...element.querySelectorAll('.x-column-header-text')].filter(visible)
      .map((header) => clean(header.innerText));
    const store = globalThis.Ext?.getCmp(element.id)?.getStore?.();
    const rows = [...element.querySelectorAll('.x-grid-row')].filter(visible).map((row, index) => {
      const cells = [...row.querySelectorAll('.x-grid-cell')]
        .filter((cell) => cell.closest('.x-grid-row') === row && visible(cell))
        .map((cell) => clean(cell.innerText));
      const indexAttr = row.getAttribute('data-recordindex');
      const recordIndex = indexAttr !== null && /^\d+$/.test(indexAttr) ? Number(indexAttr) : index;
      const data = store?.getAt?.(recordIndex)?.data;
      const firstName = cells[columns.indexOf('First Name')] || '';
      const lastName = cells[columns.indexOf('Last Name')] || '';
      const matchesStore = data && clean(data.firstname).toLowerCase() === firstName.toLowerCase() &&
        clean(data.lastname).toLowerCase() === lastName.toLowerCase();
      return { index, cells, firstName, lastName,
        nativeGuestId: matchesStore ? clean(data.guestid) || null : null };
    });
    const loaded = store?.getCount?.();
    const total = store?.getTotalCount?.();
    const loadedRows = Number.isInteger(loaded) && loaded >= 0 ? loaded : null;
    const reportedTotalRows = Number.isInteger(total) && total >= 0 ? total : null;
    return { id: element.id, columns, rows, coverage: {
      renderedRows: rows.length, loadedRows, reportedTotalRows,
      reportedTotalConsistent: reportedTotalRows === null ? null :
        reportedTotalRows >= Math.max(rows.length, loadedRows ?? 0),
      allLoadedRowsRendered: loadedRows === null ? null : loadedRows === rows.length,
      complete: loadedRows > rows.length || reportedTotalRows > rows.length ? false : null,
    } };
  });
  const initial = await gridState();
  if (!initial.columns.includes('First Name') || !initial.columns.includes('Last Name')) {
    throw new Error('GUEST_GRID_COLUMNS_MISSING');
  }
  if (initial.rows.some((row) => !row.firstName && !row.lastName)) {
    throw new Error('GUEST_ROW_IDENTITY_MISSING');
  }
  if (initial.coverage.loadedRows > initial.rows.length) throw new Error('GUEST_GRID_LOADED_ROWS_NOT_RENDERED');

  const guests = [];
  const signature = (state) => JSON.stringify({ columns: state.columns, rows: state.rows,
    loadedRows: state.coverage.loadedRows, reportedTotalRows: state.coverage.reportedTotalRows });
  for (const row of initial.rows) {
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));
    if (signature(await gridState()) !== signature(initial)) throw new Error('GUEST_GRID_CHANGED');
    const sameNameRows = initial.rows.filter((candidate) =>
      candidate.firstName.toLowerCase() === row.firstName.toLowerCase() &&
      candidate.lastName.toLowerCase() === row.lastName.toLowerCase());
    const ids = sameNameRows.map((candidate) => candidate.nativeGuestId?.toLowerCase() || null);
    if (sameNameRows.length > 1 && (ids.some((id) => !id) || new Set(ids).size !== ids.length)) {
      guests.push({ row, profileId: null, profileIdStatus: 'unverified', identityVerifiedBy: null,
        duplicateNameInGrid: true, error: 'GUEST_IDENTITY_AMBIGUOUS', form: null });
      continue;
    }
    const selected = grid.locator('.x-grid-row:visible').nth(row.index);
    await selected.locator('.x-grid-cell').first().click();
    await frame.waitForFunction(({ gridId, rowIndex, firstName, lastName, nativeGuestId }) => {
      const visible = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const gridElement = document.getElementById(gridId);
      const rows = gridElement ? [...gridElement.querySelectorAll('.x-grid-row')].filter(visible) : [];
      if (!rows[rowIndex]?.classList.contains('x-grid-row-selected')) return false;
      if ([...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(visible)) return false;
      const formValue = (name) => {
        const fields = [...document.querySelectorAll(`input[name="${name}"]`)]
          .filter((input) => visible(input) && !input.closest('.x-grid'));
        return fields.length === 1 ? clean(fields[0].value) : null;
      };
      const actualFirst = formValue('firstname');
      const actualLast = formValue('lastname');
      if (actualFirst === null || actualLast === null) return false;
      if (clean(firstName) !== actualFirst || clean(lastName) !== actualLast) return false;
      return !nativeGuestId || formValue('guestid') === clean(nativeGuestId);
    }, { gridId: initial.id, rowIndex: row.index, firstName: row.firstName,
      lastName: row.lastName, nativeGuestId: row.nativeGuestId }, { timeout: 20_000 });
    await page.waitForTimeout(300);
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));

    const form = await frame.evaluate(() => {
      const visible = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
      const fields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"], .x-form-display-field')]
        .filter(visible)
        .filter((element) => !element.closest('.x-grid') && !['hidden', 'password'].includes(element.type))
        .filter((element) => element.type !== 'button' || ['checkbox', 'radio'].includes(element.getAttribute('role')))
        .map((element) => {
          let item = element.closest('.x-form-item');
          let label = '';
          while (item && !label) {
            const ownLabel = [...item.querySelectorAll('.x-form-item-label, label')]
              .find((candidate) => candidate.closest('.x-form-item') === item && visible(candidate));
            label = normalize(ownLabel?.innerText);
            item = item.parentElement?.closest('.x-form-item');
          }
          const role = element.getAttribute('role');
          const type = ['checkbox', 'radio'].includes(role) ? role : (element.type || element.tagName.toLowerCase());
          let value;
          if (type === 'checkbox' || type === 'radio') {
            const aria = element.getAttribute('aria-checked');
            value = aria === 'true' || (aria !== 'false' && (element.checked ||
              Boolean(element.closest('.x-form-cb-checked, .x-form-checkbox-checked')))) || false;
          } else if (element.tagName === 'SELECT') {
            value = [...element.selectedOptions].map((option) => normalize(option.textContent)).join(', ');
          } else {
            value = String(element.value ?? element.innerText ?? element.textContent ?? '').trim();
          }
          const panel = element.closest('.x-panel');
          const title = panel && [...panel.querySelectorAll('.x-panel-header-text')]
            .find((candidate) => candidate.closest('.x-panel') === panel && visible(candidate));
          return { section: normalize(title?.innerText) || null,
            label: label || element.getAttribute('aria-label') || element.name || null,
            name: element.name || null, type, value };
        });
      return { fields };
    });
    const identityFields = (name) => form.fields.filter((field) => field.name === name);
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const first = identityFields('firstname');
    const last = identityFields('lastname');
    const profile = identityFields('guestid');
    if (!(await selected.evaluate((element) => element.classList.contains('x-grid-row-selected'))) ||
        signature(await gridState()) !== signature(initial) || first.length !== 1 || last.length !== 1 ||
        clean(first[0].value) !== clean(row.firstName) || clean(last[0].value) !== clean(row.lastName) ||
        (row.nativeGuestId && (profile.length !== 1 || clean(profile[0].value) !== clean(row.nativeGuestId)))) {
      throw new Error('GUEST_FORM_IDENTITY_CHANGED');
    }
    const profileId = profile.length === 1 ? profile[0].value || null : null;
    guests.push({ row, profileId, profileIdStatus: !profile.length ? 'missing' : profile.length > 1
      ? 'ambiguous' : profileId ? 'present' : 'empty',
      identityVerifiedBy: row.nativeGuestId ? 'row_name_and_native_id' : 'selected_row_and_name',
      duplicateNameInGrid: sameNameRows.length > 1, form });
  }
  notes.push(...await takeHandledNotes(page));
  const formsRead = guests.filter((guest) => guest.form !== null).length;
  return { notes, grid: { ...initial, coverage: { ...initial.coverage, formsRead,
    unresolvedIdentities: guests.length - formsRead } }, guests,
    captureScope: 'Read rendered forms for identifiable guest rows; ambiguous identities have no form. Hidden content and unloaded grid pages excluded.' };
}

// Read linked reservation rows from the already-open stay, without editing them.
import { openStay360RecordTab } from './stay360-record-tabs.mjs';
import { dismissNotesOrThrow, takeHandledNotes } from './stay360-notes.mjs';

export async function readAssociatedReservationsFromStay360(page, confirmation) {
  const { frame, notes } = await openStay360RecordTab(page, confirmation, 'Associated Reservations');
  await frame.waitForFunction(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown).filter((grid) =>
      [...grid.querySelectorAll('.x-column-header-text')].some((header) => shown(header) && header.innerText.trim() === 'Confirmation Number'));
    if (grids.length !== 1) return false;
    const store = globalThis.Ext?.getCmp(grids[0].id)?.getStore?.();
    return Boolean(store) && !store.isLoading?.();
  }, null, { timeout: 25000 });
  await page.waitForTimeout(1200);
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  const result = await frame.evaluate(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown).filter((grid) =>
      [...grid.querySelectorAll('.x-column-header-text')].some((header) => shown(header) && clean(header.innerText) === 'Confirmation Number'));
    if (grids.length !== 1) throw new Error('ASSOCIATED_GRID_NOT_UNIQUE');
    const grid = grids[0];
    const store = globalThis.Ext?.getCmp(grid.id)?.getStore?.();
    if (!store || store.isLoading?.()) throw new Error('ASSOCIATED_GRID_NOT_LOADED');
    const columns = [...grid.querySelectorAll('.x-column-header-text')].filter(shown).map((header) => clean(header.innerText));
    const rows = [...grid.querySelectorAll('.x-grid-row')].filter(shown).map((row) =>
      [...row.querySelectorAll('.x-grid-cell')].filter((cell) => cell.closest('.x-grid-row') === row && shown(cell))
        .map((cell) => clean(cell.innerText)));
    const loadedRowCount = store.getCount?.() ?? null;
    const totalRowCount = store.getTotalCount?.() ?? null;
    return { columns, rows, loadedRowCount, totalRowCount,
      possiblyTruncated: (loadedRowCount != null && loadedRowCount > rows.length) ||
        (totalRowCount != null && loadedRowCount != null && totalRowCount !== loadedRowCount),
      coverage: { complete: null, refreshVerified: false },
      captureScope: 'Currently rendered rows of the loaded Associated Reservations grid; unloaded pages are excluded.' };
  });
  notes.push(...await takeHandledNotes(page));
  return { ...result, notes };
}

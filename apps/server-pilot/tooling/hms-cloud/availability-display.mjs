// Capture only price text rendered by HMS and correlated to the current response.
const clean = (value) => String(value ?? '').trim();
const identity = (property, room, rate, promotion) => JSON.stringify([property, room, rate, clean(promotion)]);

function isoDate(value) {
  const text = clean(value);
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (match) return `${match[3]}-${match[1]}-${match[2]}`;
  match = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(text);
  if (match) {
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
      .indexOf(match[2].toUpperCase()) + 1;
    return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}` : null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function expectedRows(data) {
  const rows = new Map();
  for (const property of data.children || []) {
    if (!property?.isprop || property.issummary) continue;
    for (const room of property.children || []) for (const rate of room.children || []) {
      const key = identity(property.code, room.code, rate.code, rate.promotioncode);
      const entries = rows.get(key) || [];
      entries.push({ property, room, rate });
      rows.set(key, entries);
    }
  }
  return rows;
}

async function readVisibleGrid(surface) {
  return surface.evaluate(() => {
    const shown = (el) => el && Boolean(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility === 'visible';
    return (Ext.ComponentQuery.query('treepanel,treegrid') || []).filter((grid) => shown(grid.getEl?.()?.dom)).map((grid) => {
      const root = grid.getEl().dom, view = grid.getView?.();
      const columns = (grid.getColumnManager?.()?.getColumns?.() || []).filter((column) =>
        !column.hidden && /^columns\.col\d+\.value$/.test(column.dataIndex || ''));
      const bounds = root.getBoundingClientRect();
      const details = (record) => record ? { code: record.data.code, isprop: record.data.isprop,
        isroomtype: record.data.isroomtype, currency: record.data.currency, promotion: record.data.promotioncode,
        fields: Object.fromEntries(Object.entries(record.data).filter(([key]) =>
          /^columns\.col\d+\.(value|restricted|israteavailable|combClosed)$/.test(key))) } : null;
      const rows = [...root.querySelectorAll('.x-grid-row, .x-grid-data-row')].filter(shown).map((element) => {
        const record = view?.getRecord?.(element);
        const cells = columns.map((column) => {
          const matches = [...element.querySelectorAll('td')].filter((td) =>
            td.classList.contains(`x-grid-cell-headerId-${column.id}`));
          if (matches.length !== 1) return null;
          const td = matches[0], rect = td.getBoundingClientRect();
          const inner = td.querySelector('.x-grid-cell-inner') || td, style = getComputedStyle(inner);
          const clipped = inner.scrollWidth > inner.clientWidth + 1 &&
            (['hidden', 'clip'].includes(style.overflowX) || style.textOverflow === 'ellipsis');
          const onScreen = shown(td) && rect.left >= Math.max(0, bounds.left) && rect.right <= Math.min(innerWidth, bounds.right) &&
            rect.top >= Math.max(0, bounds.top) && rect.bottom <= Math.min(innerHeight, bounds.bottom);
          const text = onScreen && !clipped ? inner.innerText?.trim() : '';
          const header = /data-date=["']?([^\s>"']+)/i.exec(column.text || '')?.[1] || null;
          return { dataIndex: column.dataIndex, header, text: text || null };
        }).filter(Boolean);
        return { rate: details(record), room: details(record?.parentNode), property: details(record?.parentNode?.parentNode), cells };
      });
      return { rows };
    });
  });
}

function correlate(data, grids) {
  const expected = expectedRows(data);
  const cells = [];
  let visibleRateRows = 0, visiblePriceCells = 0;
  for (const grid of grids) for (const row of grid.rows) {
    if (!row.room?.isroomtype || !row.property?.isprop) continue;
    visibleRateRows += 1;
    const candidates = expected.get(identity(row.property.code, row.room.code, row.rate?.code, row.rate?.promotion)) || [];
    if (candidates.length !== 1) continue;
    const { property, room, rate } = candidates[0];
    if (typeof rate.currency !== 'string' || rate.currency !== row.rate.currency) continue;
    for (const cell of row.cells) {
      if (!cell.text || cell.text.length > 200) continue;
      visiblePriceCells += 1;
      const match = /^columns\.col(\d+)\.value$/.exec(cell.dataIndex);
      const index = match ? Number(match[1]) - 1 : -1;
      const date = isoDate(data.datesList[index]);
      const key = `col${index + 1}`;
      const rawCell = rate.columns?.[key];
      if (!date || isoDate(cell.header) !== date || rawCell?.value == null ||
          !Object.is(rawCell.value, row.rate.fields[cell.dataIndex]) ||
          !Object.is(room.columns?.[key]?.value, row.room.fields[cell.dataIndex]) ||
          !Object.is(property.columns?.[key]?.value, row.property.fields[cell.dataIndex]) ||
          ['restricted', 'israteavailable', 'combClosed'].some((field) => Object.hasOwn(rawCell, field) &&
            !Object.is(rawCell[field], row.rate.fields[`columns.${key}.${field}`]))) continue;
      cells.push({ propertyCode: property.code, roomTypeCode: room.code, ratePlanCode: rate.code,
        promotionCode: rate.promotioncode ?? null, date, responseValue: rawCell.value,
        currency: rate.currency, displayedText: cell.text });
    }
  }
  return { cells, coverage: { visibleRateRows, visiblePriceCells, correlatedPriceCells: cells.length,
    exhaustive: false } };
}

/** Called while the availability search owns the page; no UI actions are taken. */
export async function captureAvailabilityDisplay(surface, snapshot, { timeoutMs = 4000 } = {}) {
  const data = snapshot?.response?.availabilitydata;
  if (!data || !Array.isArray(data.datesList) || !Array.isArray(data.children)) return { outcome: 'unavailable' };
  if (!expectedRows(data).size) return { outcome: 'unavailable', coverage: { visibleRateRows: 0, visiblePriceCells: 0,
    correlatedPriceCells: 0, exhaustive: false } };
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = correlate(data, await readVisibleGrid(surface));
    if (result.cells.length) return { outcome: 'captured', source: 'visible_hms_grid', ...result };
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return { outcome: 'unavailable', ...result };
}

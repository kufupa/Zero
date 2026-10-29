// Read-only UI steps that operate on a page already positioned in Centurion Stay 360.
// Output and observed fields: ./STAY360-ARRIVALS.md.
const viewport = { width: 1440, height: 1000 };

const inViewport = (box) => !!box && box.width > 0 && box.height > 0 && box.x < viewport.width &&
  box.x + box.width > 0 && box.y < viewport.height && box.y + box.height > 0;

async function waitNoMask(page, ms) {
  const end = Date.now() + ms;
  const masks = page.locator('.x-mask:visible, .x-mask-msg:visible, .x-loadmask:visible');
  while (Date.now() < end) {
    if (!(await masks.count())) return true;
    await page.waitForTimeout(100);
  }
  return !(await masks.count());
}

export async function readArrivalFromStay360(page, arrivalNumber) {
  if (!Number.isSafeInteger(arrivalNumber) || arrivalNumber < 1) {
    throw new Error('INVALID_ARRIVAL_NUMBER');
  }

  const arrivals = page.getByText('Arrivals', { exact: true });
  const deadline = Date.now() + 4_500;
  let arrivalsIndex = -1;
  while (Date.now() < deadline) {
    for (let index = 0, count = await arrivals.count(); index < count; index += 1) {
      const locator = arrivals.nth(index);
      const box = await locator.boundingBox().catch(() => null);
      if (await locator.isVisible().catch(() => false) && inViewport(box)) {
        arrivalsIndex = index;
        break;
      }
    }
    if (arrivalsIndex >= 0) break;
    await page.waitForTimeout(100);
  }
  if (arrivalsIndex < 0) throw new Error('ARRIVALS_TAB_NOT_IN_VIEWPORT');
  if (!await waitNoMask(page, 2_200)) throw new Error('STAY360_PROCESSING_MASK_STILL_VISIBLE');
  await arrivals.nth(arrivalsIndex).click({ timeout: 2_200 });
  if (!await waitNoMask(page, 2_200)) throw new Error('ARRIVALS_PROCESSING_MASK_STILL_VISIBLE');

  const rows = page.locator('.x-grid-row:visible');
  const candidates = [];
  for (let index = 0, count = await rows.count(); index < count; index += 1) {
    const row = rows.nth(index);
    const className = await row.getAttribute('class') || '';
    const box = await row.boundingBox().catch(() => null);
    if (inViewport(box) && await row.locator('td, .x-grid-cell, [role="gridcell"]').count() > 1 &&
        !/x-grid-tree-node/.test(className)) candidates.push(row);
  }
  const row = candidates[arrivalNumber - 1];
  if (!row) throw new Error('ARRIVAL_ROW_NOT_VISIBLE');

  const selectedArrivalRow = (await row.innerText()).trim();
  const arrivalGridId = await row.evaluate((el) => {
    let grid = el.closest('.x-grid');
    while (grid?.parentElement?.closest('.x-grid')) grid = grid.parentElement.closest('.x-grid');
    return grid?.id || null;
  });
  await row.scrollIntoViewIfNeeded({ timeout: 1_200 });
  await row.locator('td, .x-grid-cell, [role="gridcell"]').first().click({ timeout: 2_200 });
  if (!await waitNoMask(page, 2_200)) throw new Error('DETAIL_PROCESSING_MASK_STILL_VISIBLE');

  const details = await page.evaluate(({ selectedArrivalRow, arrivalGridId }) => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const grids = [...document.querySelectorAll('.x-grid')].filter(visible)
      .filter((grid, _, all) => !all.some((other) => other !== grid && other.contains(grid)));
    let arrivalGrid = arrivalGridId ? document.getElementById(arrivalGridId) : null;
    arrivalGrid ??= grids.find((grid) => [...grid.querySelectorAll('.x-grid-row')]
      .some((candidate) => normalize(candidate.innerText) === normalize(selectedArrivalRow))) || null;
    if (arrivalGrid && !visible(arrivalGrid)) arrivalGrid = null;
    if (!arrivalGrid && grids.some((grid) => [...grid.querySelectorAll('.x-grid-row')].filter(visible).length > 1)) {
      throw new Error('ARRIVAL_LIST_GRID_NOT_IDENTIFIED');
    }

    const visibleFormFields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')]
      .filter((el) => visible(el) && !['hidden', 'password'].includes(el.type) && !arrivalGrid?.contains(el))
      .map((el) => {
        const item = el.closest('.x-form-item, .x-form-fieldcontainer');
        const label = item?.querySelector('.x-form-item-label, label, .x-form-label')?.innerText?.trim() ||
          el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.id;
        const value = el.tagName === 'SELECT'
          ? [...el.selectedOptions].map((option) => option.textContent?.trim()).filter(Boolean).join(', ')
          : (el.value ?? el.innerText ?? '').trim();
        return label ? { label, value } : null;
      }).filter(Boolean);
    const visibleGridText = grids.filter((grid) => grid !== arrivalGrid)
      .map((grid) => grid.innerText?.trim()).filter(Boolean);
    const text = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const value = normalize(node.textContent);
      if (!value || !node.parentElement || !visible(node.parentElement) || node.parentElement.closest('.x-grid') ||
          /^(Processing request|Loading\.\.\.)$/i.test(value)) continue;
      text.push(value);
    }
    return {
      visibleFormFields,
      visibleGridText,
      visiblePageTextOutsideGrids: text.join('\n'),
      captureScope: 'Rendered visible record page; arrivals list excluded; hidden tabs not opened.',
    };
  }, { selectedArrivalRow, arrivalGridId });

  return {
    ok: true,
    arrivalNumber,
    selectedArrivalRow,
    details,
    method: 'Playwright UI clicks only; no request interception or direct HMS API calls.',
  };
}

// Open the selected Stay 360 record and read its Record View in the same page.
import { dismissNotesOrThrow } from './stay360-confirmation.mjs';
import { installReadOnlyGuard } from './hms-read-only-guard.mjs';

export async function readRecordViewFromStay360(page, confirmation) {
  const wanted = typeof confirmation === 'string' ? confirmation.trim() : '';
  if (!wanted) throw new Error('INVALID_CONFIRMATION');
  await installReadOnlyGuard(page.context());
  const headers = page.locator('h1.recordcode:visible');
  if (await headers.count() !== 1 || (await headers.innerText()).trim() !== wanted) {
    throw new Error('CONFIRMATION_HEADER_MISMATCH');
  }

  const notes = await dismissNotesOrThrow(page);
  const stay = page.locator('.gs-panel:visible').filter({
    has: page.locator('.x-panel-header-text').filter({ hasText: /^Stay$/ }),
  });
  const button = stay.locator('a.gs-header-btn:visible').filter({ has: page.locator('.gs-stay-icon') });
  if (await stay.count() !== 1 || await button.count() !== 1) throw new Error('STAY_BUTTON_NOT_UNIQUE');
  await button.click({ timeout: 0 });

  const deadline = Date.now() + 10_000;
  let frame;
  while (Date.now() < deadline) {
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
    if (await frames.count() > 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
    if (await frames.count() === 1) {
      const handle = await frames.elementHandle();
      frame = await handle?.contentFrame();
      if (frame) {
        notes.push(...await dismissNotesOrThrow(frame));
        const state = await frame.evaluate(() => {
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const active = [...document.querySelectorAll('.x-tab-active')]
            .some((tab) => visible(tab) && tab.innerText.trim() === 'Record View');
          const confirmation = [...document.querySelectorAll('input[name="confirmationnumber"]')]
            .filter(visible).map((input) => input.value.trim());
          const status = [...document.querySelectorAll('input[name="status"]')]
            .some((input) => visible(input) && input.value.trim());
          const masked = [...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(visible);
          return { active, confirmation, status, masked };
        }).catch(() => null); // A newly opened frame can still be navigating.
        if (state?.confirmation.length > 1) throw new Error('RECORD_CONFIRMATION_NOT_UNIQUE');
        if (state?.confirmation[0] && state.confirmation[0] !== wanted) throw new Error('RECORD_CONFIRMATION_MISMATCH');
        if (state?.active && state.confirmation[0] === wanted && state.status && !state.masked) break;
      }
    }
    frame = null;
    await page.waitForTimeout(100);
  }
  if (!frame) throw new Error('RECORD_VIEW_NOT_LOADED');

  // Expand only the form's collapsed panels, using their expand icons.
  const collapsed = frame.locator('.x-panel.x-panel-collapsed:visible');
  for (let count = 0; await collapsed.count(); count += 1) {
    if (count >= 20) throw new Error('RECORD_PANELS_NOT_EXPANDED');
    const panel = collapsed.first();
    const expand = panel.locator(':scope > .x-panel-header .x-tool').filter({
      has: frame.locator('img[class*="x-tool-expand-"]'),
    });
    if (await expand.count() !== 1) throw new Error('RECORD_EXPAND_NOT_UNIQUE');
    await expand.click({ timeout: 0 });
    await page.waitForTimeout(150);
    notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
    notes.push(...await dismissNotesOrThrow(frame));
  }

  const details = await frame.evaluate(() => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const fields = [...document.querySelectorAll('input, textarea, select, [contenteditable="true"], .x-form-display-field')]
      .filter(shown)
      .filter((element) => !['hidden', 'password'].includes(element.type))
      .filter((element) => element.type !== 'button' || ['checkbox', 'radio'].includes(element.getAttribute('role')))
      .filter((element) => !element.closest('.x-grid'))
      .map((element) => {
        let item = element.closest('.x-form-item');
        let label = '';
        while (item && !label) {
          label = normalize(item.querySelector('.x-form-item-label, label')?.innerText);
          item = item.parentElement?.closest('.x-form-item');
        }
        const role = element.getAttribute('role');
        const type = ['checkbox', 'radio'].includes(role) ? role : (element.type || element.tagName.toLowerCase());
        let value;
        if (type === 'checkbox' || type === 'radio') {
          const aria = element.getAttribute('aria-checked');
          value = aria === 'true' || (aria !== 'false' && (element.checked ||
            element.closest('.x-form-cb-checked, .x-form-checkbox-checked'))) || false;
        } else if (element.tagName === 'SELECT') {
          value = [...element.selectedOptions].map((option) => normalize(option.textContent)).join(', ');
        } else {
          value = String(element.value ?? element.innerText ?? element.textContent ?? '').trim();
        }
        const panel = element.closest('.x-panel');
        return {
          section: normalize(panel?.querySelector('.x-panel-header-text')?.innerText) || null,
          label: label || element.getAttribute('aria-label') || element.name || null,
          name: element.name || null,
          type,
          value,
        };
      });
    const grids = [...document.querySelectorAll('.x-grid')].filter(shown)
      .filter((grid, _, all) => !all.some((outer) => outer !== grid && outer.contains(grid)))
      .map((grid) => grid.innerText.trim());
    const confirmationFields = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(shown);
    return {
      confirmationInRecord: confirmationFields.length === 1 ? confirmationFields[0].value.trim() : null,
      activeTab: [...document.querySelectorAll('.x-tab-active')].find(shown)?.innerText.trim() || null,
      fields,
      visibleText: document.body.innerText.trim(),
      grids,
      captureScope: 'Rendered Record View, including expanded form sections, off-screen rendered fields and current grid pages; other tabs, hidden content and unloaded grid pages excluded.',
    };
  });
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  if (details.confirmationInRecord !== wanted || details.activeTab !== 'Record View') {
    throw new Error('RECORD_CONFIRMATION_MISMATCH');
  }
  return { notes, details };
}

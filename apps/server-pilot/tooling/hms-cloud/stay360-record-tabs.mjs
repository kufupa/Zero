// Navigate between tabs in the already-open Guest Stay record.
import { dismissNotesOrThrow, installStay360NotesHandler } from '../playwright-quote/stay360-notes.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';

/** Verify the open stay and activate a record tab; the caller reads its contents. */
export async function openStay360RecordTab(page, confirmation, title) {
  const wanted = typeof confirmation === 'string' ? confirmation.trim() : '';
  const tabTitle = typeof title === 'string' ? title.trim() : '';
  if (!wanted) throw new Error('INVALID_CONFIRMATION');
  if (!tabTitle) throw new Error('INVALID_TAB_TITLE');
  await installReadOnlyGuard(page.context());
  await installStay360NotesHandler(page);
  const headers = page.locator('h1.recordcode:visible');
  if (await headers.count() !== 1 || (await headers.innerText()).trim() !== wanted) {
    throw new Error('CONFIRMATION_HEADER_MISMATCH');
  }
  const notes = await dismissNotesOrThrow(page, { allowRecordFrame: true });
  const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
  if (await frames.count() !== 1) throw new Error('RECORD_FRAME_NOT_UNIQUE');
  const isRecordFrame = await frames.evaluate((element) => {
    const url = new URL(element.src, location.href);
    return url.origin === location.origin && url.searchParams.get('initpath') === 'OSRESV';
  });
  if (!isRecordFrame) throw new Error('RECORD_FRAME_MISMATCH');
  const frame = await (await frames.elementHandle())?.contentFrame();
  if (!frame) throw new Error('RECORD_FRAME_NOT_LOADED');
  notes.push(...await dismissNotesOrThrow(frame));

  const record = frame.locator('.x-tab:visible').filter({ hasText: /^Record View$/ });
  if (await record.count() !== 1) throw new Error('RECORD_TAB_NOT_UNIQUE');
  if (!(await record.evaluate((element) => element.classList.contains('x-tab-active')))) await record.click();
  const recordState = await frame.waitForFunction((expected) => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const tab = [...document.querySelectorAll('.x-tab-active')].some((element) => shown(element) && element.innerText.trim() === 'Record View');
    const fields = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(shown);
    const masked = [...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(shown);
    if (!tab || masked || !fields.length || (fields.length === 1 && !fields[0].value.trim())) return false;
    return fields.length === 1 && fields[0].value.trim() === expected ? 'ready' : 'mismatch';
  }, wanted, { timeout: 20000 });
  const recordStatus = await recordState.jsonValue();
  await recordState.dispose();
  if (recordStatus === 'mismatch') throw new Error('RECORD_CONFIRMATION_MISMATCH');
  const escaped = tabTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tab = frame.locator('.x-tab:visible').filter({ hasText: new RegExp(`^${escaped}$`) });
  if (await tab.count() !== 1) {
    throw new Error(tabTitle === 'Guest Details' ? 'GUEST_DETAILS_TAB_NOT_UNIQUE' : 'TAB_NOT_UNIQUE');
  }
  if (tabTitle !== 'Record View') await tab.click();
  await frame.waitForFunction((name) => {
    const shown = (element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return [...document.querySelectorAll('.x-tab-active')].some((element) => shown(element) && element.innerText.trim() === name) &&
      ![...document.querySelectorAll('.x-mask, .x-mask-msg, .x-loadmask')].some(shown);
  }, tabTitle, { timeout: 25000 });
  notes.push(...await dismissNotesOrThrow(page, { allowRecordFrame: true }));
  notes.push(...await dismissNotesOrThrow(frame));
  return { frame, notes };
}

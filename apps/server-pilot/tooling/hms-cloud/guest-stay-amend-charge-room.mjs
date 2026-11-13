import { isLabtestAmendStageContext } from './labtest-amend-save.mjs';
import { snapshotLabtestRecord } from './labtest-record.mjs';

/** Stage a validated charge room on the selected saved stay; Save remains fenced. */
export async function stageSavedChargeRoomForComposition(context, value) {
  if (!isLabtestAmendStageContext(context) || !context.isActive() ||
      typeof value !== 'string' || !/^(?:[A-Z0-9]{1,12})?$/.test(value)) throw new Error('CHARGE_ROOM_INVALID');
  const before = await snapshotLabtestRecord(context.frame), previous = String(before?.data?.roomtypecharge ?? '');
  const control = context.frame.locator('input[name="roomtypecharge"]:visible');
  if (await control.count() !== 1 || String(before?.values?.roomtypecharge ?? '') !== previous) throw new Error('CHARGE_ROOM_UNVERIFIED');
  if (previous !== value) {
    if (!context.rateStageGate?.armCharge(before, previous, value)) throw new Error('CHARGE_ROOM_GATE_INVALID');
    const response = context.page.waitForResponse((response) => {
      const request = response.request();
      try { return request.frame() === context.frame && request.method() === 'POST' &&
        new URL(request.url()).pathname === '/web/base/OSRESV.HDR.attributerefresh' &&
        new URLSearchParams(request.postData() || '').get('roomtypecharge') === value; }
      catch { return false; }
    }, { timeout: Math.min(15000, context.remainingMs()) }).catch(() => null);
    await control.fill(value);
    await control.press('Tab');
    const refreshed = await response;
    if (!refreshed || !context.rateStageGate.completeCharge(refreshed.status(), await refreshed.text()) ||
        !context.rateStageGate.chargeVerified()) throw new Error('CHARGE_ROOM_UNVERIFIED');
  }
  const synced = await control.evaluate((element, expected) => {
    const cmp = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const guests = [...document.querySelectorAll('input[name="guestid"]')].filter((node) =>
      (node.offsetWidth || node.offsetHeight) && getComputedStyle(node).visibility !== 'hidden' && !node.closest('.x-window'));
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.();
    if (!panel?.el?.dom?.contains(element) || cmp?.up?.('form') !== panel || element.disabled || element.readOnly ||
        String(cmp?.getValue?.() ?? '') !== expected || element.value !== expected ||
        String(cmp?.getSubmitData?.()?.roomtypecharge ?? '') !== expected || !record || typeof panel.updateRecord !== 'function') return false;
    panel.updateRecord(record);
    return String(record.data?.roomtypecharge ?? '') === expected;
  }, value);
  if (!synced || !context.isActive()) throw new Error('CHARGE_ROOM_UNVERIFIED');
  return snapshotLabtestRecord(context.frame);
}

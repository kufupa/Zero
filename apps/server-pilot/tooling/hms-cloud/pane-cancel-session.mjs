// Staff-approved cancellation on an owned HRCEN Cloud session.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { openLabtestCancellation, confirmLabtestCancellation } from './guest-stay-cancel.mjs';
import { verifySingleCancellationScope } from './cancel-association-scope.mjs';

const digits = (value) => typeof value === 'string' && /^\d{1,100}$/.test(value);
const day = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
const name = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  value === value.trim() && !/[\p{Cc}]/u.test(value);
const READ_BUDGET_MS = 15 * 60_000;
const COMMIT_BUDGET_MS = 20 * 60_000;
const neverDispatchedCancelProofs = new WeakMap();
const lookupOptions = (firstName, lastName, arrival) => {
  const guestName = firstName && lastName ? `${firstName} ${lastName}` : '';
  return { ...(guestName && guestName.length <= 256 ? { guestName } : {}), arrivalDate: arrival };
};

/** A one-use no-dispatch proof is scoped to the exact V2 cancel run and saved stay. */
export function consumeNeverDispatchedCancelProof(proof, intent) {
  const binding = proof && typeof proof === 'object' ? neverDispatchedCancelProofs.get(proof) : null;
  const target = intent?.target, recovery = intent?.recovery;
  if (!binding || intent?.operation !== 'cancel' || intent?.propertyCode !== 'HRCEN' ||
      target?.propertyCode !== binding.propertyCode || target?.kind !== 'saved' ||
      target?.confirmation !== binding.confirmation || target?.nativeStayId !== binding.nativeStayId ||
      recovery?.confirmation !== binding.confirmation || recovery?.nativeStayId !== binding.nativeStayId ||
      recovery?.cloudTargetKey !== binding.cloudTargetKey || recovery?.runId !== binding.runId) return false;
  neverDispatchedCancelProofs.delete(proof);
  return true;
}

function neverDispatchedCancelProof(input) {
  const expected = input?.expected;
  if (input?.mode !== 'commit' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.runId || '') ||
      input.target?.propertyCode !== 'HRCEN' || !/^\d+-\d+$/.test(input.confirmation || '') ||
      expected?.confirmation !== input.confirmation || !digits(expected?.nativeStayId) ||
      typeof input.cloudTargetKey !== 'string' || !input.cloudTargetKey) return null;
  const proof = Object.freeze({});
  neverDispatchedCancelProofs.set(proof, { runId: input.runId, propertyCode: input.target.propertyCode,
    confirmation: expected.confirmation, nativeStayId: expected.nativeStayId, cloudTargetKey: input.cloudTargetKey });
  return proof;
}
const field = (record, key) => {
  const fields = record?.details?.fields;
  if (!Array.isArray(fields)) return null;
  const found = fields.filter((item) => item?.name === key);
  if (found.length !== 1) return null;
  const value = key === 'reservationnote' ? found[0].rawValue : found[0].value;
  return typeof value === 'string' ? value : null;
};
const observedGuarantee = (value) => typeof value === 'string' && value.length <= 200 && !/[\p{Cc}]/u.test(value) ? value : '';
const cancelBusinessPreimage = (value) => ['confirmation', 'guestId', 'nativeStayId', 'firstName', 'lastName',
  'arrival', 'departure', 'roomType', 'ratePlan', 'note', 'cmsSend', 'allowRealGuest'].map((key) => value?.[key]);

/** Names and native IDs come only from the independently verified Record View. */
export function cancellationNativePreimage(record, { allowRealGuest = false } = {}) {
  const native = record?.nativePreimage;
  const note = field(record, 'reservationnote'), guarantee = field(record, 'guaranteetype');
  const deposit = field(record, 'depositreceived');
  const send = record?.details?.fields?.filter((item) => item?.name === 'udfchkbox04');
  const isLabtest = native?.firstName === 'Proof' && native?.lastName === 'Labtest' && native?.arrival >= '2027-01-01';
  if (!native || native.source !== 'record_view_ext_model' || native.propertyCode !== 'HRCEN' ||
      !/^\d+-\d+$/.test(native.confirmation || '') || !digits(native.guestId) || !digits(native.reservationStayId) ||
      native.status !== 'Reserved' || !name(native.firstName) || !name(native.lastName) ||
      !day(native.arrival) || !day(native.departure) || native.departure <= native.arrival ||
      (!allowRealGuest && !isLabtest) ||
      !/^[A-Z0-9]{1,12}$/.test(native.roomType || '') || !/^[A-Z0-9]{1,12}$/.test(native.ratePlan || '') ||
      typeof note !== 'string' || note.length > 2_000 ||
      !Array.isArray(send) || send.length !== 1 || typeof send[0].value !== 'boolean' ||
      (isLabtest && send[0].value !== false)) return null;
  return { confirmation: native.confirmation, guestId: native.guestId, nativeStayId: native.reservationStayId,
    firstName: native.firstName, lastName: native.lastName, arrival: native.arrival, departure: native.departure,
    roomType: native.roomType, ratePlan: native.ratePlan, note, depositReceived: deposit,
    expectedGuarantee: { code: observedGuarantee(native.guaranteeCode), display: observedGuarantee(guarantee) }, cmsSend: send[0].value,
    allowRealGuest: !isLabtest };
}

/** Status is useful on its own, but completion also requires the approved reason and note. */
async function cancellationReadback(page, input, { shallow, read }) {
  await shallow(page, input.expected.confirmation,
    lookupOptions(input.expected.firstName, input.expected.lastName, input.expected.arrival));
  const record = await read(page, input.expected.confirmation, { nativePropertyCode: 'HRCEN' });
  const native = record?.nativePreimage, expected = input.expected;
  if (!native || native.source !== 'record_view_ext_model' || native.propertyCode !== 'HRCEN' ||
      native.confirmation !== expected.confirmation || native.reservationStayId !== expected.nativeStayId ||
      native.guestId !== expected.guestId || native.firstName !== expected.firstName || native.lastName !== expected.lastName ||
      native.arrival !== expected.arrival || native.departure !== expected.departure ||
      !/^cancel(?:l)?ed$/i.test(native.status || '')) return null;
  const observed = { confirmation: native.confirmation, nativeStayId: native.reservationStayId, nativeGuestId: native.guestId,
    status: native.status, reasonCode: null, cancellationNote: null };
  const send = record?.details?.fields?.filter((item) => item?.name === 'udfchkbox04');
  if (field(record, 'reservationnote') !== expected.note || !Array.isArray(send) ||
      send.length !== 1 || send[0].value !== expected.cmsSend) return observed;
  try {
    const frames = page.locator('.x-window:visible:not(.x-menu) iframe:visible');
    if (await frames.count() !== 1) return observed;
    const frame = await (await frames.elementHandle())?.contentFrame();
    if (!frame) return observed;
    const verified = await frame.evaluate(({ expected, reasonCode, cancellationNote }) => {
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
        getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
      if (guests.length !== 1) return false;
      const panel = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form');
      const data = panel?.getRecord?.()?.data;
      if (!data || typeof data !== 'object') return false;
      const exact = (key, value) => Object.hasOwn(data, key) &&
        Object.keys(data).filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1 &&
        String(data[key] ?? '') === value;
      return exact('confirmationnumber', expected.confirmation) && exact('reservationstayid', expected.nativeStayId) &&
        exact('guestid', expected.guestId) && exact('cancelreason', reasonCode) &&
        exact('cancellationnote', cancellationNote) && exact('reservationstaystatus', 'CANCELED');
    }, { expected, reasonCode: input.reasonCode, cancellationNote: input.cancellationNote });
    return verified ? { ...observed, reasonCode: input.reasonCode, cancellationNote: input.cancellationNote } : observed;
  } catch { return observed; }
}

/** Read-only identity evidence cannot by itself resolve an uncertain penalty state. */
export async function provePositiveCancelRecovery(intent, { openSession = withCenturionStay360Page,
  shallow = readShallow, read = readRecord, freshRead = cancellationReadback } = {}) {
  try {
    const recovery = intent?.recovery, expected = recovery?.preimage;
    if (intent?.operation !== 'cancel' || intent.propertyCode !== 'HRCEN' || !expected ||
        !/^\d+-\d+$/.test(recovery.confirmation || '') || recovery.confirmation !== expected.confirmation ||
        !digits(recovery.nativeStayId) || recovery.nativeStayId !== expected.nativeStayId ||
        intent.nativeGuestId !== expected.guestId || intent.firstName !== expected.firstName ||
        intent.lastName !== expected.lastName || !day(expected.arrival) || !day(expected.departure) ||
        expected.departure <= expected.arrival || typeof recovery.reasonCode !== 'string' ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(recovery.reasonCode) || typeof recovery.cancellationNote !== 'string' ||
        recovery.cancellationNote.length > 200) return { outcome: 'unconfirmed' };
    const input = { expected, reasonCode: recovery.reasonCode, cancellationNote: recovery.cancellationNote };
    const options = { headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(5 * 60_000),
      ...(recovery.cloudTargetKey ? { cloudTargetKey: recovery.cloudTargetKey } : {}) };
    return await openSession(async (page) => {
      await installReadOnlyGuard(page.context());
      const readback = await freshRead(page, input, { shallow, read });
      if (!readback || readback.confirmation !== expected.confirmation || readback.nativeStayId !== expected.nativeStayId ||
          readback.nativeGuestId !== expected.guestId || readback.reasonCode !== recovery.reasonCode ||
          readback.cancellationNote !== recovery.cancellationNote || !/^cancel(?:l)?ed$/i.test(readback.status || '')) {
        return { outcome: 'unconfirmed' };
      }
      const screenshot = await page.screenshot({ fullPage: true });
      if (!Buffer.isBuffer(screenshot) || !screenshot.length || screenshot.length > 10 * 1024 * 1024) return { outcome: 'unconfirmed' };
      return { outcome: 'verified', confirmation: readback.confirmation, readback, screenshot };
    }, options);
  } catch { return { outcome: 'unconfirmed' }; }
}

/** Read/preview never confirms. Commit delegates its one exact Save to the server's claim callback. */
export async function runCloudPaneCancel(input, { openSession = withCenturionStay360Page, shallow = readShallow,
  read = readRecord, open = openLabtestCancellation, confirm = confirmLabtestCancellation,
  scope = verifySingleCancellationScope, freshRead = cancellationReadback, now = () => performance.now() } = {}) {
  if (input?.target?.propertyCode !== 'HRCEN' || !['read', 'preview', 'commit'].includes(input.mode) ||
      !/^\d+-\d+$/.test(input.confirmation || '') || !day(input.arrival) || typeof input.allowRealGuest !== 'boolean' ||
      (input.mode === 'commit' && (!input.expected || typeof input.beforeDispatch !== 'function' ||
        typeof input.dispatchWithAuthority !== 'function' || typeof input.continuationAllowed !== 'function' ||
        !Number.isSafeInteger(input.commitBudgetMs) || input.commitBudgetMs < 1 || input.commitBudgetMs > COMMIT_BUDGET_MS))) {
    return { outcome: 'refused_input', requestDispatched: false };
  }
  const started = now();
  const root = await mkdtemp(join(tmpdir(), 'pane-cloud-cancel-'));
  const sessionBudget = input.mode === 'commit' ? COMMIT_BUDGET_MS : READ_BUDGET_MS;
  const options = { headless: true, blockServiceWorkers: true, signal: AbortSignal.timeout(sessionBudget),
    ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}) };
  let writerSessionClosed = false, dispatched = false, confirmAttempted = false, result;
  let chargeAuthorityAttempted = false, chargeDecisionRequested = false, chargeDispatchAttempted = false, pendingChargeAuthority = 0;
  const awaitCharge = typeof input.awaitChargeApproval === 'function' ? async (...args) => {
    chargeDecisionRequested = true;
    return input.awaitChargeApproval(...args);
  } : undefined;
  const dispatchCharge = typeof input.dispatchChargeWithAuthority === 'function' ? async (...args) => {
    chargeDispatchAttempted = true;
    return input.dispatchChargeWithAuthority(...args);
  } : undefined;
  const prepareCharge = typeof input.prepareChargeWithAuthority === 'function' ? async () => {
    chargeAuthorityAttempted = true;
    pendingChargeAuthority++;
    try { return await input.prepareChargeWithAuthority(join(root, 'before.png')); }
    finally { pendingChargeAuthority--; }
  } : undefined;
  try {
    result = await openSession(async (page) => {
      await installReadOnlyGuard(page.context());
      await shallow(page, input.confirmation,
        lookupOptions(input.expected?.firstName, input.expected?.lastName, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = cancellationNativePreimage(record, { allowRealGuest: input.allowRealGuest });
      if (!expected || expected.confirmation !== input.confirmation || expected.arrival !== input.arrival ||
          (input.expected && JSON.stringify(cancelBusinessPreimage(expected)) !== JSON.stringify(cancelBusinessPreimage(input.expected)))) {
        return { outcome: 'refused_preimage', requestDispatched: false };
      }
      if (!await scope(page, expected)) return { outcome: 'refused_scope_unverified', requestDispatched: false };
      if (input.mode === 'read') return { outcome: 'read', expected, requestDispatched: false };
      await writeFile(join(root, 'before.png'), await page.screenshot({ fullPage: true }), { mode: 0o600 });
      const remaining = Math.floor(Math.min(sessionBudget, input.commitBudgetMs ?? sessionBudget) - (now() - started));
      if (input.mode === 'commit' && (remaining < 1 || input.continuationAllowed() !== true)) {
        return { outcome: 'not_dispatched', requestDispatched: false, dispatchCallbacksDrained: true };
      }
      const opened = await open(page, expected, input.mode === 'commit' ? {
        timeoutMs: remaining, continuationAllowed: input.continuationAllowed, awaitChargeApproval: awaitCharge,
        prepareChargeWithAuthority: prepareCharge,
      } : {});
      if (input.mode === 'preview' && opened.outcome === 'fee_dialog_pending' && opened.reasons?.length) {
        return { outcome: 'preview_ok', expected, reasons: opened.reasons, penaltyText: opened.penaltyText,
          policyFacts: opened.policyFacts ?? [], requestDispatched: false };
      }
      if (opened.outcome !== 'reason_ready') return { ...opened,
        outcome: opened.outcome === 'fee_dialog_pending' ? 'refused_penalty' : opened.outcome,
        expected, requestDispatched: false };
      if (input.mode === 'preview') return { outcome: 'preview_ok', expected, reasons: opened.reasons,
        policyFacts: opened.policyFacts ?? [], penaltyText: opened.penaltyText ?? null, requestDispatched: false };
      if (!opened.reasons?.some((item) => item.value === input.reasonCode && item.display === input.reasonLabel)) {
        return { outcome: 'refused_reason_missing', requestDispatched: false };
      }
      // The deadline covers the fresh read and authorization inside the paused request, not just the click.
      // Both the session and the worker's dispatch authority began before opening the reason dialog.
      const timeoutMs = Math.floor(Math.min(sessionBudget, input.commitBudgetMs) - (now() - started));
      if (timeoutMs < 1 || input.continuationAllowed() !== true) {
        return { outcome: 'not_dispatched', requestDispatched: false, dispatchCallbacksDrained: true };
      }
      confirmAttempted = true;
      const saved = await confirm(page, expected, { reasonCode: input.reasonCode, reasonLabel: input.reasonLabel,
        cancellationNote: input.cancellationNote, timeoutMs, beforeDispatch: input.beforeDispatch,
        continuationAllowed: input.continuationAllowed, awaitChargeApproval: awaitCharge,
        prepareChargeWithAuthority: prepareCharge,
        dispatchChargeWithAuthority: dispatchCharge,
        dispatchWithAuthority: (send, digest, request) => input.dispatchWithAuthority(send, digest, request, join(root, 'before.png')),
        onDispatched: () => { dispatched = true; } });
      return { ...saved, ...(opened.chargeApproved ? { outcome: 'fee_accepted_unconfirmed',
        penaltyText: opened.penaltyText ?? saved.penaltyText } : {}),
      requestDispatched: dispatched || saved.requestDispatched === true };
    }, options);
    writerSessionClosed = true;
  } catch {
    result = { outcome: dispatched ? 'uncertain' : 'execution_failure', requestDispatched: dispatched };
  }
  const screenshots = input.mode === 'read' ? [] : [join(root, 'before.png')];
  if (!result.requestDispatched && !chargeAuthorityAttempted) {
    const dispatchCallbacksDrained = pendingChargeAuthority === 0 &&
      (confirmAttempted ? result.dispatchCallbacksDrained === true : true);
    const neverDispatchedProof = result.requestDispatched === false && writerSessionClosed && dispatchCallbacksDrained &&
      !chargeDecisionRequested && !chargeDispatchAttempted && result.chargeApproved !== true && result.chargeDispatched !== true
      ? neverDispatchedCancelProof(input) : null;
    return { ...result, ...(result.outcome === 'fee_dialog_pending' ? { outcome: 'refused_penalty' } : {}), runDir: root,
      screenshots, writerSessionClosed, dispatchCallbacksDrained,
      ...(neverDispatchedProof ? { neverDispatchedProof } : {}) };
  }
  let nativeReadback = null;
  try {
    nativeReadback = await openSession(async (page) => {
      await installReadOnlyGuard(page.context());
      const proof = await freshRead(page, input, { shallow, read });
      if (proof) await writeFile(join(root, 'after.png'), await page.screenshot({ fullPage: true }), { mode: 0o600 });
      return proof;
    }, options);
  } catch { /* A possible effect remains UNKNOWN. */ }
  if (nativeReadback) screenshots.push(join(root, 'after.png'));
  const complete = nativeReadback && nativeReadback.confirmation === input.expected?.confirmation &&
    nativeReadback.nativeStayId === input.expected?.nativeStayId && nativeReadback.nativeGuestId === input.expected?.guestId &&
    /^cancel(?:l)?ed$/i.test(nativeReadback.status || '') && nativeReadback.reasonCode === input.reasonCode &&
    nativeReadback.cancellationNote === input.cancellationNote;
  const zeroNotice = result.outcome === 'zero_notice_awaiting_readback' && writerSessionClosed &&
    result.dispatchCallbacksDrained === true && !chargeAuthorityAttempted && !chargeDecisionRequested && !chargeDispatchAttempted &&
    result.requestDispatched === true && result.httpStatus === 200 && result.chargeApproved === false &&
    result.chargeDispatched === false && result.browserSendRequests === 0 && Array.isArray(result.blockedRequests) &&
    result.blockedRequests.length === 0 &&
    result.zeroPenaltyNotice === 'Cancellation Penalty of 0.00 may be added to account.';
  const outcome = chargeAuthorityAttempted || ['fee_dialog_pending', 'fee_accepted_unconfirmed'].includes(result.outcome) ||
    (result.outcome === 'zero_notice_awaiting_readback' && !(zeroNotice && complete))
    ? 'cancel_penalty_pending' : (result.outcome === 'awaiting_readback' || zeroNotice) && complete ? 'cancelled' : 'cancel_unconfirmed';
  return { ...result, outcome, nativeReadback, runDir: root, screenshots, writerSessionClosed,
    dispatchCallbacksDrained: pendingChargeAuthority === 0 && (confirmAttempted ? result.dispatchCallbacksDrained === true : true) };
}

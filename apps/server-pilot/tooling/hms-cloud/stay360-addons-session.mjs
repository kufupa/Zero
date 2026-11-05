#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { readRecordViewFromStay360 } from './stay360-record-view.mjs';
import { readStay360AddOns, listStay360AddOnItems, prepareStay360AddOns, saveStay360AddOns } from './stay360-addons.mjs';

const activeWrites = new Set();
const issue = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message || '') ? error.message : 'ADDONS_SESSION_FAILED';
const failure = error => ({ outcome: 'execution_failure', issue: issue(error) });

async function authorizeLabtest(prepared, withPage) {
  return withPage(async page => {
    await readConfirmationFromStay360(page, prepared.confirmation, { guestName: 'Proof Labtest', arrivalDate: prepared.target.arrival });
    const read = await readRecordViewFromStay360(page, prepared.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
    const identity = read.nativePreimage, cms = read.details.fields.filter(field => field.name === 'udfchkbox04');
    return Boolean(identity && identity.propertyCode === 'HRCEN' && identity.confirmation === prepared.confirmation &&
      identity.reservationStayId === prepared.native.stayId && identity.firstName === 'Proof' && identity.lastName === 'Labtest' &&
      identity.status === 'Reserved' && identity.arrival >= '2027-01-01' && identity.arrival === prepared.target.arrival &&
      identity.departure === prepared.target.departure && cms.length === 1 && cms[0].value === false);
  }, { headless: true, blockServiceWorkers: true });
}

/** Fresh session readback; a response acknowledgement is never a saved result. */
export async function reconcileStay360AddOns(save, { withPage = withCenturionStay360Page, target } = {}) {
  if (!save || !/^\d+-\d+$/.test(save.confirmation || '') || !Array.isArray(save.receipts)) {
    return { outcome: 'needs_input', issue: 'ADDONS_RECEIPTS_REQUIRED' };
  }
  try {
    const readback = await withPage(async page => {
      await readConfirmationFromStay360(page, save.confirmation, { guestName: target?.guestName, arrivalDate: target?.arrival });
      return readStay360AddOns(page, save.confirmation, { detailIds: save.receipts.map(receipt => receipt.nativeId).filter(Boolean) });
    }, { headless: true, blockServiceWorkers: true });
    if (readback.outcome !== 'ok') return { outcome: 'uncertain', issue: 'ADDONS_FRESH_READ_FAILED', readback };
    const verified = [], mismatches = [], receiptIds = save.receipts.map(receipt => receipt.nativeId);
    for (const receipt of save.receipts) {
      const details = (readback.details || []).filter(item => item.nativeId === receipt.nativeId);
      const current = details.length === 1 ? details[0].fields : null;
      const keys = ['code', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment', 'currency', 'totalCost'];
      const changed = !current || receiptIds.filter(id => id === receipt.nativeId).length !== 1 ? ['nativeId'] :
        keys.filter(key => current[key] !== receipt.item[key]);
      if (changed.length || current?.itemId !== receipt.itemId) mismatches.push({ index: receipt.index, fields: changed.length ? changed : ['itemId'] });
      else verified.push({ index: receipt.index, nativeId: receipt.nativeId, item: receipt.item });
    }
    const complete = save.requestedCount === save.receipts.length && save.receipts.length > 0 && mismatches.length === 0;
    return { outcome: complete ? 'verified' : 'uncertain', confirmation: save.confirmation, verified, mismatches, readback };
  } catch (error) { return { outcome: 'uncertain', issue: issue(error), confirmation: save.confirmation }; }
}

/** Trusted host callbacks own staff authorization, durable dispatch and cross-process locking. */
export async function withStay360AddOnSession(operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('ADDONS_SESSION_CALLBACK_REQUIRED');
  const withPage = options.withPage || withCenturionStay360Page;
  if (options.authorize && [options.beforeDispatch, options.afterDispatch, options.withWriteLock].some(value => typeof value !== 'function')) {
    throw new Error('ADDONS_TRUSTED_WRITE_CALLBACKS_REQUIRED');
  }
  return withPage(async page => {
    let confirmation = null, currentTarget = null, closed = false, lastSave = null;
    let tail = Promise.resolve();
    const execute = async request => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return { outcome: 'needs_input', issue: 'ADDONS_REQUEST_INVALID' };
      if (closed && request.tool !== 'reconcile') return { outcome: 'refused', issue: 'ADDONS_FRESH_SESSION_REQUIRED' };
      if (!['read', 'list', 'prepare', 'save', 'reconcile'].includes(request.tool)) return { outcome: 'needs_input', issue: 'ADDONS_TOOL_UNKNOWN' };
      const unsupported = Object.keys(request).filter(key => !['tool', 'confirmation', 'guestName', 'arrivalDate', 'items', 'preparedId'].includes(key));
      if (unsupported.length) return { outcome: 'unsupported', issue: 'ADDONS_REQUEST_FIELDS_UNSUPPORTED', fields: unsupported };
      if (!/^\d+-\d+$/.test(request.confirmation || '')) return { outcome: 'needs_input', issue: 'INVALID_CONFIRMATION' };
      if (confirmation && request.confirmation !== confirmation) return { outcome: 'refused', issue: 'ADDONS_SESSION_TARGET_CHANGED' };
      if (!confirmation) {
        await readConfirmationFromStay360(page, request.confirmation, { guestName: request.guestName, arrivalDate: request.arrivalDate });
        confirmation = request.confirmation;
        const read = await readStay360AddOns(page, confirmation);
        if (read.outcome !== 'ok') { closed = true; return read; }
        currentTarget = read.target;
        if (request.tool === 'read') return read;
      }
      if (request.tool === 'read') return readStay360AddOns(page, confirmation);
      if (request.tool === 'list') return listStay360AddOnItems(page, confirmation);
      if (request.tool === 'prepare') return prepareStay360AddOns(page, confirmation, request.items);
      if (request.tool === 'reconcile') {
        if (!lastSave) return { outcome: 'needs_input', issue: 'ADDONS_SAVE_RECEIPTS_REQUIRED' };
        return reconcileStay360AddOns(lastSave, { withPage, target: currentTarget });
      }
      if (activeWrites.has(confirmation)) return { outcome: 'refused', issue: 'ADDONS_WRITE_IN_PROGRESS' };
      activeWrites.add(confirmation);
      try {
        const save = async () => {
          lastSave = await saveStay360AddOns(page, confirmation, request.preparedId, {
            authorize: options.authorize || (prepared => authorizeLabtest(prepared, withPage)),
            beforeDispatch: options.beforeDispatch, afterDispatch: options.afterDispatch,
          });
          if (!['awaiting_readback', 'uncertain'].includes(lastSave.outcome) || !lastSave.receipts) return lastSave;
          closed = true;
          const reconciliation = await reconcileStay360AddOns(lastSave, { withPage, target: currentTarget });
          return { ...lastSave, outcome: reconciliation.outcome === 'verified' && lastSave.outcome === 'awaiting_readback' ? 'saved' : 'uncertain',
            reconciliation, next: reconciliation.outcome === 'verified' ? 'fresh_session' : 'reconcile_before_retry' };
        };
        return options.withWriteLock ? await options.withWriteLock(confirmation, save) : await save();
      } catch (error) {
        if (lastSave?.receipts && ['awaiting_readback', 'uncertain'].includes(lastSave.outcome)) {
          closed = true;
          return { ...lastSave, outcome: 'uncertain', issue: issue(error), next: 'reconcile_before_retry' };
        }
        throw error;
      } finally { activeWrites.delete(confirmation); }
    };
    const runTool = request => {
      try { request = structuredClone(request); }
      catch { return Promise.resolve({ outcome: 'needs_input', issue: 'ADDONS_REQUEST_INVALID' }); }
      const result = tail.then(() => execute(request)).catch(failure);
      tail = result.then(() => undefined);
      return result;
    };
    try { return await operation({ runTool }); }
    finally { await tail; }
  }, { headless: true, blockServiceWorkers: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node stay360-addons-session.mjs --jsonl\nTools: read, list, prepare, save, reconcile. Each request requires confirmation. CLI saves verified Labtest only.');
  } else if (!process.argv.includes('--jsonl')) {
    console.error('Use --jsonl or --help.'); process.exitCode = 1;
  } else {
    try {
      await withStay360AddOnSession(async ({ runTool }) => {
        for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
          if (!line.trim()) continue;
          let request;
          try { request = JSON.parse(line); } catch { console.log(JSON.stringify({ outcome: 'needs_input', issue: 'INVALID_JSON' })); continue; }
          console.log(JSON.stringify(await runTool(request)));
        }
      });
    } catch (error) { console.log(JSON.stringify(failure(error))); process.exitCode = 1; }
  }
}

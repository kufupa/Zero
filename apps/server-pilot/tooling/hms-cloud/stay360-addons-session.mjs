#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { centurionWriterIdentity, withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { readRecordViewFromStay360 } from './stay360-record-view.mjs';
import { readStay360AddOns, listStay360AddOnItems, listStay360AddOnCatalogue, prepareStay360AddOns, saveStay360AddOns, prepareStay360AddOnChanges, saveStay360AddOnChanges } from './stay360-addons.mjs';

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

const nativeIdOf = row => String(row.enhexpsequencekey ?? '').trim();
const canonicalDate = value => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value || '');
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
};
const canonicalNumber = value => {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
};
const sameNumber = (left, right) => canonicalNumber(left) !== null && canonicalNumber(left) === canonicalNumber(right);

const correctionKeys = ['code', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment', 'currency', 'totalCost', 'itemId', 'name', 'status'];

async function reconcileChanges(save, { withPage, target }) {
  try {
    const readback = await withPage(async page => {
      await readConfirmationFromStay360(page, save.confirmation, { guestName: target?.guestName, arrivalDate: target?.arrival });
      const listing = await readStay360AddOns(page, save.confirmation);
      if (listing.outcome !== 'ok') return listing;
      const present = new Set(listing.rows.map(nativeIdOf));
      const detailIds = save.changes.filter(change => present.has(change.nativeId)).map(change => change.nativeId);
      return detailIds.length ? readStay360AddOns(page, save.confirmation, { detailIds }) : listing;
    }, { headless: true, blockServiceWorkers: true });
    if (readback.outcome !== 'ok') return { outcome: 'uncertain', issue: 'ADDONS_FRESH_READ_FAILED', readback };
    const rows = new Set(readback.rows.map(nativeIdOf));
    const attempts = save.attempts || [], receipts = save.receipts || [];
    const results = [], mismatches = [];
    const removed = new Set(attempts.filter(attempt => attempt.operation === 'remove' && attempt.dispatched).map(attempt => attempt.nativeId));
    const baselineIds = new Set([...(save.baseline || []).map(nativeIdOf), ...attempts.flatMap(attempt => attempt.baselineIds || [])]);
    const missingUntargeted = [...baselineIds].filter(id => id && !removed.has(id) && !rows.has(id));
    for (const change of save.changes) {
      const attempt = attempts.find(item => item.index === change.index && item.nativeId === change.nativeId && item.operation === change.operation);
      const receipt = receipts.find(item => item.index === change.index && item.nativeId === change.nativeId && item.operation === change.operation);
      const current = readback.details?.find(detail => detail.nativeId === change.nativeId) || null;
      const result = { index: change.index, operation: change.operation, nativeId: change.nativeId,
        dispatched: attempt?.dispatched === true, attribution: receipt?.dispatched ? 'verified' : 'unknown',
        before: change.before, expectedAfter: change.after, observedAfter: current, status: 'not_attempted' };
      if (attempt?.dispatched || receipt?.status === 'unchanged') {
        const fields = change.operation === 'remove'
          ? (readback.coverage.complete === true && !rows.has(change.nativeId) ? [] : ['removal'])
          : (!current ? ['nativeId'] : correctionKeys.filter(key => current.fields[key] !== change.after.fields[key]));
        result.status = fields.length ? 'uncertain' : change.operation === 'remove' ? 'removed' : receipt?.status === 'unchanged' ? 'unchanged' : 'updated';
        if (fields.length) mismatches.push({ index: change.index, fields });
      } else mismatches.push({ index: change.index, fields: ['not_attempted'] });
      results.push(result);
    }
    if (missingUntargeted.length) mismatches.push({ fields: ['untargetedRows'], nativeIds: missingUntargeted });
    const complete = save.requestedCount === results.length && results.length > 0 && mismatches.length === 0 && !save.needsNativeReview &&
      results.every(result => result.status === 'unchanged' || result.attribution === 'verified');
    return { outcome: complete ? 'verified' : 'uncertain', confirmation: save.confirmation, results,
      verified: results.filter(result => ['updated', 'removed', 'unchanged'].includes(result.status) && (result.status === 'unchanged' || result.attribution === 'verified')),
      mismatches, readback };
  } catch (error) { return { outcome: 'uncertain', issue: issue(error), confirmation: save.confirmation }; }
}

/** Fresh session readback; recover possible dispatches even without a response ID. */
export async function reconcileStay360AddOns(save, { withPage = withCenturionStay360Page, target } = {}) {
  if (!save || !/^\d+-\d+$/.test(save.confirmation || '') || !Array.isArray(save.receipts) ||
      (save.attempts !== undefined && !Array.isArray(save.attempts))) {
    return { outcome: 'needs_input', issue: 'ADDONS_RECEIPTS_REQUIRED' };
  }
  if (save.kind === 'changes') {
    if (!Array.isArray(save.changes) || !save.changes.length) return { outcome: 'needs_input', issue: 'ADDONS_CHANGES_REQUIRED' };
    return reconcileChanges(save, { withPage, target: target || save.target });
  }
  try {
    const expected = structuredClone(save.attempts ?? save.receipts);
    const baselineIds = new Set((save.baseline || []).map(nativeIdOf).filter(Boolean));
    const readback = await withPage(async page => {
      await readConfirmationFromStay360(page, save.confirmation, { guestName: target?.guestName, arrivalDate: target?.arrival });
      const listing = await readStay360AddOns(page, save.confirmation);
      if (listing.outcome !== 'ok') return listing;
      const acknowledgedIds = new Set(expected.map(attempt => attempt.nativeId).filter(Boolean));
      for (const attempt of expected) {
        if (attempt.nativeId) continue;
        if (save.baselineCoverage?.complete !== true) continue;
        const item = attempt.item;
        const candidates = listing.rows.filter(row => nativeIdOf(row) && !baselineIds.has(nativeIdOf(row)) &&
          !acknowledgedIds.has(nativeIdOf(row)) && String(row.itemid) === attempt.itemId &&
          canonicalDate(row.startdate) === item.startDate && canonicalDate(row.enddate) === item.endDate &&
          sameNumber(row.quantity, item.quantity) && sameNumber(row.totalcost, item.totalCost) &&
          String(row.enxcurrency ?? '') === item.currency && String(row.comment ?? '') === item.comment);
        if (candidates.length === 1) attempt.nativeId = nativeIdOf(candidates[0]);
      }
      const ids = [...new Set(expected.map(attempt => attempt.nativeId).filter(Boolean))];
      return ids.length ? readStay360AddOns(page, save.confirmation, { detailIds: ids }) : listing;
    }, { headless: true, blockServiceWorkers: true });
    if (readback.outcome !== 'ok') return { outcome: 'uncertain', issue: 'ADDONS_FRESH_READ_FAILED', readback };
    const verified = [], mismatches = [], receiptIds = expected.map(receipt => receipt.nativeId);
    for (const receipt of expected) {
      const details = (readback.details || []).filter(item => item.nativeId === receipt.nativeId);
      const current = details.length === 1 ? details[0].fields : null;
      const keys = ['code', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment', 'currency', 'totalCost'];
      const changed = !current || baselineIds.has(receipt.nativeId) || receiptIds.filter(id => id === receipt.nativeId).length !== 1 ? ['nativeId'] :
        keys.filter(key => current[key] !== receipt.item[key]);
      if (changed.length || current?.itemId !== receipt.itemId) mismatches.push({ index: receipt.index, fields: changed.length ? changed : ['itemId'] });
      else verified.push({ index: receipt.index, nativeId: receipt.nativeId, item: receipt.item });
    }
    const complete = save.requestedCount === expected.length && expected.length > 0 && mismatches.length === 0;
    return { outcome: complete ? 'verified' : 'uncertain', confirmation: save.confirmation, verified, mismatches, readback };
  } catch (error) { return { outcome: 'uncertain', issue: issue(error), confirmation: save.confirmation }; }
}

/** Owns one serialized page; trusted host callbacks supply staff authorization. */
export async function withStay360AddOnSession(operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('ADDONS_SESSION_CALLBACK_REQUIRED');
  const withPage = options.withPage || withCenturionStay360Page;
  for (const key of ['authorizeChanges', 'beforeChangeDispatch', 'afterChangeDispatch']) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new Error('ADDONS_CHANGE_CALLBACK_INVALID');
  }
  if (options.authorize && [options.beforeDispatch, options.afterDispatch, options.withWriteLock].some(value => typeof value !== 'function')) {
    throw new Error('ADDONS_TRUSTED_WRITE_CALLBACKS_REQUIRED');
  }
  return withPage(async page => {
    let confirmation = null, currentTarget = null, closed = false, lastSave = null;
    let tail = Promise.resolve();
    const execute = async request => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return { outcome: 'needs_input', issue: 'ADDONS_REQUEST_INVALID' };
      if (closed && request.tool !== 'reconcile') return { outcome: 'refused', issue: 'ADDONS_FRESH_SESSION_REQUIRED' };
      if (!['read', 'list', 'prepare', 'save', 'prepareChanges', 'saveChanges', 'reconcile'].includes(request.tool)) return { outcome: 'needs_input', issue: 'ADDONS_TOOL_UNKNOWN' };
      const unsupported = Object.keys(request).filter(key => !['tool', 'confirmation', 'guestName', 'arrivalDate', 'items', 'preparedId', 'detailIds', 'changes', 'itemType'].includes(key) ||
        (key === 'changes' && request.tool !== 'prepareChanges') || (key === 'detailIds' && request.tool !== 'read') ||
        (key === 'itemType' && request.tool !== 'list'));
      if (unsupported.length) return { outcome: 'unsupported', issue: 'ADDONS_REQUEST_FIELDS_UNSUPPORTED', fields: unsupported };
      if (['prepareChanges', 'saveChanges'].includes(request.tool)) {
        const fields = Object.keys(request).filter(key => !['tool', 'confirmation', 'guestName', 'arrivalDate',
          request.tool === 'prepareChanges' ? 'changes' : 'preparedId'].includes(key));
        if (fields.length) return { outcome: 'unsupported', issue: 'ADDONS_REQUEST_FIELDS_UNSUPPORTED', fields };
      }
      if (!/^\d+-\d+$/.test(request.confirmation || '')) return { outcome: 'needs_input', issue: 'INVALID_CONFIRMATION' };
      if (confirmation && request.confirmation !== confirmation) return { outcome: 'refused', issue: 'ADDONS_SESSION_TARGET_CHANGED' };
      if (!confirmation || !currentTarget) {
        if (!confirmation) await readConfirmationFromStay360(page, request.confirmation, { guestName: request.guestName, arrivalDate: request.arrivalDate });
        confirmation = request.confirmation;
        const read = await readStay360AddOns(page, confirmation, request.tool === 'read' ? { detailIds: request.detailIds } : {});
        if (read.outcome !== 'ok') {
          closed = !['ADDONS_DETAIL_IDS_INVALID', 'ADDONS_DETAIL_NOT_LOADED'].includes(read.issue);
          return read;
        }
        currentTarget = read.target;
        if (request.tool === 'read') return read;
      }
      if (request.tool === 'read') return readStay360AddOns(page, confirmation, { detailIds: request.detailIds });
      if (request.tool === 'list') return request.itemType === undefined ? listStay360AddOnItems(page, confirmation) :
        listStay360AddOnCatalogue(page, confirmation, { itemType: request.itemType });
      if (request.tool === 'prepare') return prepareStay360AddOns(page, confirmation, request.items);
      if (request.tool === 'prepareChanges') return prepareStay360AddOnChanges(page, confirmation, request.changes);
      if (request.tool === 'reconcile') {
        if (!lastSave) return { outcome: 'needs_input', issue: 'ADDONS_SAVE_RECEIPTS_REQUIRED' };
        return reconcileStay360AddOns(lastSave, { withPage, target: currentTarget });
      }
      if (activeWrites.has(confirmation)) return { outcome: 'refused', issue: 'ADDONS_WRITE_IN_PROGRESS' };
      activeWrites.add(confirmation);
      try {
        const save = async () => {
          const correction = request.tool === 'saveChanges';
          if (correction) {
            lastSave = await saveStay360AddOnChanges(page, confirmation, request.preparedId, {
              authorize: options.authorizeChanges || (prepared => authorizeLabtest(prepared, withPage)),
              beforeDispatch: options.beforeChangeDispatch, afterDispatch: options.afterChangeDispatch,
              readBaseline: prepared => withPage(async freshPage => {
                await readConfirmationFromStay360(freshPage, prepared.confirmation, { guestName: prepared.target.guestName, arrivalDate: prepared.target.arrival });
                const listing = await readStay360AddOns(freshPage, prepared.confirmation);
                if (listing.outcome !== 'ok') return listing;
                const present = new Set(listing.rows.map(nativeIdOf));
                const detailIds = prepared.changes.map(change => change.nativeId).filter(id => present.has(id));
                return detailIds.length ? readStay360AddOns(freshPage, prepared.confirmation, { detailIds }) : listing;
              }, { headless: true, blockServiceWorkers: true }),
            });
            if (lastSave.kind === 'changes') closed = true;
          } else lastSave = await saveStay360AddOns(page, confirmation, request.preparedId, {
            authorize: options.authorize || (prepared => authorizeLabtest(prepared, withPage)),
            beforeDispatch: options.captureWriterIdentity && options.beforeDispatch
              ? dispatch => {
                  const writer = centurionWriterIdentity(page);
                  if (!writer) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
                  return options.beforeDispatch(dispatch, writer);
                } : options.beforeDispatch,
            afterDispatch: options.afterDispatch,
            readBaseline: prepared => withPage(async freshPage => {
              await readConfirmationFromStay360(freshPage, prepared.confirmation, {
                guestName: prepared.target.guestName, arrivalDate: prepared.target.arrival,
              });
              return readStay360AddOns(freshPage, prepared.confirmation);
            }, { headless: true, blockServiceWorkers: true }),
          });
          if (!['awaiting_readback', 'uncertain', 'unchanged'].includes(lastSave.outcome) || !lastSave.receipts) return lastSave;
          closed = true;
          const reconciliation = await reconcileStay360AddOns(lastSave, { withPage, target: currentTarget });
          return { ...lastSave, outcome: reconciliation.outcome === 'verified' ? (lastSave.outcome === 'unchanged' ? 'unchanged' : 'saved') : 'uncertain',
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
    console.log('Usage: node stay360-addons-session.mjs --jsonl\nTools: read, list, prepare, save, prepareChanges, saveChanges, reconcile. Each request requires confirmation. CLI saves verified Labtest only.');
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

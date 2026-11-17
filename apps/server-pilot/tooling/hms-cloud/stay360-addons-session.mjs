#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { cloudWriterIdentity, withCloudCredentialLease, withCloudWriterSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { readConfirmationFromStay360 } from './stay360-confirmation.mjs';
import { bindStay360AddOnProperty, readStay360AddOns, listStay360AddOnItems, listStay360AddOnCatalogue, prepareStay360AddOns, saveStay360AddOns, prepareStay360AddOnChanges, saveStay360AddOnChanges } from './stay360-addons.mjs';

const activeWrites = new Set();
const issue = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message || '') ? error.message : 'ADDONS_SESSION_FAILED';
const failure = error => ({ outcome: 'execution_failure', issue: issue(error) });

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
      const expectedId = save.nativeStayId ?? target?.nativeStayId;
      if (!expectedId || listing.nativeStayId !== expectedId) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
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
async function reconcileWithPage(save, { withPage, target } = {}) {
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
      const expectedId = save.nativeStayId ?? target?.nativeStayId;
      if (!expectedId || listing.nativeStayId !== expectedId) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
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

function sessionScope(options) {
  const property = getPropertyRegistration(options.propertyCode);
  if (!property?.active || typeof options.transportId !== 'string' || !property.transportIds.includes(options.transportId)) {
    throw new Error('ADDONS_PROPERTY_SCOPE_REQUIRED');
  }
  return { propertyCode: property.propertyCode, transportId: options.transportId, signal: options.signal };
}

function targetKeys(scope, confirmation, nativeStayId) {
  if (!/^\d+-\d+$/.test(confirmation || '')) return [];
  const property = getPropertyRegistration(scope.propertyCode);
  const partition = scope.propertyCode === 'HRCEN' ? [] : [property.expectedTenant];
  const decimal = value => value.replace(/^0+(?=\d)/, '');
  const [base, suffix] = confirmation.split('-');
  const result = [JSON.stringify([scope.propertyCode, 'saved', `${decimal(base)}-${decimal(suffix)}`, ...partition])];
  if (/^\d+$/.test(nativeStayId || '')) result.push(JSON.stringify([scope.propertyCode, 'saved_native', decimal(nativeStayId), ...partition]));
  return result;
}

function scopedPage(scope, credentialLease, aliases = () => [], staging = false) {
  return async operation => withCloudWriterSession(async page => {
    bindStay360AddOnProperty(page, scope.propertyCode);
    return operation(page);
  }, { ...scope, credentialLease, staging, ...(aliases().length ? { cloudTargetKeys: aliases() } : {}), startScreen: 'OSRESS' });
}

/** A separate authenticated session reconciles possible dispatches after the writer has closed. */
export async function reconcileStay360AddOns(save, options = {}) {
  const scope = sessionScope(options);
  const run = lease => reconcileWithPage(save, { withPage: scopedPage(scope, lease,
    () => targetKeys(scope, save?.confirmation, save?.nativeStayId ?? options.target?.nativeStayId), true), target: options.target });
  return options.credentialLease ? run(options.credentialLease) : withCloudCredentialLease(scope.propertyCode, run, { signal: scope.signal, readOnly: true });
}

/** Prepare and save in sequential sessions, held under the same credential lease. */
export async function withStay360AddOnSession(operation, options = {}) {
  if (typeof operation !== 'function') throw new Error('ADDONS_SESSION_CALLBACK_REQUIRED');
  const baseScope = sessionScope(options);
  for (const key of ['authorize', 'authorizeChanges', 'beforeDispatch', 'afterDispatch', 'beforeChangeDispatch', 'afterChangeDispatch', 'withWriteLock']) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new Error('ADDONS_CALLBACK_INVALID');
  }
  if ((options.authorize || options.authorizeChanges) &&
      [options.withWriteLock, ...(options.authorize ? [options.beforeDispatch, options.afterDispatch] : []),
        ...(options.authorizeChanges ? [options.beforeChangeDispatch, options.afterChangeDispatch] : [])]
        .some(value => typeof value !== 'function')) throw new Error('ADDONS_TRUSTED_WRITE_CALLBACKS_REQUIRED');
  const staging = !options.authorize && !options.authorizeChanges;
  const work = async credentialLease => {
    const signals = [baseScope.signal, credentialLease?.signal].filter(Boolean);
    const scope = { ...baseScope, signal: signals.length ? AbortSignal.any(signals) : undefined };
    let confirmation = null, currentTarget = null, nativeStayId = null, closed = false, lastSave = null, prepared = null;
    const withPage = scopedPage(scope, credentialLease, () => targetKeys(scope, confirmation, nativeStayId), staging);
    let tail = Promise.resolve();
    const open = async (request, action) => withPage(async page => {
      scope.signal?.throwIfAborted();
      await readConfirmationFromStay360(page, request.confirmation, { guestName: request.guestName, arrivalDate: request.arrivalDate });
      return action(page);
    });
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
      confirmation = request.confirmation;
      if (request.tool === 'reconcile') {
        if (!lastSave) return { outcome: 'needs_input', issue: 'ADDONS_SAVE_RECEIPTS_REQUIRED' };
        return reconcileWithPage(lastSave, { withPage, target: currentTarget });
      }
      if (['read', 'list', 'prepare', 'prepareChanges'].includes(request.tool)) {
        const result = await open(request, async page => {
          if (request.tool === 'read') return readStay360AddOns(page, confirmation, { detailIds: request.detailIds });
          const read = await readStay360AddOns(page, confirmation);
          if (read.outcome !== 'ok') return read;
          if (currentTarget && JSON.stringify(currentTarget) !== JSON.stringify(read.target)) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
          if (!/^\d+$/.test(read.nativeStayId || '') || (nativeStayId && nativeStayId !== read.nativeStayId)) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
          nativeStayId = read.nativeStayId;
          currentTarget = read.target;
          if (request.tool === 'list') return request.itemType === undefined ? listStay360AddOnItems(page, confirmation) :
            listStay360AddOnCatalogue(page, confirmation, { itemType: request.itemType });
          return request.tool === 'prepare' ? prepareStay360AddOns(page, confirmation, request.items) :
            prepareStay360AddOnChanges(page, confirmation, request.changes);
        });
        if (request.tool === 'read' && result.outcome === 'ok') {
          if (currentTarget && JSON.stringify(currentTarget) !== JSON.stringify(result.target)) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
          if (!/^\d+$/.test(result.nativeStayId || '') || (nativeStayId && nativeStayId !== result.nativeStayId)) return { outcome: 'refused', issue: 'ADDONS_TARGET_CHANGED' };
          nativeStayId = result.nativeStayId;
          currentTarget = result.target;
        }
        if (['prepare', 'prepareChanges'].includes(request.tool)) {
          prepared = result.outcome === 'prepared' ? { request, result: structuredClone(result), target: structuredClone(currentTarget) } : null;
        }
        return result;
      }
      const correction = request.tool === 'saveChanges';
      if (!prepared || request.preparedId !== prepared.result.preparedId ||
          (correction ? prepared.request.tool !== 'prepareChanges' : prepared.request.tool !== 'prepare')) {
        return { outcome: 'refused', issue: 'ADDONS_PREPARED_ID_REQUIRED' };
      }
      if (typeof (correction ? options.authorizeChanges : options.authorize) !== 'function' || typeof options.withWriteLock !== 'function') {
        return { outcome: 'refused', issue: 'ADDONS_SAVE_AUTHORIZATION_REQUIRED' };
      }
      const writeKey = `${scope.propertyCode}\0${confirmation}`;
      if (activeWrites.has(writeKey)) return { outcome: 'refused', issue: 'ADDONS_WRITE_IN_PROGRESS' };
      activeWrites.add(writeKey);
      let dispatchAttempted = false;
      try {
        return await options.withWriteLock(confirmation, async () => {
          scope.signal?.throwIfAborted();
          const hints = { confirmation, guestName: prepared.target?.guestName, arrivalDate: prepared.target?.arrival };
          const baseline = await open(hints, async page => {
            const listing = await readStay360AddOns(page, confirmation);
            if (!correction || listing.outcome !== 'ok') return listing;
            const present = new Set(listing.rows.map(nativeIdOf));
            const detailIds = prepared.result.changes.map(change => change.nativeId).filter(id => present.has(id));
            return detailIds.length ? readStay360AddOns(page, confirmation, { detailIds }) : listing;
          });
          if (baseline.outcome !== 'ok' || baseline.coverage?.complete !== true ||
              baseline.nativeStayId !== nativeStayId ||
              JSON.stringify(baseline.target) !== JSON.stringify(prepared.target)) {
            return { outcome: 'needs_input', issue: 'ADDONS_BASELINE_INCOMPLETE' };
          }
          scope.signal?.throwIfAborted();
          lastSave = await open(hints, async page => {
            const staged = correction ? await prepareStay360AddOnChanges(page, confirmation, prepared.request.changes) :
              await prepareStay360AddOns(page, confirmation, prepared.request.items);
            const key = correction ? 'changes' : 'items';
            if (staged.outcome !== 'prepared' || staged.propertyCode !== scope.propertyCode ||
                JSON.stringify(staged[key]) !== JSON.stringify(prepared.result[key])) {
              return { outcome: 'needs_input', issue: 'ADDONS_PRICE_OR_FIELDS_CHANGED', preview: staged };
            }
            const before = correction ? options.beforeChangeDispatch : options.beforeDispatch;
            const config = {
              authorize: correction ? options.authorizeChanges : options.authorize,
              signal: scope.signal,
              beforeDispatch: dispatch => {
                dispatchAttempted = true;
                const writer = cloudWriterIdentity(page);
                if (!writer) throw new Error('HMS_WRITER_IDENTITY_UNAVAILABLE');
                return before(dispatch, writer);
              },
              afterDispatch: correction ? options.afterChangeDispatch : options.afterDispatch,
              readBaseline: async () => structuredClone(baseline),
            };
            return correction ? saveStay360AddOnChanges(page, confirmation, staged.preparedId, config) :
              saveStay360AddOns(page, confirmation, staged.preparedId, config);
          });
          prepared = null;
          if (!['awaiting_readback', 'uncertain', 'unchanged'].includes(lastSave.outcome) || !lastSave.receipts) return lastSave;
          closed = true;
          const reconciliation = await reconcileWithPage(lastSave, { withPage, target: currentTarget });
          return { ...lastSave, outcome: reconciliation.outcome === 'verified' ? (lastSave.outcome === 'unchanged' ? 'unchanged' : 'saved') : 'uncertain',
            reconciliation, next: reconciliation.outcome === 'verified' ? 'fresh_session' : 'reconcile_before_retry' };
        });
      } catch (error) {
        if (lastSave?.receipts && ['awaiting_readback', 'uncertain'].includes(lastSave.outcome)) {
          closed = true;
          return { ...lastSave, outcome: 'uncertain', issue: issue(error), next: 'reconcile_before_retry' };
        }
        if (dispatchAttempted) {
          closed = true;
          return { outcome: 'uncertain', issue: issue(error), confirmation, next: 'reconcile_before_retry' };
        }
        throw error;
      } finally { activeWrites.delete(writeKey); }
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
  };
  return options.credentialLease ? work(options.credentialLease) : withCloudCredentialLease(baseScope.propertyCode, work, { signal: baseScope.signal, readOnly: staging });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node stay360-addons-session.mjs --jsonl --property PROPERTY --transport TRANSPORT\nTools: read, list, prepare, prepareChanges, reconcile. Each request requires confirmation.');
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
      }, { propertyCode: process.argv[process.argv.indexOf('--property') + 1],
        transportId: process.argv[process.argv.indexOf('--transport') + 1] });
    } catch (error) { console.log(JSON.stringify(failure(error))); process.exitCode = 1; }
  }
}

// A fresh, confirmation-scoped Cloud reader for one saved stay.
import { withCloudReadSession } from './cloud-session.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { lookupFailure } from './stay360-lookup-cli.mjs';
import { projectCancellationPreflight } from './guest-stay-cancel-preflight.mjs';

const RETRYABLE_LOOKUPS = new Set([
  'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_NOT_FOUND', 'CONFIRMATION_HINT_MISMATCH',
  'CONFIRMATION_HINT_UNVERIFIED', 'SEARCH_RESULTS_CHANGED',
  'INVALID_CONFIRMATION', 'INVALID_GUEST_NAME', 'INVALID_ARRIVAL_DATE', 'INVALID_LOOKUP_OPTIONS',
]);

function readFailure(error, stage, shallow) {
  const failure = lookupFailure(error, Date.now());
  const result = { outcome: failure.error.startsWith('INVALID_') ? 'input_gap' : 'read_failed',
    stage, issue: failure.error };
  for (const name of ['candidates', 'searchedDateRange', 'searchResults']) {
    if (Object.hasOwn(failure, name)) result[name] = failure[name];
  }
  if (shallow) {
    result.shallow = shallow;
    result.searchedDateRange = shallow.searchedDateRange;
    result.searchResults = shallow.searchResults;
  }
  return result;
}

/** Own a scoped read-only page; calls submitted through runTool execute in order. */
export async function withSavedStayAgentSession(operation, { signal, readOnly = false, readOnlyConfirmation,
  cloudTargetKey, credentialLease, propertyCode, transportId } = {}) {
  if (typeof operation !== 'function') throw new Error('SESSION_CALLBACK_REQUIRED');
  if (readOnly !== true) throw new Error('READ_ONLY_SESSION_REQUIRED');
  if (!/^(?:\d+-\d+|\d{6,10})$/.test(readOnlyConfirmation || '')) throw new Error('READ_CONFIRMATION_REQUIRED');
  const property = getPropertyRegistration(propertyCode);
  if (!property?.active) throw new Error('READ_PROPERTY_UNSUPPORTED');
  signal?.throwIfAborted();
  return withCloudReadSession(async (page, identity) => {
    if (!identity || identity.propertyCode !== propertyCode || identity.tenantId !== property.expectedTenant ||
        identity.landingPropertyCode !== property.landingPropertyCode || identity.origin !== property.origin) {
      throw new Error('READ_SESSION_PROPERTY_MISMATCH');
    }
    let current = null, recordOpen = false, sealed = false, nativeDialog = null, accepting = true;
    let tail = Promise.resolve();
    let interruptRead;
    const readInterrupted = new Promise(resolve => { interruptRead = resolve; });
    const onNativeDialog = dialog => {
      nativeDialog = { type: dialog.type(), message: dialog.message() };
      sealed = true;
      interruptRead({ outcome: /penalt|fee|charge|deposit/i.test(nativeDialog.message)
        ? 'fee_dialog_pending' : 'unexpected_dialog', issue: 'NATIVE_DIALOG', nativeDialog, next: 'fresh_session' });
      void dialog.dismiss().catch(() => {});
    };
    page.on('dialog', onNativeDialog);
    const execute = async request => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
      }
      const { tool } = request;
      if (!['read', 'prepareCancellation'].includes(tool)) return { outcome: 'refused', issue: 'READ_ONLY_SESSION' };
      if (tool === 'read' && request.confirmation !== readOnlyConfirmation) {
        return { outcome: 'refused', issue: 'READ_ONLY_CONFIRMATION_MISMATCH' };
      }
      if (nativeDialog) return { outcome: /penalt|fee|charge|deposit/i.test(nativeDialog.message)
        ? 'fee_dialog_pending' : 'unexpected_dialog', issue: 'NATIVE_DIALOG', nativeDialog };
      if (sealed) return { outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' };
      if (tool === 'prepareCancellation') {
        if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
        const result = projectCancellationPreflight({ confirmation: current.confirmation,
          requestedScope: request.requestedScope, shallow: current.shallow, record: current.record });
        return result.outcome === 'prepared_for_human_review' ? { ...result, observedAt: current.observedAt } : result;
      }
      if (request.view !== undefined && !['shallow', 'record'].includes(request.view)) {
        return { outcome: 'input_gap', issue: 'INVALID_READ_VIEW' };
      }
      if (recordOpen) return { outcome: 'refused', issue: 'RECORD_VIEW_ALREADY_OPEN' };
      current = null;
      let shallow;
      try {
        shallow = await readShallow(page, request.confirmation,
          { guestName: request.guestName, arrivalDate: request.arrivalDate });
      } catch (error) {
        const result = readFailure(error, 'shallow');
        if (!RETRYABLE_LOOKUPS.has(result.issue)) { sealed = true; result.next = 'fresh_session'; }
        return result;
      }
      if (request.view === 'shallow') return { outcome: 'ok', shallow };
      try {
        const record = await readRecord(page, shallow.confirmation, { nativePropertyCode: propertyCode,
          nativeIdentityOnly: request.includeNativeIdentityOnly === true });
        recordOpen = true;
        const statuses = record.details.fields.filter(field => field.name === 'status');
        current = { confirmation: shallow.confirmation, status: statuses.length === 1 ? statuses[0].value : null,
          shallow: structuredClone(shallow), record: structuredClone(record), observedAt: new Date().toISOString() };
        const publicRecord = request.includeNativePreimage === true ? record :
          Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'nativePreimage'));
        return { outcome: 'ok', shallow, record: publicRecord };
      } catch (error) {
        sealed = true;
        return { ...readFailure(error, 'record', shallow), next: 'fresh_session' };
      }
    };
    const runTool = request => {
      let input, invalid = false;
      try { input = structuredClone(request); } catch { invalid = true; }
      const id = input?.id ?? null, tool = input?.tool ?? null;
      if (!accepting) return Promise.resolve({ id, tool, outcome: 'refused', issue: 'SESSION_CLOSED' });
      const result = tail.then(() => {
        if (invalid) return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
        const work = execute(input);
        return input?.tool === 'read' ? Promise.race([work, readInterrupted]) : work;
      }).then(value => ({ ...value, id, tool }));
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    const screenshotRecord = async () => {
      await tail;
      if (!recordOpen || sealed || nativeDialog || !accepting) throw new Error('RECORD_SCREENSHOT_UNAVAILABLE');
      return page.screenshot({ fullPage: true });
    };
    try { return await operation({ runTool, screenshotRecord }); }
    finally {
      accepting = false;
      await tail;
      page.off('dialog', onNativeDialog);
    }
  }, { propertyCode, transportId, signal, credentialLease, startScreen: 'OSRESS',
    ...(cloudTargetKey !== undefined && { cloudTargetKey }),
    prepareContext: context => installSavedStayReadGuard(context, { confirmation: readOnlyConfirmation, propertyCode, allowBaseConfirmation: !readOnlyConfirmation.includes('-') }) });
}

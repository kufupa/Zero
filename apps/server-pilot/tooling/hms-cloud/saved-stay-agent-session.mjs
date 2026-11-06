#!/usr/bin/env node
// A guarded saved-stay page and an optional separate Hotel Availability page.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { lookupFailure } from './stay360-lookup-cli.mjs';
import { amendLabtestNote } from './guest-stay-amend.mjs';
import { amendLabtestBookerContact, amendLabtestContact } from './guest-stay-amend-contact.mjs';
import { openLabtestCancellation, confirmLabtestCancellation } from './guest-stay-cancel.mjs';
import { projectCancellationPreflight } from './guest-stay-cancel-preflight.mjs';
import { projectFinanceDisplayPreflight } from './guest-stay-finance-preflight.mjs';
import { readStayAmendmentAvailability } from './guest-stay-amend-availability.mjs';
import { readLabtestStayAmendmentAvailability } from './guest-stay-amend-date-room-rate.mjs';
import { nativePriceDigest, readSavedStayNightlyRates } from './saved-stay-nightly-rates.mjs';
import { listSavedStayRateOverrideReasons, prepareSavedStayRateOverride, readSavedStayRateReasons,
  restageSavedStayRateOverride } from './saved-stay-rate-override.mjs';
import { withRateOverrideSavedStay, submitRateOverrideOnce,
  readBackSavedStayRateOverride } from './pane-rate-override-session.mjs';
import {
  searchHotelAvailabilityParty, selectHotelAvailabilityParty, cancelHotelAvailabilityParty,
} from './hotel-availability.mjs';

const RETRYABLE_LOOKUPS = new Set([
  'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_NOT_FOUND', 'CONFIRMATION_HINT_MISMATCH',
  'CONFIRMATION_HINT_UNVERIFIED', 'SEARCH_RESULTS_CHANGED',
  'INVALID_CONFIRMATION', 'INVALID_GUEST_NAME', 'INVALID_ARRIVAL_DATE', 'INVALID_LOOKUP_OPTIONS',
]);
const RATE_TOOLS = ['readSavedStayRates', 'listRateOverrideReasons', 'prepareRateOverride', 'commitRateOverride'];
const RATE_TARGET = Object.freeze({ propertyCode: 'HRCEN', browserSlot: 'centurion',
  origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' });
const rateTarget = selected => ({ propertyCode: selected.propertyCode, confirmation: selected.confirmation,
  guestId: selected.guestId, nativeStayId: selected.reservationStayId, firstName: selected.firstName,
  lastName: selected.lastName, arrival: selected.arrival, departure: selected.departure });
const publicRates = rates => ({ currency: rates.currency, nightly: rates.nightly,
  totals: rates.totals, digest: rates.digest });
const validNight = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const labtest = selected => selected?.firstName === 'Proof' && selected?.lastName === 'Labtest' &&
  selected.arrival >= '2027-01-01';
const safeIssue = (error, fallback) => {
  const message = String(error?.message || '').split('\n')[0];
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : fallback;
};

function readFailure(error, stage, shallow) {
  const failure = lookupFailure(error, Date.now());
  const result = { outcome: failure.error.startsWith('INVALID_') ? 'input_gap' : 'read_failed',
    stage, issue: failure.error };
  if (Object.hasOwn(failure, 'candidates')) result.candidates = failure.candidates;
  if (Object.hasOwn(failure, 'searchedDateRange')) result.searchedDateRange = failure.searchedDateRange;
  if (Object.hasOwn(failure, 'searchResults')) result.searchResults = failure.searchResults;
  if (shallow) {
    result.shallow = shallow;
    result.searchedDateRange = shallow.searchedDateRange;
    result.searchResults = shallow.searchResults;
  }
  return result;
}

/** Own guarded pages; calls submitted through runTool execute in order. */
export async function withSavedStayAgentSession(operation, { signal, readOnly = false, readOnlyConfirmation,
  cloudTargetKey, dispatchRateOverride } = {}) {
  if (typeof operation !== 'function') throw new Error('SESSION_CALLBACK_REQUIRED');
  if (typeof readOnly !== 'boolean') throw new Error('READ_ONLY_OPTION_INVALID');
  if (dispatchRateOverride !== undefined && typeof dispatchRateOverride !== 'function') throw new Error('RATE_DISPATCH_INVALID');
  if (readOnly && !/^\d+-\d+$/.test(readOnlyConfirmation || '')) throw new Error('READ_CONFIRMATION_REQUIRED');
  signal?.throwIfAborted();
  const installStrictGuard = readOnly ? (await import('./saved-stay-read-guard.mjs')).installSavedStayReadGuard : undefined;
  const prepareContext = installStrictGuard && ((context) => installStrictGuard(context, { confirmation: readOnlyConfirmation }));
  return withCenturionStay360Page(async (page) => {
    if (!readOnly) await installReadOnlyGuard(page.context());
    let current = null, recordOpen = false, pendingCancel = null, pendingRate = null, sealed = false, nativeDialog = null;
    let accepting = true, tail = Promise.resolve();
    let interruptRead;
    const readInterrupted = new Promise((resolve) => { interruptRead = resolve; });
    const onNativeDialog = (dialog) => {
      nativeDialog = { type: dialog.type(), message: dialog.message() };
      sealed = true;
      interruptRead({ outcome: /penalt|fee|charge|deposit/i.test(nativeDialog.message)
        ? 'fee_dialog_pending' : 'unexpected_dialog', issue: 'NATIVE_DIALOG', nativeDialog, next: 'fresh_session' });
    };
    page.on('dialog', onNativeDialog);

    // Keep native party search tokens on one separate page until this session ends.
    let availabilityReady, availabilityTask, releaseAvailability;
    const getAvailabilityPage = () => {
      if (!availabilityReady) {
        let resolveReady, rejectReady;
        availabilityReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const released = new Promise((resolve) => { releaseAvailability = resolve; });
        availabilityTask = withCenturionStay360Page(async (availabilityPage) => {
          await installReadOnlyGuard(availabilityPage.context());
          availabilityPage.on('dialog', onNativeDialog);
          resolveReady(availabilityPage);
          await released;
        }, { headless: true, signal, blockServiceWorkers: true }).catch(rejectReady);
      }
      return availabilityReady;
    };

    const execute = async (request) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
      }
      const { tool } = request;
      if (!['read', 'prepareCancellation', 'prepareFinance', 'amendNote', 'amendContact', 'openCancel', 'confirmCancel',
        'readAmendmentAvailability', 'searchHotelAvailabilityParty', 'selectHotelAvailabilityParty',
        'cancelHotelAvailabilityParty', ...RATE_TOOLS].includes(tool)) {
        return { outcome: 'input_gap', issue: 'UNKNOWN_TOOL' };
      }
      if (readOnly && tool !== 'read') return { outcome: 'refused', issue: 'READ_ONLY_SESSION' };
      if (readOnly && request.confirmation !== readOnlyConfirmation) {
        return { outcome: 'refused', issue: 'READ_ONLY_CONFIRMATION_MISMATCH' };
      }
      if (nativeDialog) return { outcome: /penalt|fee|charge|deposit/i.test(nativeDialog.message)
        ? 'fee_dialog_pending' : 'unexpected_dialog', issue: 'NATIVE_DIALOG', nativeDialog };
      if (sealed) return { outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' };
      if (pendingCancel && tool !== 'confirmCancel') return { outcome: 'refused', issue: 'CANCEL_REASON_OPEN' };

      if (tool === 'read') {
        if (request.view !== undefined && !['shallow', 'record'].includes(request.view)) {
          return { outcome: 'input_gap', issue: 'INVALID_READ_VIEW' };
        }
        if (recordOpen) return { outcome: 'refused', issue: 'RECORD_VIEW_ALREADY_OPEN' };
        current = null;
        let shallow;
        try {
          // Explicit options avoid inheriting process-wide legacy lookup hints.
          shallow = await readShallow(page, request.confirmation,
            { guestName: request.guestName, arrivalDate: request.arrivalDate });
        } catch (error) {
          const result = readFailure(error, 'shallow');
          if (!RETRYABLE_LOOKUPS.has(result.issue)) { sealed = true; result.next = 'fresh_session'; }
          return result;
        }
        if (request.view === 'shallow') return { outcome: 'ok', shallow };
        try {
          const record = await readRecord(page, shallow.confirmation, { nativePropertyCode: 'HRCEN',
            nativeIdentityOnly: readOnly && request.includeNativeIdentityOnly === true });
          recordOpen = true;
          const statuses = record.details.fields.filter((field) => field.name === 'status');
          current = { confirmation: shallow.confirmation, status: statuses.length === 1 ? statuses[0].value : null,
            shallow: structuredClone(shallow), record: structuredClone(record), observedAt: new Date().toISOString() };
          const publicRecord = request.includeNativePreimage === true ? record :
            Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'nativePreimage'));
          return { outcome: 'ok', shallow, record: publicRecord };
        } catch (error) {
          sealed = true;
          return { ...readFailure(error, 'record', shallow), next: 'fresh_session' };
        }
      }

      if (RATE_TOOLS.includes(tool)) {
        if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
        if (current.status !== 'Reserved') return { outcome: 'refused', issue: 'RECORD_NOT_RESERVED' };
        const selected = current.record?.nativePreimage;
        if (!selected) return { outcome: 'refused', issue: 'NATIVE_STAY_IDENTITY_UNAVAILABLE' };
        if (['dispatchRateOverride', 'authorizeCandidate', 'dispatchCandidate'].some(key => Object.hasOwn(request, key) ||
            (request.options && Object.hasOwn(request.options, key)))) {
          return { outcome: 'input_gap', issue: 'SERVER_SAVE_GUARD_ONLY' };
        }
        const sessionInput = { selected, target: RATE_TARGET, allowRealGuest: true, cloudTargetKey, signal };
        if (tool === 'readSavedStayRates' || tool === 'listRateOverrideReasons') {
          if (tool === 'readSavedStayRates' && request.includeReasons !== undefined && typeof request.includeReasons !== 'boolean') {
            return { outcome: 'input_gap', issue: 'RATE_REASONS_OPTION_INVALID' };
          }
          try {
            return await withRateOverrideSavedStay(sessionInput, async session => {
              const target = rateTarget(session.selected);
              if (tool === 'readSavedStayRates') {
                const rates = await readSavedStayNightlyRates(session.page, session.state, target);
                const reasons = request.includeReasons ? await readSavedStayRateReasons(session.page, session.state, target) : null;
                return { outcome: 'ok', rates: publicRates(rates), observedAt: new Date().toISOString(),
                  ...(request.includeReasons && { reasons }) };
              }
              const reasons = await listSavedStayRateOverrideReasons(session.page, session.state, target);
              return { outcome: 'ok', ...reasons };
            });
          } catch (error) { return { outcome: 'read_failed', issue: safeIssue(error, 'RATE_READ_FAILED') }; }
        }
        if (tool === 'prepareRateOverride') {
          pendingRate = null;
          const endDate = request.endDate === undefined ? request.date : request.endDate;
          if (!validNight(request.date) || request.date < selected.arrival || request.date >= selected.departure ||
              !validNight(endDate) || endDate < request.date || endDate >= selected.departure ||
              typeof request.amountCents !== 'string' || !/^[1-9]\d{0,13}$/.test(request.amountCents) ||
              !/^[A-Z]{3}$/.test(request.currency || '') || !/^[A-Z0-9]{1,20}$/.test(request.reasonCode || '')) {
            return { outcome: 'input_gap', issue: 'RATE_OVERRIDE_INPUT_INVALID' };
          }
          const change = { startDate: request.date, endDate, amountCents: request.amountCents,
            currency: request.currency, reason: request.reasonCode };
          try {
            const prepared = await withRateOverrideSavedStay(sessionInput, async session => {
              const stage = await prepareSavedStayRateOverride(session.page, session.state, rateTarget(session.selected), change);
              return { review: structuredClone(stage.review), reasonDescription: stage.reasonDescription,
                selected: structuredClone(session.selected),
                preserved: structuredClone(session.preserved), totalsSource: stage.nativePreview.totalsSource };
            });
            const preparedId = randomUUID();
            const reviewDigest = nativePriceDigest({ review: prepared.review, preserved: prepared.preserved,
              reasonDescription: prepared.reasonDescription });
            pendingRate = { preparedId, reviewDigest, ...prepared };
            return { outcome: 'prepared', preparedId, reviewedBaseline: publicRates(prepared.review.savedRates),
              change: { date: request.date, ...(request.endDate !== undefined && { endDate }), amountCents: request.amountCents, currency: request.currency,
                reasonCode: request.reasonCode, reasonDescription: prepared.reasonDescription }, reviewDigest,
              proposedTotals: null, totalsSource: prepared.totalsSource };
          } catch (error) { return { outcome: 'refused', issue: safeIssue(error, 'RATE_PREPARATION_FAILED') }; }
        }

        if (!pendingRate || typeof request.preparedId !== 'string' || request.preparedId !== pendingRate.preparedId) {
          return { outcome: 'refused', issue: 'RATE_PREPARATION_STALE' };
        }
        if (typeof dispatchRateOverride !== 'function') return { outcome: 'refused', issue: 'RATE_DISPATCH_AUTHORITY_REQUIRED' };
        if (!labtest(pendingRate.selected)) return { outcome: 'refused', issue: 'RATE_LABTEST_WRITE_ONLY' };
        const prepared = pendingRate;
        pendingRate = null;
        sealed = true;
        let continued = false, dispatch = null, failure = null;
        try {
          dispatch = await withRateOverrideSavedStay({ ...sessionInput, selected: prepared.selected, allowRealGuest: false },
            async session => {
              if (JSON.stringify(session.preserved) !== JSON.stringify(prepared.preserved)) {
                throw new Error('RATE_OVERRIDE_BUSINESS_FIELDS_CHANGED');
              }
              const stage = await restageSavedStayRateOverride(session.page, session.state, prepared.review);
              if (stage.reasonDescription !== prepared.reasonDescription) throw new Error('RATE_OVERRIDE_REASON_CHANGED');
              return submitRateOverrideOnce(session, stage, (nativeRequest, continueOnce) =>
                dispatchRateOverride(nativeRequest, async () => { continued = true; return continueOnce(); },
                  structuredClone({ preparedId: prepared.preparedId, reviewDigest: prepared.reviewDigest,
                    review: prepared.review, preserved: prepared.preserved, reasonDescription: prepared.reasonDescription })), { signal });
            });
        } catch (error) { failure = safeIssue(error, 'RATE_COMMIT_FAILED'); }
        let readback = null, readbackIssue = null;
        try {
          readback = await readBackSavedStayRateOverride(prepared.review, { target: RATE_TARGET,
            cloudTargetKey, signal, beforePreserved: prepared.preserved, expectedReasonDescription: prepared.reasonDescription });
        } catch (error) { readbackIssue = safeIssue(error, 'RATE_READBACK_FAILED'); }
        const verification = { nightly: 'UNKNOWN', reasonReadback: 'UNKNOWN', preservedFields: 'UNKNOWN', otherStayFields: 'UNKNOWN',
          ...readback?.comparison };
        return { outcome: failure ? (continued ? 'uncertain' : 'refused') :
          continued && dispatch?.dispatchCallbacksDrained && dispatch.httpStatus >= 200 && dispatch.httpStatus < 300 &&
            verification.nightly === 'MATCHED' && verification.preservedFields !== 'CHANGED' &&
            readback?.reason?.descriptionStatus !== 'CHANGED' && readback?.reason?.codeStatus !== 'CHANGED'
            ? 'partially_verified' : 'uncertain',
          ...(failure && { issue: failure }),
          dispatch: { continued, httpStatus: dispatch?.httpStatus ?? null,
            callbacksDrained: dispatch?.dispatchCallbacksDrained ?? false },
          readback: readback ? { rates: publicRates(readback.rates), reason: readback.reason,
            observedAt: readback.observedAt } : null,
          verification, ...(readbackIssue && { readbackIssue }), next: 'fresh_session' };
      }

      if (tool === 'prepareCancellation') {
        if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
        const result = projectCancellationPreflight({ confirmation: current.confirmation,
          requestedScope: request.requestedScope, shallow: current.shallow, record: current.record });
        return result.outcome === 'prepared_for_human_review' ? { ...result, observedAt: current.observedAt } : result;
      }

      if (tool === 'prepareFinance') {
        if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
        const result = projectFinanceDisplayPreflight({
          confirmation: current.confirmation,
          shallow: current.shallow,
          record: current.record,
        });
        return result.outcome === 'prepared_for_human_review' ? { ...result, observedAt: current.observedAt } : result;
      }

      if (['readAmendmentAvailability', 'searchHotelAvailabilityParty', 'selectHotelAvailabilityParty',
        'cancelHotelAvailabilityParty'].includes(tool)) {
        if (tool === 'readAmendmentAvailability') {
          if (!['generic', 'labtest'].includes(request.mode)) {
            return { outcome: 'input_gap', issue: 'AMEND_AVAILABILITY_MODE_REQUIRED' };
          }
          if (request.mode === 'labtest') {
            if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
            if (current.status !== 'Reserved') return { outcome: 'refused', issue: 'RECORD_NOT_RESERVED' };
            if (!request.expected || typeof request.expected !== 'object' || Array.isArray(request.expected)) {
              return { outcome: 'input_gap', issue: 'EXPECTED_RECORD_REQUIRED' };
            }
            if (request.expected.confirmation !== current.confirmation) {
              return { outcome: 'refused', issue: 'CURRENT_RECORD_MISMATCH' };
            }
          }
        }
        try {
          const availabilityPage = await getAvailabilityPage();
          if (sealed) return { outcome: 'refused', issue: 'FRESH_SESSION_REQUIRED' };
          let result;
          if (tool === 'searchHotelAvailabilityParty') {
            result = await searchHotelAvailabilityParty(availabilityPage, request, request.options);
          } else if (tool === 'selectHotelAvailabilityParty') {
            result = await selectHotelAvailabilityParty(availabilityPage, request);
          } else if (tool === 'cancelHotelAvailabilityParty') {
            result = await cancelHotelAvailabilityParty(availabilityPage);
          } else if (request.mode === 'labtest') {
            result = await readLabtestStayAmendmentAvailability(page, availabilityPage, request.expected, request.options);
          } else {
            result = await readStayAmendmentAvailability(availabilityPage, request.input, request.options);
          }
          // A Labtest refusal can come from either pre-read or post-read checks;
          // the adapter does not distinguish them, so the cached record is no longer safe.
          if (result.outcome === 'selection_uncertain' ||
              (tool === 'readAmendmentAvailability' && request.mode === 'labtest' && result.outcome === 'refused')) sealed = true;
          return result;
        } catch {
          sealed = true;
          return { outcome: 'execution_failure', issue: 'AVAILABILITY_SESSION_FAILED', next: 'fresh_session' };
        }
      }

      if (tool === 'confirmCancel') {
        if (!pendingCancel) return { outcome: 'refused', issue: 'CANCEL_REASON_NOT_CURRENT' };
        const expected = pendingCancel;
        pendingCancel = null;
        sealed = true;
        try { return await confirmLabtestCancellation(page, expected, { cancellationNote: request.cancellationNote }); }
        catch { return { outcome: 'uncertain', issue: 'CANCEL_CONFIRM_FAILED' }; }
      }

      if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
      if (current.status !== 'Reserved') return { outcome: 'refused', issue: 'RECORD_NOT_RESERVED' };
      const expected = request.expected;
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        return { outcome: 'input_gap', issue: 'EXPECTED_RECORD_REQUIRED' };
      }
      if (expected.confirmation !== current.confirmation) {
        return { outcome: 'refused', issue: 'CURRENT_RECORD_MISMATCH' };
      }
      if (tool === 'amendNote') {
        try {
          const result = await amendLabtestNote(page, expected);
          if (result.outcome !== 'input_gap') sealed = true;
          return result;
        } catch { sealed = true; return { outcome: 'uncertain', issue: 'AMEND_FAILED' }; }
      }
      if (tool === 'amendContact') {
        try {
          const paired = Object.hasOwn(request, 'bookerName') || Object.hasOwn(request, 'bookerContact');
          const single = Object.hasOwn(request, 'field') || Object.hasOwn(request, 'value');
          if (paired && single) return { outcome: 'input_gap', issue: 'CONTACT_CHANGE_MODE_CONFLICT' };
          const result = paired
            ? await amendLabtestBookerContact(page, expected, {
              ...(Object.hasOwn(request, 'bookerName') ? { bookerName: request.bookerName } : {}),
              ...(Object.hasOwn(request, 'bookerContact') ? { bookerContact: request.bookerContact } : {}),
            })
            : await amendLabtestContact(page, expected, { field: request.field, value: request.value });
          if (result.outcome !== 'input_gap') sealed = true;
          return result;
        } catch { sealed = true; return { outcome: 'uncertain', issue: 'AMEND_FAILED' }; }
      }
      try {
        const result = await openLabtestCancellation(page, expected);
        if (result.outcome === 'reason_ready') pendingCancel = expected;
        else sealed = true;
        return result;
      } catch { sealed = true; return { outcome: 'uncertain', issue: 'CANCEL_OPEN_FAILED' }; }
    };

    const runTool = (request) => {
      let input, invalid = false;
      try { input = structuredClone(request); }
      catch { invalid = true; }
      const id = input?.id ?? null, tool = input?.tool ?? null;
      if (!accepting) return Promise.resolve({ id, tool, outcome: 'refused', issue: 'SESSION_CLOSED' });
      const result = tail.then(() => {
        if (invalid) return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
        const operation = execute(input);
        const interruptible = ['read', 'readAmendmentAvailability', 'searchHotelAvailabilityParty',
          'selectHotelAvailabilityParty', 'cancelHotelAvailabilityParty'].includes(input?.tool);
        return interruptible ? Promise.race([operation, readInterrupted]) : operation;
      })
        .then((value) => ({ ...value, id, tool }));
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    const screenshotRecord = async () => {
      await tail;
      if (!readOnly || !recordOpen || sealed || nativeDialog || !accepting) throw new Error('RECORD_SCREENSHOT_UNAVAILABLE');
      return page.screenshot({ fullPage: true });
    };
    try { return await operation({ runTool, screenshotRecord }); }
    finally {
      accepting = false;
      await tail;
      pendingRate = null;
      releaseAvailability?.();
      await availabilityTask;
    }
  }, { headless: true, signal, blockServiceWorkers: true, cloudTargetKey,
    ...(prepareContext && { prepareContext }) });
}

const writeLine = (value) => new Promise((done, fail) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? fail(error) : done());
});

export async function runSavedStayAgentSessionCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node saved-stay-agent-session.mjs --jsonl\n' +
      'Tools: read, readSavedStayRates, listRateOverrideReasons, prepareRateOverride, commitRateOverride, prepareCancellation, prepareFinance, readAmendmentAvailability, searchHotelAvailabilityParty, selectHotelAvailabilityParty, cancelHotelAvailabilityParty, amendNote, amendContact, openCancel, confirmCancel, quit. Results contain private data.\n');
    return;
  }
  if (args.length !== 1 || args[0] !== '--jsonl') throw new Error('EXPECTED_JSONL');
  process.umask(0o077);
  await withSavedStayAgentSession(async ({ runTool }) => {
    await writeLine({ event: 'ready', property: 'HRCEN' });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); }
        catch { await writeLine({ outcome: 'input_gap', issue: 'INVALID_JSON' }); continue; }
        if (request?.tool === 'quit') {
          await writeLine({ id: request.id ?? null, tool: 'quit', outcome: 'ok' });
          break;
        }
        await writeLine(await runTool(request));
      }
    } finally { lines.close(); }
  });
}

export function main() {
  return runSavedStayAgentSessionCli().catch((error) => {
    const message = String(error?.message || '').split('\n')[0];
    const issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'SESSION_FAILED';
    process.stderr.write(`${JSON.stringify({ outcome: 'execution_failure', phase: error?.phase ?? 'startup', issue })}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

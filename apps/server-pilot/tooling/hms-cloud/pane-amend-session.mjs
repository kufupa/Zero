// Read and bind the complete native state before a staff-approved Labtest amendment.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import * as centurion from '../playwright-quote/centurion-stay360.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { cleanLabtestRecord, currentLabtestRecord, matchesLabtestBody, snapshotLabtestRecord,
  unchangedLabtestBusinessParties } from './labtest-record.mjs';
import { savedChildOccupancy } from './guest-stay-amend-children.mjs';
import { labtestCombinedAmendPreimageBinding } from './saved-stay-combined-preimage.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';
import { createLabtestAmendDispatch } from './labtest-amend-dispatch.mjs';
import { isOneNightRetainAmend, oneNightRetainPrices, oneNightRetainAvailabilityMatches,
  oneNightRetainReadbackMatches } from './labtest-amend-retain-proof.mjs';
export { oneNightRetainPricesMatchObservations } from './labtest-amend-retain-proof.mjs';
import { stageSavedAdultForComposition, labtestAdultAmendDraftDelta, matchesObservedAdultEffect }
  from './guest-stay-amend-adults.mjs';
import { matchesComposedDateAdultDraft, stageSavedDatesForComposition } from './guest-stay-amend-date-room-rate.mjs';

const identityKeys = ['source', 'propertyCode', 'confirmation', 'reservationStayId', 'reservationId',
  'recordId', 'guestId', 'status', 'firstName', 'lastName', 'arrival', 'departure', 'roomType',
  'ratePlan', 'adults', 'children', 'childAges'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validTarget = (target) => target?.propertyCode === 'HRCEN' && target.browserSlot === 'centurion' &&
  target.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const amendRecordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true,
  preserveUnsentRecipient: true, allowModelOnlyPrimaryPartyIds: true };

/** Values staff must review and the complete native digest must preserve. */
export function cloudAmendPreserved(state) {
  const party = state?.partyPreimage, cmsRecipient = state?.cmsRecipient ?? '';
  const clean = (value, max) => typeof value === 'string' && value.length <= max && !/[\p{Cc}]/u.test(value);
  if (!party || !clean(cmsRecipient, 1000)) return null;
  const link = (id, name) => {
    if (id === '' && name === '') return null;
    if (!/^\d{1,30}$/.test(id || '') || !clean(name, 300) || !name.trim()) throw new Error('PARTY_UNVERIFIED');
    return { nativeId: id, name };
  };
  try {
    const agency = link(party.taid1, party.ta1);
    const organization = link(party.companyid, party.company || party.companyname);
    return { cmsRecipient, agency, organization };
  } catch { return null; }
}

function preservesUnsentRecipient(snapshot, recipient) {
  const data = snapshot?.data, values = snapshot?.values;
  if (!data || !values || typeof recipient !== 'string' ||
      [data, values].some((source) => new Set(Object.keys(source).map((key) => key.toLowerCase())).size !== Object.keys(source).length)) return false;
  return ['data', 'values'].every((part) => Object.hasOwn(snapshot[part], 'udfchar13') &&
      String(snapshot[part].udfchar13 ?? '') === recipient && Object.hasOwn(snapshot[part], 'emailaddress') &&
      String(snapshot[part].emailaddress ?? '') === '') && String(data.udfchkbox04 ?? '') === '0' &&
    (!Object.hasOwn(values, 'udfchkbox04') || ['0', 0, false].includes(values.udfchkbox04));
}

// Install the exact-confirmation read fence before any page or login request.
// A session that skips the pre-login hook is unusable even for a rehearsal.
function guardedSession(input, guard, timeoutMs = 5 * 60_000) {
  let guardedContext = null, guardStarted = false;
  const deadline = AbortSignal.timeout(timeoutMs);
  const safeContext = (context) => context?._options?.serviceWorkers === 'block' &&
    typeof context.serviceWorkers === 'function' && context.serviceWorkers().length === 0;
  return {
    hasGuard: (context) => guardedContext === context && safeContext(context),
    options: { headless: true, blockServiceWorkers: true,
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
      prepareContext: async (context) => {
        if (guardStarted || !safeContext(context)) throw new Error('BROWSER_CONTEXT_UNSAFE');
        // Claim the hook before awaiting route installation. A second context
        // must not race a still-pending guard and become the chosen session.
        guardStarted = true;
        await guard(context, { confirmation: input.confirmation });
        guardedContext = context;
      } },
  };
}

/** Match a full paused Save to the approved fake stay and the post-availability model. */
export function matchesCloudPaneAmendSave(request, frame, snapshot,
  { selected, changes, beforeNote, beforeParties, beforeRecipient = '', phase } = {}) {
  try {
    if (!isOneNightRetainAmend(selected, changes) || !['save', 'retain'].includes(phase) ||
        !/^[A-Z0-9]{1,12}$/.test(selected.roomType || '') ||
        !/^\d{6,}-\d+$/.test(selected.confirmation || '') || !/^\d+$/.test(selected.guestId || '') ||
        selected.propertyCode !== 'HRCEN' || selected.firstName !== 'Proof' || selected.lastName !== 'Labtest' ||
        selected.status !== 'Reserved' || typeof beforeNote !== 'string') return false;
    const adults = changes.adults ?? selected.adults, arrival = changes.arrival ?? selected.arrival,
      departure = changes.departure ?? selected.departure;
    const wireDate = (value) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
    const data = snapshot?.data, values = snapshot?.values;
    if (!data || !values || typeof data !== 'object' || typeof values !== 'object' ||
        Array.isArray(data) || Array.isArray(values) ||
        [data, values].some((source) => new Set(Object.keys(source).map((key) => key.toLowerCase())).size !== Object.keys(source).length) ||
        typeof beforeRecipient !== 'string' ||
        !unchangedLabtestBusinessParties(beforeParties, snapshot, { allowModelOnlyPrimaryPartyIds: true })) return false;
    const identity = { propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest',
      confirmationnumber: selected.confirmation, guestid: selected.guestId,
      reservationid: selected.reservationId, reservationstayid: selected.reservationStayId, recordid: selected.recordId,
      arrivaldate: wireDate(arrival), departuredate: wireDate(departure), roomtype: selected.roomType,
      rateplan: changes.ratePlan, adults: String(adults),
      guaranteetype: 'NGI', reservationnote: beforeNote, udfchkbox04: '0', udfchar13: beforeRecipient, emailaddress: '' };
    if (!Object.entries(identity).every(([key, value]) => typeof value === 'string' && value !== undefined &&
        Object.hasOwn(data, key) && String(data[key] ?? '') === value)) return false;
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const displayDate = (day) => `${day.slice(8, 10)}-${months[Number(day.slice(5, 7)) - 1]}-${day.slice(0, 4)}`;
    const displayed = { confirmationnumber: selected.confirmation, guestid: selected.guestId, status: 'Reserved',
      firstname: 'Proof', lastname: 'Labtest', arrivaldate: displayDate(arrival), departuredate: displayDate(departure),
      roomtype: selected.roomType, rateplan: changes.ratePlan, adults: String(adults),
      guaranteetype: 'NGI', reservationnote: beforeNote, udfchar13: beforeRecipient, emailaddress: '' };
    if (!Object.entries(displayed).every(([key, value]) => Object.hasOwn(values, key) && String(values[key] ?? '') === value) ||
        (Object.hasOwn(values, 'udfchkbox04') && !['0', 0, false].includes(values.udfchkbox04)) ||
        (phase === 'save' && Object.hasOwn(data, 'confirmretainrate') &&
          !['', null, undefined, 'prompt'].includes(data.confirmretainrate))) return false;
    const children = savedChildOccupancy(snapshot), ages = selected.childAges;
    if (!children.valid || children.count !== selected.children ||
        (ages === 'unknown' ? children.ages !== null : !same(children.ages, ages))) return false;
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' ||
        url.pathname !== '/web/base/OSRESV.HDR' || url.hash || [...url.searchParams].length !== 1 ||
        url.searchParams.get('pageaction') !== 'SAVE' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') ||
        new Set(keys.map((key) => key.toLowerCase())).size !== keys.length ||
        !['SYSTEM_FUNCTION_NAME', 'USER_FUNCTION_NAME', 'CURRENT_TAB_NAME']
          .every((key, index) => body.get(key) === ['OSRESV', 'OSRESV', 'HDR'][index])) return false;
    const override = phase === 'retain' ? { confirmretainrate: 'confirmed' } : {};
    return matchesLabtestBody(body, snapshot, override);
  } catch { return false; }
}

/** Do not infer a target from the fake name: the fresh native record must match the selected stay. */
export function expectedLabtestAmendRecord(record, selected) {
  const native = record?.nativePreimage, fields = record?.details?.fields;
  if (!native || !selected || !Array.isArray(fields) || native.source !== 'record_view_ext_model' ||
      native.propertyCode !== 'HRCEN' || native.firstName !== 'Proof' || native.lastName !== 'Labtest' ||
      native.status !== 'Reserved' || native.guaranteeCode !== 'NGI' || native.arrival < '2027-01-01' ||
      identityKeys.some((key) => !Object.hasOwn(native, key) || !Object.hasOwn(selected, key) ||
        !same(native[key], selected[key]))) return null;
  const notes = fields.filter((field) => field?.name === 'reservationnote');
  if (notes.length !== 1 || typeof notes[0].rawValue !== 'string' || notes[0].rawValue.length > 200) return null;
  return { confirmation: native.confirmation, guestId: native.guestId, arrival: native.arrival,
    departure: native.departure, roomType: native.roomType, ratePlan: native.ratePlan, note: notes[0].rawValue,
    adults: native.adults, childCount: native.children,
    childAges: native.childAges === 'unknown' ? null : native.childAges };
}

/** Read only: neither opens an amendment nor performs a rate hold or Save. */
export async function prepareCloudPaneAmend(input, { openSession = withCenturionStay360Page,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding } = {}) {
  const selected = input?.selected, changes = input?.changes;
  if (!validTarget(input?.target) || !isOneNightRetainAmend(selected, changes) ||
      selected.confirmation !== input.confirmation || selected.arrival !== input.arrival) {
    return { outcome: 'refused', issue: 'AMEND_INPUT_INVALID' };
  }
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async (page) => {
      const context = page.context();
      if (!protectedSession.hasGuard(context)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, { guestName: 'Proof Labtest', arrivalDate: input.arrival });
      const record = await read(page, input.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = expectedLabtestAmendRecord(record, selected);
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const state = await current(page, expected, amendRecordOptions);
      const baseline = await snapshot(state.frame);
      const bound = bind(expected, state, baseline, changes);
      const preserved = cloudAmendPreserved(state);
      if (bound?.version !== 1 || !/^[a-f0-9]{64}$/.test(bound.digest) || !preserved) {
        return { outcome: 'refused', issue: 'NATIVE_PREIMAGE_UNVERIFIED' };
      }
      const approvedPrices = oneNightRetainPrices(baseline);
      return approvedPrices ? { outcome: 'prepared', nativeDigest: bound.digest, approvedPrices, preserved }
        : { outcome: 'refused', issue: 'RETAIN_PRICE_UNVERIFIED' };
    }, protectedSession.options);
  } catch {
    // No raw HMS records, guest fields, browser details or credentials leave this boundary.
    return { outcome: 'refused', issue: 'NATIVE_READ_UNAVAILABLE' };
  }
}

/** Return the exact staged draft if availability changed only observed effects back to baseline. */
export function normalizeAmendDraftAfterAvailability(baseline, staged, after) {
  if (!baseline || !staged || !after || !same(Object.keys(staged).sort(), Object.keys(after).sort())) return null;
  const normalized = structuredClone(after);
  for (const key of Object.keys(staged)) {
    if (key !== 'data' && key !== 'values' && !same(staged[key], after[key])) return null;
  }
  for (const part of ['data', 'values']) {
    const first = baseline[part], left = staged[part], right = after[part];
    if (!first || !left || !right || !same(Object.keys(left).sort(), Object.keys(right).sort())) return null;
    for (const key of Object.keys(left)) {
      if (same(left[key], right[key])) continue;
      // Adult staging can clear prices. Availability may restore only those
      // observed native side effects to their exact reviewed baseline values.
      if (!Object.hasOwn(first, key) || !same(first[key], right[key]) ||
          !matchesObservedAdultEffect(baseline, staged, key)) return null;
      normalized[part][key] = left[key];
    }
  }
  return normalized;
}

/** Reuse the existing adult delta fence for the deliberately narrow first writer. */
export function validAdultAmendDraft(before, after, expected, changes) {
  if (!cleanLabtestRecord(before) || !after || !same(Object.keys(before).sort(), Object.keys(after).sort()) ||
      !same(before.partyControls, after.partyControls) || before.partyInputsBlank !== after.partyInputsBlank ||
      String(expected?.adults) !== String(before.data?.adults) ||
      Object.keys(changes || {}).length !== 1 || !Object.hasOwn(changes, 'adults')) return false;
  for (const snapshot of [before, after]) for (const part of ['data', 'values']) {
    const keys = Object.keys(snapshot[part] || {});
    if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length) return false;
  }
  return String(after.data?.enablecheckavailability) === '-1' &&
    labtestAdultAmendDraftDelta(before, after, changes.adults).ok;
}

/** Only the owning, closed browser and an independent positive read can confirm a candidate. */
export function confirmedCloudAmendResult(saved, fresh, writerSessionClosed) {
  if (saved?.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true ||
      writerSessionClosed !== true || fresh?.outcome !== 'matched' || fresh.retainedPriceMatched !== true || !fresh.readback) {
    return { outcome: 'uncertain', issue: 'AMEND_READBACK_UNVERIFIED' };
  }
  return { outcome: 'amended', dispatchCallbacksDrained: true, writerSessionClosed: true,
    retainedPriceMatched: true, readback: fresh.readback };
}

/** The saved-stay control may have text instead of a tooltip; ambiguity refuses. */
export async function clickLabtestAmendAvailability(frame, bounded) {
  const text = frame.locator('.x-btn:visible').filter({ hasText: /^\s*Check Availability\s*$/i });
  const tip = frame.locator('[data-qtip="Check Availability"]:visible');
  const button = text.or(tip);
  if (await bounded(button.count()) !== 1 || !(await bounded(button.isEnabled()))) {
    throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  }
  await bounded(button.click({ timeout: 5_000, noWaitAfter: true }));
}

/**
 * Compose the actual saved-stay controller around one server-owned claim.
 * Constructing these callbacks does not open a page or dispatch a request.
 * The caller must keep Go closed until the rate semantics and recovery are
 * independently proven; the production entry point below enforces that hold.
 */
export function cloudPaneAmendRunOptions({ page, input, expected, authorization, captureBefore = () => {} }, {
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding,
  stageAdults = stageSavedAdultForComposition, stageDates = stageSavedDatesForComposition, verifyDraft = null,
} = {}) {
  const selected = input?.selected, changes = input?.changes;
  if (!page || !expected || !validTarget(input?.target) || !isOneNightRetainAmend(selected, changes) ||
      !/^[a-f0-9]{64}$/.test(input?.nativeDigest || '') || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival) {
    throw new Error('AMEND_CHOICE_UNSUPPORTED');
  }
  const proposed = Object.fromEntries(['arrival', 'departure', 'adults']
    .filter((key) => Object.hasOwn(changes, key) && changes[key] !== selected[key]).map((key) => [key, changes[key]]));
  const dateChanged = Object.hasOwn(proposed, 'arrival') || Object.hasOwn(proposed, 'departure');
  const verifyStaged = verifyDraft ?? (dateChanged ? matchesComposedDateAdultDraft : validAdultAmendDraft);
  const dispatch = createLabtestAmendDispatch({ ...authorization, requiresAvailability: true });
  let postAvailability = null;
  return {
    timeoutMs: 7 * 60_000, signal: input.signal, reportDispatchDrain: true, dispatchDrainTimeoutMs: 5_000,
    prepare: async (bounded) => {
      const state = await bounded(current(page, expected, amendRecordOptions));
      const baseline = await bounded(snapshot(state.frame));
      const preserved = cloudAmendPreserved(state);
      if (!preserved || !same(preserved, input.preserved) ||
          bind(expected, state, baseline, changes)?.digest !== input.nativeDigest) throw new Error('AMEND_PREIMAGE_CHANGED');
      if (!oneNightRetainReadbackMatches(input.approvedPrices, baseline, selected, changes)) throw new Error('AMEND_PRICE_CHANGED');
      if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
          await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) throw new Error('UNEXPECTED_DIALOG');
      const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      if (await bounded(save.count()) !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
      if (!input.beforeScreenshot || typeof authorization?.sealBeforeEvidence !== 'function') {
        throw new Error('AMEND_EVIDENCE_REQUIRED');
      }
      await bounded(page.screenshot({ path: input.beforeScreenshot }));
      // No availability request may be armed until the server has durably
      // sealed the screenshot for this exact run. An ambiguous seal refuses.
      const evidence = await bounded(authorization.sealBeforeEvidence());
      if (!evidence || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence.eventId || '') ||
          !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')) throw new Error('AMEND_EVIDENCE_REQUIRED');
      captureBefore({ beforeNote: expected.note, beforeParties: structuredClone(state.partyPreimage),
        beforeRecipient: preserved.cmsRecipient,
        beforeEvidence: { eventId: evidence.eventId, sha256: evidence.sha256 } });
      return { frame: state.frame, state, baseline, save, enableComposedStage: true };
    },
    stage: async (bounded, prepared, context) => {
      let draft = null;
      if (Object.hasOwn(proposed, 'adults')) draft = (await bounded(stageAdults(context, expected, proposed.adults))).snapshot;
      if (dateChanged) draft = await bounded(stageDates(context, expected, proposed, draft));
      if (!draft || !verifyStaged(prepared.baseline, draft, expected, proposed) || !context.isActive()) {
        throw new Error('AMEND_DRAFT_CHANGED');
      }
      return { draft };
    },
    validate: async (_bounded, _prepared, staged) => Boolean(staged?.draft),
    availability: {
      // The CMS recipient is preserved, never newly chosen, and send remains off.
      recipient: input.preserved.cmsRecipient,
      snapshot: async (bounded, prepared) => {
        const latest = await bounded(snapshot(prepared.frame));
        if (!verifyStaged(prepared.baseline, latest, expected, proposed)) throw new Error('AMEND_DRAFT_CHANGED');
        return latest;
      },
      click: async (bounded, prepared) => {
        await clickLabtestAmendAvailability(prepared.frame, bounded);
      },
      dispatchCandidate: dispatch.availability,
      validate: async (bounded, prepared, staged, response) => {
        const result = await bounded(response.json());
        const after = await bounded(snapshot(prepared.frame));
        const normalized = normalizeAmendDraftAfterAvailability(prepared.baseline, staged?.draft, after);
        // A 200 alone is insufficient: the native result, full staged model and
        // every reviewed amount must still agree before Save can be armed.
        if (!normalized || !verifyStaged(prepared.baseline, normalized, expected, proposed) ||
            !oneNightRetainAvailabilityMatches(result, prepared.baseline, after, selected, changes) ||
            !oneNightRetainReadbackMatches(input.approvedPrices, after, selected, changes)) {
          return { ok: false, issue: 'AMEND_RATE_UNVERIFIED' };
        }
        postAvailability = after;
        return true;
      },
    },
    dispatchCandidate: dispatch.save,
    matches: (request, frame, prepared) => postAvailability !== null &&
      matchesCloudPaneAmendSave(request, frame, postAvailability, { selected, changes, beforeNote: expected.note,
        beforeParties: prepared.state.partyPreimage, beforeRecipient: input.preserved.cmsRecipient, phase: 'save' }),
    retainRate: {
      choice: changes.retainRates,
      snapshot: async (bounded, prepared) => await bounded(snapshot(prepared.frame)),
      matches: (request, frame, prepared, _staged, retained) =>
        matchesCloudPaneAmendSave(request, frame, retained, { selected, changes, beforeNote: expected.note,
          beforeParties: prepared.state.partyPreimage, beforeRecipient: input.preserved.cmsRecipient, phase: 'retain' }),
      dispatchCandidate: dispatch.retain,
    },
  };
}

/** Attach only this owned browser's identity to the first dispatch claim. */
export function bindCloudAmendWriter(page, authorization, capture = centurion.centurionWriterIdentity) {
  if (typeof capture !== 'function' || typeof authorization?.authorizeFirst !== 'function') {
    throw new Error('AMEND_WRITER_UNVERIFIED');
  }
  const writer = structuredClone(capture(page));
  if (!writer || typeof writer !== 'object' || Array.isArray(writer)) throw new Error('AMEND_WRITER_UNVERIFIED');
  return { ...authorization, authorizeFirst: (step) => authorization.authorizeFirst({ ...step, writer }) };
}

/** Admit only the reviewed one-night Labtest case; all native effects still require the paused-request claim. */
export function admitsCloudPaneAmend(input, authorization) {
  const selected = input?.selected;
  return Boolean(validTarget(input?.target) && isOneNightRetainAmend(selected, input?.changes) &&
    selected?.source === 'record_view_ext_model' && selected.propertyCode === 'HRCEN' &&
    selected.firstName === 'Proof' && selected.lastName === 'Labtest' && selected.status === 'Reserved' &&
    /^\d{6,}-\d+$/.test(selected.confirmation || '') && /^\d{1,30}$/.test(selected.guestId || '') &&
    input.confirmation === selected.confirmation && input.arrival === selected.arrival &&
    /^[a-f0-9]{64}$/.test(input.nativeDigest || '') && input.approvedPrices?.version === 1 &&
    typeof input.preserved?.cmsRecipient === 'string' &&
    typeof input.beforeScreenshot === 'string' && input.beforeScreenshot &&
    typeof input.afterScreenshot === 'string' && input.afterScreenshot &&
    /^[a-f0-9]{64}$/.test(authorization?.operationDigest || '') &&
    typeof authorization?.authorizeFirst === 'function' && typeof authorization?.sealBeforeEvidence === 'function' &&
    !input.signal?.aborted);
}

/** Staff Go's native entry point; failures after an effect retain UNKNOWN. */
export async function commitCloudPaneAmend(input, authorization) {
  if (!admitsCloudPaneAmend(input, authorization)) return { outcome: 'not_dispatched', issue: 'AMEND_INPUT_INVALID' };
  let attempted = false, before = null;
  try {
    const protectedSession = guardedSession(input, installSavedStayReadGuard, 12 * 60_000);
    const saved = await withCenturionStay360Page(async (page) => {
      if (!protectedSession.hasGuard(page.context())) throw new Error('BROWSER_CONTEXT_UNSAFE');
      await readShallow(page, input.confirmation, { guestName: 'Proof Labtest', arrivalDate: input.arrival });
      const record = await readRecord(page, input.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = expectedLabtestAmendRecord(record, input.selected);
      if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
      const boundAuthorization = bindCloudAmendWriter(page, authorization);
      attempted = true;
      return runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page,
        input: { ...input, signal: protectedSession.options.signal }, expected, authorization: boundAuthorization,
        captureBefore: (value) => { before = value; } }));
    }, protectedSession.options);
    if (saved.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true) return saved;
    if (!before) return { outcome: 'uncertain', issue: 'AMEND_PREIMAGE_UNVERIFIED' };
    const fresh = await readCloudPaneAmend({ ...input, ...before });
    return confirmedCloudAmendResult(saved, fresh, true);
  } catch {
    return { outcome: attempted ? 'uncertain' : 'not_dispatched', issue: 'AMEND_UNVERIFIED' };
  }
}

/** Read a new session after a possible Save. A match alone does not prove the rate-choice continuation. */
export async function readCloudPaneAmend(input, { openSession = withCenturionStay360Page,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord } = {}) {
  const changes = input?.changes, selected = input?.selected;
  if (!validTarget(input?.target) || !isOneNightRetainAmend(selected, changes) || typeof input.beforeNote !== 'string' ||
      !input.beforeParties || typeof input.beforeParties !== 'object' || typeof input.beforeRecipient !== 'string' ||
      !input.preserved || !input.afterScreenshot) {
    return { outcome: 'unverified' };
  }
  const after = { ...selected, arrival: changes.arrival ?? selected.arrival, departure: changes.departure ?? selected.departure,
    adults: changes.adults ?? selected.adults };
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async (page) => {
      const context = page.context();
      if (!protectedSession.hasGuard(context)) return { outcome: 'unverified' };
      await shallow(page, after.confirmation, { guestName: 'Proof Labtest', arrivalDate: after.arrival });
      const record = await read(page, after.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = expectedLabtestAmendRecord(record, after);
      if (!expected || expected.note !== input.beforeNote) return { outcome: 'unverified' };
      const state = await current(page, expected, amendRecordOptions);
      const saved = await snapshot(state.frame);
      if (!cleanLabtestRecord(saved) || !same(cloudAmendPreserved(state), input.preserved) ||
          state.cmsRecipient !== input.beforeRecipient ||
          !preservesUnsentRecipient(saved, input.beforeRecipient) ||
          !unchangedLabtestBusinessParties(input.beforeParties, saved, { allowModelOnlyPrimaryPartyIds: true })) {
        return { outcome: 'unverified' };
      }
      await page.screenshot({ path: input.afterScreenshot });
      const retainedPriceMatched = oneNightRetainReadbackMatches(input.approvedPrices, saved, selected, input.changes);
      if (!retainedPriceMatched) {
        return { outcome: 'unverified', retainedPriceMatched: false };
      }
      return { outcome: 'matched', readback: { confirmation: after.confirmation, arrival: after.arrival, departure: after.departure,
        adults: after.adults, children: after.children, childAges: after.childAges, ratePlan: after.ratePlan },
        retainedPriceMatched, observedRetainedPrices: oneNightRetainPrices(saved) };
    }, protectedSession.options);
  } catch {
    return { outcome: 'unverified' };
  }
}

#!/usr/bin/env node
// Interactive booking lookup tools share one authenticated, unsaved Guest Stay.
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { takeHandledNotes } from '../playwright-quote/stay360-notes.mjs';
import { loadHmsBookingMemory, queryHmsBookingMemory } from './hms-booking-memory.mjs';
import {
  openNewGuestStay, searchPrimaryBookingAgency, searchOrganization, searchArAccount,
  selectBookingAgency, selectPrimaryBookingAgency, selectOrganization, selectArAccount, closeGuestStayPartyPicker,
} from './lookup.mjs';
import {
  searchGuestProfiles, inspectGuestProfileCandidates, selectGuestProfile, closeGuestProfilePicker,
} from './guest-profile.mjs';
import {
  readGuestStayForm, setGuestStayText, setGuestStayDate, listGuestStayDropdown, selectGuestStayDropdown,
  setGuestStayChildAges, listCmsMessageIds, selectCmsMessageId, closeCmsMessageIdPicker, setCmsSendCheckbox,
} from './guest-stay-form.mjs';
import {
  searchHotelAvailabilityParty, selectHotelAvailabilityParty, cancelHotelAvailabilityParty,
} from './hotel-availability.mjs';
import {
  searchRoomTypes, searchRatePlans, inspectRoomRateCandidate, selectRoomType, closeRoomRatePicker,
} from './guest-stay-room-rate.mjs';
import { selectGuestStayRatePlan } from './guest-stay-rate-plan.mjs';
import {
  searchGuestStaySourceBusiness, inspectGuestStaySourceBusiness,
  selectGuestStaySourceBusiness, closeGuestStaySourceBusinessPicker,
} from './guest-stay-source-business.mjs';
import { readQuote } from './quote-read.mjs';
import { getQuoteView } from './quote-view.mjs';

const PROPERTY = 'HRCEN';
const DEFAULT_DATA_DIR = '/home/orca/.local/share/zero/research/halloween/raw-data';
const quoteSnapshots = new WeakMap();
const unexpectedNativeDialogs = new WeakSet();
const VIEW_FILTERS = new Set(['roomTypes', 'ratePlans', 'offset', 'limit', 'nightOffset', 'nightLimit', 'includeNightlyValueSum']);
const QUERY_ERRORS = new Set([
  'Query must be a string or query object.',
  'Provide exactly one email, domain, or name.',
  'Conflicting query roles.',
  'Invalid address role.',
  'Address roles apply only to email and domain queries.',
  'Email query must contain exactly one address.',
  'Invalid email address.',
  'Domain query must be an exact domain name.',
  'Name query must contain searchable characters.',
  'Invalid source of business filter.',
]);

function defaultMemorySources(env) {
  if (env.HMS_MEMORY_PMS_PATH) {
    return { pmsPath: env.HMS_MEMORY_PMS_PATH, outboundPdfPath: env.HMS_MEMORY_OUTBOUND_PATH || undefined };
  }
  const dir = env.HMS_MEMORY_DATA_DIR || DEFAULT_DATA_DIR;
  return {
    pmsPath: join(dir, 'stay360-1a-1b-1c-20261029-run01.json'),
    outboundPdfPath: env.HMS_MEMORY_OUTBOUND_PATH || join(dir, 'centurion-outbound-pdf-records-2026-10-29.jsonl'),
  };
}

/** An absent or invalid private corpus must not prevent live tools from starting. */
export async function loadOptionalBookingMemory(sources = defaultMemorySources(process.env)) {
  try {
    const memory = await loadHmsBookingMemory({ ...sources, propertyCode: PROPERTY });
    return { memory, status: 'available' };
  } catch (error) {
    return {
      memory: null,
      status: 'unavailable',
      issue: ['ENOENT', 'EACCES', 'ENOTDIR'].includes(error?.code) ? 'memory_files_unavailable' : 'memory_load_failed',
    };
  }
}

/** Read visible values, including blanks, from the current unsaved Guest Stay. */
export async function readUnsavedGuestStay(page) {
  const reading = page.evaluate(() => {
    const visible = (node) => node.getClientRects().length > 0 && !node.closest('.x-window');
    const find = (name) => [...document.querySelectorAll(`input[name="${name}"]`)].find(visible);
    const agency = find('ta1');
    const confirmation = find('confirmationnumber');
    if (!agency || !confirmation || confirmation.value.trim()) {
      return { outcome: 'execution_failure', issue: 'NOT_A_NEW_GUEST_STAY' };
    }
    let root = agency;
    while (root && !root.contains(confirmation)) root = root.parentElement;
    if (!root) return { outcome: 'execution_failure', issue: 'LOOKUP_FORM_UNAVAILABLE' };
    const fields = [...root.querySelectorAll('input, textarea, select')]
      .filter((node) => visible(node) && !['hidden', 'password'].includes(node.type))
      .map((node) => {
        const component = node.id && globalThis.Ext?.getCmp?.(node.id.replace(/-inputEl$/, ''));
        const label = node.closest('.x-form-item, .x-field')?.querySelector('label')?.innerText?.trim()
          || [...(node.labels || [])].map((item) => item.innerText?.trim()).filter(Boolean).join(' ')
          || node.getAttribute('aria-label') || component?.getFieldLabel?.() || component?.boxLabel || null;
        return {
          id: node.id || null, name: node.name || null, label,
          type: node.type || node.tagName.toLowerCase(),
          value: ['checkbox', 'radio'].includes(node.type) ? node.checked : node.value,
          disabled: node.disabled, readOnly: node.readOnly || false,
        };
      });
    return { outcome: 'ok', form: { fields } };
  });
  let timer;
  let result;
  try {
    result = await Promise.race([
      reading,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('FORM_READ_TIMEOUT')), 15000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { ...result, notes: await takeHandledNotes(page) };
}

/** Close the Guest Stay availability iframe and verify the unsaved form. */
export async function closeHotelAvailability(page) {
  if (!page || typeof page.frames !== 'function' || typeof page.on !== 'function') {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  let nativeDialog = false;
  let attempted = false;
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    const surfaces = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const title = frame.locator('h1.pagetitle:visible').filter({ hasText: /^Hotel Availability$/ });
      const dates = frame.locator('input[name="dates"]:visible');
      if (await title.count().catch(() => 0) === 1 && await dates.count().catch(() => 0) === 1) {
        const host = await frame.frameElement();
        if (await host.isVisible()) surfaces.push({ frame, host });
      }
    }
    if (surfaces.length !== 1) throw new Error(surfaces.length ? 'AVAILABILITY_SURFACE_AMBIGUOUS' : 'HOTEL_AVAILABILITY_NOT_OPENED');
    const { frame, host } = surfaces[0];
    const windows = page.locator('.x-window:visible:not(.x-menu), .x-message-box:visible');
    for (let index = 0; index < await windows.count(); index += 1) {
      if (!await windows.nth(index).evaluate((element, iframe) => element.contains(iframe), host)) {
        throw new Error('UNEXPECTED_DIALOG');
      }
    }
    if (nativeDialog || await frame.locator('.x-window:visible:not(.x-menu), .x-message-box:visible').count()) {
      throw new Error('UNEXPECTED_DIALOG');
    }
    const property = frame.locator('input[name="propertycodes"]:visible');
    if (await property.count() !== 1 || (await property.inputValue()).trim().toUpperCase() !== PROPERTY) {
      throw new Error('PROPERTY_MISMATCH');
    }
    const draftMatches = await page.evaluate((expected) => {
      const visible = (element) => Boolean((element.offsetWidth || element.offsetHeight) &&
        getComputedStyle(element).visibility !== 'hidden' && !element.closest('.x-window'));
      const confirmation = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(visible);
      const agency = [...document.querySelectorAll('input[name="ta1"]')].filter(visible);
      const propertyCode = document.documentElement.dataset.propertyCode ?? /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1];
      return location.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com' && propertyCode === expected &&
        confirmation.length === 1 && !confirmation[0].value.trim() && agency.length === 1;
    }, PROPERTY);
    if (!draftMatches) throw new Error('PROPERTY_OR_BLANK_STAY_MISMATCH');
    const before = await readUnsavedGuestStay(page);
    if (before.outcome !== 'ok') throw new Error(before.issue || 'NOT_A_NEW_GUEST_STAY');
    const close = frame.locator('a.x-btn:visible').filter({ hasText: /^\s*Close\s*$/ });
    if (await close.count() !== 1) throw new Error('AVAILABILITY_CLOSE_AMBIGUOUS');
    attempted = true;
    await close.click({ timeout: 5000 });
    await host.waitForElementState('hidden', { timeout: 10000 });
    if (nativeDialog) throw new Error('UNEXPECTED_DIALOG');
    const verified = await readGuestStayForm(page, { propertyCode: PROPERTY });
    if (verified.outcome !== 'ok') throw new Error(verified.issue || 'FORM_READBACK_FAILED');
    const after = await readUnsavedGuestStay(page);
    if (after.outcome !== 'ok') throw new Error(after.issue || 'FORM_READBACK_FAILED');
    return { outcome: 'closed_unsaved', form: after.form, notes: after.notes };
  } catch (error) {
    const message = String(error?.message || '').split('\n')[0];
    return { outcome: attempted ? 'close_uncertain' : 'execution_failure',
      issue: nativeDialog ? 'UNEXPECTED_DIALOG' : /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'AVAILABILITY_CLOSE_FAILED' };
  } finally {
    page.off('dialog', onDialog);
  }
}

async function snapshotBytes(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      throw new Error('PRIVATE_SNAPSHOT_UNSAFE');
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

const snapshotHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function registerQuoteSnapshot(page, result, roomQuantity) {
  if (page.isClosed()) throw new Error('SESSION_CLOSED');
  const bytes = await snapshotBytes(result.snapshotPath);
  if (page.isClosed()) throw new Error('SESSION_CLOSED');
  const handle = randomUUID();
  let snapshots = quoteSnapshots.get(page);
  if (!snapshots) {
    snapshots = new Map();
    quoteSnapshots.set(page, snapshots);
    page.once('close', () => quoteSnapshots.delete(page));
  }
  snapshots.set(handle, { path: result.snapshotPath, hash: snapshotHash(bytes), roomQuantity });
  return handle;
}

async function viewQuoteSnapshot(page, request) {
  if (page.isClosed()) return { outcome: 'execution_failure', issue: 'SESSION_CLOSED' };
  if (Object.hasOwn(request, 'snapshotPath')) return { outcome: 'input_gap', issue: 'SNAPSHOT_PATH_NOT_ACCEPTED' };
  if (Object.hasOwn(request, 'roomQuantity') ||
      (request.criteria && typeof request.criteria === 'object' && Object.hasOwn(request.criteria, 'roomQuantity'))) {
    return { outcome: 'input_gap', issue: 'ROOM_QUANTITY_FIXED' };
  }
  if (typeof request.snapshotHandle !== 'string' || !request.snapshotHandle) {
    return { outcome: 'input_gap', issue: 'SNAPSHOT_HANDLE_REQUIRED' };
  }
  if (!request.view || typeof request.view !== 'object' || Array.isArray(request.view) ||
      Object.keys(request.view).some((key) => !VIEW_FILTERS.has(key))) {
    return { outcome: 'input_gap', issue: 'INVALID_QUOTE_VIEW' };
  }
  const snapshot = quoteSnapshots.get(page)?.get(request.snapshotHandle);
  if (!snapshot) return { outcome: 'input_gap', issue: 'UNKNOWN_SNAPSHOT_HANDLE' };
  let bytes;
  try { bytes = await snapshotBytes(snapshot.path); }
  catch { return { outcome: 'execution_failure', issue: 'PRIVATE_SNAPSHOT_UNAVAILABLE' }; }
  if (page.isClosed()) return { outcome: 'execution_failure', issue: 'SESSION_CLOSED' };
  if (snapshotHash(bytes) !== snapshot.hash) return { outcome: 'execution_failure', issue: 'SNAPSHOT_CHANGED' };
  try {
    const view = getQuoteView(JSON.parse(bytes.toString('utf8')), { ...request.view, roomQuantity: snapshot.roomQuantity });
    return { outcome: 'ok', snapshotOutcome: view.outcome, snapshotHandle: request.snapshotHandle, view };
  } catch (error) {
    const message = String(error?.message || '');
    if (['INVALID_AVAILABILITY_VIEW_PAGE', 'AVAILABILITY_VIEW_FILTERS_MUST_BE_ARRAYS', 'NIGHTLY_SUM_FLAG_INVALID'].includes(message)) {
      return { outcome: 'input_gap', issue: message };
    }
    return { outcome: 'execution_failure', issue: 'QUOTE_PROJECTION_FAILED' };
  }
}

/** Execute one call; the caller retains the page and memory between calls. */
export async function runBookingLookupTool({ page, memory, memoryIssue } = {}, request = {}) {
  const id = request?.id ?? null;
  const tool = request?.tool ?? null;
  try {
    if (request?.options !== undefined && (!request.options || typeof request.options !== 'object' || Array.isArray(request.options))) {
      return { id, tool, outcome: 'input_gap', issue: 'invalid_options' };
    }
    if (tool === 'memory' || tool === 'queryBookingMemory') {
      if (!memory) return { id, tool, outcome: 'unavailable', issue: memoryIssue || 'memory_unavailable' };
      if (page && memory.propertyCode !== PROPERTY) {
        return { id, tool, outcome: 'unavailable', issue: 'memory_property_mismatch' };
      }
      const result = queryHmsBookingMemory(memory, request.query, request.options);
      if (['email', 'domain'].includes(result.queryType)
          && !memory.addressEvidence.some((item) => item.role === result.role)) {
        return { id, tool, outcome: 'unavailable', issue: 'memory_address_sources_unavailable', result };
      }
      return { id, tool, outcome: 'ok', result };
    }
    const tools = {
      agency: searchPrimaryBookingAgency, searchPrimaryBookingAgency,
      organization: searchOrganization, searchOrganization,
      arAccount: searchArAccount, searchArAccount,
      selectAgency: selectBookingAgency, selectPrimaryBookingAgency, selectOrganization, selectArAccount, closeGuestStayPartyPicker,
      readGuestStay: readUnsavedGuestStay,
      searchGuestProfiles, inspectGuestProfileCandidates, selectGuestProfile, closeGuestProfilePicker,
      readGuestStayForm, setGuestStayText, setGuestStayDate, listGuestStayDropdown, selectGuestStayDropdown,
      setGuestStayChildAges, listCmsMessageIds, selectCmsMessageId, closeCmsMessageIdPicker, setCmsSendCheckbox,
      searchHotelAvailabilityParty, selectHotelAvailabilityParty, cancelHotelAvailabilityParty,
      searchRoomTypes, searchRatePlans, inspectRoomRateCandidate, selectRoomType, closeRoomRatePicker, selectGuestStayRatePlan,
      searchGuestStaySourceBusiness, inspectGuestStaySourceBusiness,
      selectGuestStaySourceBusiness, closeGuestStaySourceBusinessPicker,
      closeHotelAvailability, readQuote, viewQuoteSnapshot,
    };
    if (!Object.hasOwn(tools, tool)) return { id, tool, outcome: 'input_gap', issue: 'unknown_tool' };
    const action = tools[tool];
    if (!page) return { id, tool, outcome: 'input_gap', issue: 'page_required' };
    if (unexpectedNativeDialogs.has(page) && tool !== 'viewQuoteSnapshot') {
      return { id, tool, outcome: 'execution_failure', issue: 'UNEXPECTED_DIALOG' };
    }
    let result;
    if (['readGuestStay', 'closeGuestProfilePicker', 'cancelHotelAvailabilityParty', 'closeHotelAvailability',
      'closeRoomRatePicker', 'closeGuestStaySourceBusinessPicker'].includes(tool)) {
      result = await action(page);
    } else if (tool === 'searchGuestStaySourceBusiness') {
      const input = { ...request };
      delete input.id;
      delete input.tool;
      delete input.options;
      result = await action(page, input, request.options);
    } else if (tool === 'readQuote') {
      if (!request.view || typeof request.view !== 'object' || Array.isArray(request.view)) {
        return { id, tool, outcome: 'input_gap', issue: 'QUOTE_VIEW_REQUIRED' };
      }
      result = await action(page, request);
      if (typeof result.snapshotPath === 'string') {
        const roomQuantity = request.roomQuantity ?? request.criteria?.roomQuantity ?? null;
        try { result.snapshotHandle = await registerQuoteSnapshot(page, result, roomQuantity); }
        catch (error) { result = { outcome: 'execution_failure',
          issue: error?.message === 'SESSION_CLOSED' ? 'SESSION_CLOSED' : 'SNAPSHOT_REGISTRATION_FAILED', snapshotPath: result.snapshotPath }; }
      }
    } else if (tool === 'viewQuoteSnapshot') {
      result = await action(page, request);
    } else if (tool === 'selectAgency') {
      const selection = request.selection ?? (request.searchId === undefined
        ? request.nativeId : { nativeId: request.nativeId, searchId: request.searchId });
      result = await action(page, selection, request.options);
    } else if (tool === 'selectPrimaryBookingAgency' || tool === 'selectOrganization' || tool === 'selectArAccount') {
      const selection = request.selection ?? { nativeId: request.nativeId, searchId: request.searchId };
      result = await action(page, selection, request.options);
    } else if ([
      'searchGuestProfiles', 'inspectGuestProfileCandidates', 'selectGuestProfile',
      'readGuestStayForm', 'setGuestStayText', 'setGuestStayDate', 'listGuestStayDropdown',
      'selectGuestStayDropdown', 'setGuestStayChildAges', 'listCmsMessageIds', 'selectCmsMessageId',
      'closeGuestStayPartyPicker', 'closeCmsMessageIdPicker',
      'setCmsSendCheckbox', 'searchHotelAvailabilityParty', 'selectHotelAvailabilityParty',
      'searchRoomTypes', 'searchRatePlans', 'inspectRoomRateCandidate', 'selectRoomType', 'selectGuestStayRatePlan',
      'inspectGuestStaySourceBusiness', 'selectGuestStaySourceBusiness',
    ].includes(tool)) {
      result = await action(page, request, request.options);
    } else {
      result = await action(page, request.query, request.options);
    }
    return { id, tool, ...result };
  } catch (error) {
    if (tool === 'readGuestStay' && [
      'FORM_READ_TIMEOUT', 'NOTE_PRIVATE_DIRECTORY_UNSAFE', 'NOTE_CLOSE_NOT_UNIQUE', 'UNEXPECTED_DIALOG',
    ].includes(error?.message)) {
      return { id, tool, outcome: 'execution_failure', issue: error.message };
    }
    if ((tool === 'memory' || tool === 'queryBookingMemory') && error instanceof TypeError && QUERY_ERRORS.has(error.message)) {
      return { id, tool, outcome: 'input_gap', issue: 'invalid_memory_query', detail: error.message };
    }
    return { id, tool, outcome: 'execution_failure', issue: tool === 'memory' || tool === 'queryBookingMemory'
      ? 'memory_query_failed' : 'tool_failed' };
  }
}

export const runPartyTool = runBookingLookupTool;

/** Own one guarded page for the callback; the page is closed when it returns. */
export async function withBookingLookupSession(operation, { memory, memorySources, headless = true } = {}) {
  const loaded = memory === undefined
    ? await loadOptionalBookingMemory(memorySources)
    : { memory, status: memory ? 'available' : 'unavailable', issue: memory ? undefined : 'memory_unavailable' };
  if (loaded.memory && loaded.memory.propertyCode !== PROPERTY) {
    Object.assign(loaded, { memory: null, status: 'unavailable', issue: 'memory_property_mismatch' });
  }
  return withCenturionStay360Page(async (page) => {
    await installReadOnlyGuard(page.context());
    try { await openNewGuestStay(page); }
    catch (error) {
      if (error && typeof error === 'object') error.phase = 'new_guest_stay';
      throw error;
    }
    const context = { page, memory: loaded.memory, memoryIssue: loaded.issue };
    const onDialog = () => { unexpectedNativeDialogs.add(page); };
    page.on('dialog', onDialog);
    try {
      return await operation({ ...context, memoryStatus: loaded.status, runTool: (request) => runBookingLookupTool(context, request) });
    } finally {
      page.off('dialog', onDialog);
      unexpectedNativeDialogs.delete(page);
    }
  }, { headless });
}

const usage = 'Usage: node booking-lookup-session.mjs --jsonl\n' +
  'Tools: queryBookingMemory, searchPrimaryBookingAgency, selectPrimaryBookingAgency, searchOrganization, ' +
  'selectOrganization, searchArAccount, selectArAccount, readGuestStay, guest/profile/form tools, ' +
  'availability-party, room/rate/source tools, readQuote, viewQuoteSnapshot, closeHotelAvailability, quit. Legacy names remain available.\n' +
  'JSONL results contain private data; redirect them to a private location.\n';

const writeJsonLine = (value) => new Promise((done, fail) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? fail(error) : done());
});

export async function runBookingLookupSessionCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
    return;
  }
  if (args.length !== 1 || args[0] !== '--jsonl') throw new Error('EXPECTED_JSONL');
  process.umask(0o077);
  await withBookingLookupSession(async ({ runTool, memoryStatus, memoryIssue }) => {
    await writeJsonLine({ event: 'ready', property: PROPERTY, memory: { status: memoryStatus, ...(memoryIssue ? { issue: memoryIssue } : {}) } });
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); }
        catch {
          await writeJsonLine({ outcome: 'input_gap', issue: 'invalid_json' });
          continue;
        }
        if (request?.tool === 'quit') {
          await writeJsonLine({ id: request.id ?? null, tool: 'quit', outcome: 'ok' });
          break;
        }
        await writeJsonLine(await runTool(request));
      }
    } finally {
      lines.close();
    }
  });
}

export function main() {
  return runBookingLookupSessionCli().catch((error) => {
    const message = String(error?.message || error).split('\n')[0];
    const issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(message) ? message : 'SESSION_FAILED';
    process.stderr.write(`${JSON.stringify({ outcome: 'execution_failure', phase: error?.phase ?? 'startup', issue })}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

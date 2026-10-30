#!/usr/bin/env node
// Interactive booking lookup tools share one authenticated, unsaved Guest Stay.
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { takeHandledNotes } from '../playwright-quote/stay360-notes.mjs';
import { loadHmsBookingMemory, queryHmsBookingMemory } from './hms-booking-memory.mjs';
import {
  openNewGuestStay, searchPrimaryBookingAgency, searchOrganization, searchArAccount,
  selectBookingAgency, selectPrimaryBookingAgency, selectOrganization, selectArAccount,
} from './lookup.mjs';

const PROPERTY = 'HRCEN';
const DEFAULT_DATA_DIR = '/home/orca/.local/share/zero/research/halloween/raw-data';
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
      selectAgency: selectBookingAgency, selectPrimaryBookingAgency, selectOrganization, selectArAccount,
      readGuestStay: readUnsavedGuestStay,
    };
    if (!Object.hasOwn(tools, tool)) return { id, tool, outcome: 'input_gap', issue: 'unknown_tool' };
    const action = tools[tool];
    if (!page) return { id, tool, outcome: 'input_gap', issue: 'page_required' };
    let result;
    if (tool === 'readGuestStay') {
      result = await action(page);
    } else if (tool === 'selectAgency') {
      const selection = request.selection ?? (request.searchId === undefined
        ? request.nativeId : { nativeId: request.nativeId, searchId: request.searchId });
      result = await action(page, selection, request.options);
    } else if (tool === 'selectPrimaryBookingAgency' || tool === 'selectOrganization' || tool === 'selectArAccount') {
      const selection = request.selection ?? { nativeId: request.nativeId, searchId: request.searchId };
      result = await action(page, selection, request.options);
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
    return operation({ ...context, memoryStatus: loaded.status, runTool: (request) => runBookingLookupTool(context, request) });
  }, { headless });
}

const usage = 'Usage: node booking-lookup-session.mjs --jsonl\n' +
  'Tools: queryBookingMemory, searchPrimaryBookingAgency, selectPrimaryBookingAgency, searchOrganization, ' +
  'selectOrganization, searchArAccount, selectArAccount, readGuestStay, quit. Legacy names remain available.\n' +
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

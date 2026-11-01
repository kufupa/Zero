#!/usr/bin/env node
// One guarded page for reading an existing stay and explicitly requested Labtest actions.
import { createInterface } from 'node:readline';
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

const RETRYABLE_LOOKUPS = new Set([
  'SEARCH_RESULTS_CAPPED', 'CONFIRMATION_NOT_FOUND', 'CONFIRMATION_HINT_MISMATCH',
  'CONFIRMATION_HINT_UNVERIFIED', 'SEARCH_RESULTS_CHANGED',
  'INVALID_CONFIRMATION', 'INVALID_GUEST_NAME', 'INVALID_ARRIVAL_DATE', 'INVALID_LOOKUP_OPTIONS',
]);

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

/** Own a headless guarded page; calls submitted through runTool execute in order. */
export async function withSavedStayAgentSession(operation, { signal } = {}) {
  if (typeof operation !== 'function') throw new Error('SESSION_CALLBACK_REQUIRED');
  signal?.throwIfAborted();
  return withCenturionStay360Page(async (page) => {
    await installReadOnlyGuard(page.context());
    let current = null, recordOpen = false, pendingCancel = null, sealed = false, nativeDialog = null;
    let accepting = true, tail = Promise.resolve();
    let interruptRead;
    const readInterrupted = new Promise((resolve) => { interruptRead = resolve; });
    page.on('dialog', (dialog) => {
      nativeDialog = { type: dialog.type(), message: dialog.message() };
      sealed = true;
      interruptRead({ outcome: /penalt|fee|charge|deposit/i.test(nativeDialog.message)
        ? 'fee_dialog_pending' : 'unexpected_dialog', issue: 'NATIVE_DIALOG', nativeDialog, next: 'fresh_session' });
    });

    const execute = async (request) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        return { outcome: 'input_gap', issue: 'INVALID_REQUEST' };
      }
      const { tool } = request;
      if (!['read', 'prepareCancellation', 'amendNote', 'amendContact', 'openCancel', 'confirmCancel'].includes(tool)) {
        return { outcome: 'input_gap', issue: 'UNKNOWN_TOOL' };
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
          const record = await readRecord(page, shallow.confirmation);
          recordOpen = true;
          const statuses = record.details.fields.filter((field) => field.name === 'status');
          current = { confirmation: shallow.confirmation, status: statuses.length === 1 ? statuses[0].value : null,
            shallow: structuredClone(shallow), record: structuredClone(record), observedAt: new Date().toISOString() };
          return { outcome: 'ok', shallow, record };
        } catch (error) {
          sealed = true;
          return { ...readFailure(error, 'record', shallow), next: 'fresh_session' };
        }
      }

      if (tool === 'prepareCancellation') {
        if (!current) return { outcome: 'refused', issue: 'CURRENT_RECORD_REQUIRED' };
        const result = projectCancellationPreflight({ confirmation: current.confirmation,
          requestedScope: request.requestedScope, shallow: current.shallow, record: current.record });
        return result.outcome === 'prepared_for_human_review' ? { ...result, observedAt: current.observedAt } : result;
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
        return input?.tool === 'read' ? Promise.race([operation, readInterrupted]) : operation;
      })
        .then((value) => ({ ...value, id, tool }));
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    try { return await operation({ runTool }); }
    finally { accepting = false; await tail; }
  }, { headless: true, signal });
}

const writeLine = (value) => new Promise((done, fail) => {
  process.stdout.write(`${JSON.stringify(value)}\n`, (error) => error ? fail(error) : done());
});

export async function runSavedStayAgentSessionCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node saved-stay-agent-session.mjs --jsonl\n' +
      'Tools: read, prepareCancellation, amendNote, amendContact, openCancel, confirmCancel, quit. Results contain private data.\n');
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

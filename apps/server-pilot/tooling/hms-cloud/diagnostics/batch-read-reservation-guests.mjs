#!/usr/bin/env node
// Read selected guest forms and Record View, reusing bounded read-only sessions.
import { readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withCenturionStay360Page } from '../../playwright-quote/centurion-stay360.mjs';
import { readShallow, readRecord, readGuest, readGuestForm } from '../hms-readers.mjs';
import { prepareGuardedContext, isGuardedPage } from '../pre-navigation-context-guard.mjs';
import { installReadOnlyGuard, shouldAbortReadOnlyRequest } from '../../playwright-quote/hms-read-only-guard.mjs';

if (process.argv[2] === '--help') {
  console.log('Usage: node batch-read-reservation-guests.mjs INPUT.json OUTPUT.json');
  console.log('Input: {propertyCode: HRCEN, candidates: [{confirmation, nativeId?, lookupOptions?}]}. Output must be private and outside Git.');
  process.exit(0);
}
if (process.argv.length !== 4) throw new Error('EXPECTED_INPUT_AND_OUTPUT');
process.umask(0o077);
const input = resolve(process.argv[2]), output = resolve(process.argv[3]), dir = dirname(output);
if (await realpath(dir) !== dir) throw new Error('OUTPUT_DIRECTORY_ALIAS');
const stat = await lstat(dir);
if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('OUTPUT_DIRECTORY_NOT_PRIVATE');
for (let parent = dir; ; parent = dirname(parent)) {
  try { await lstat(resolve(parent, '.git')); throw new Error('OUTPUT_IN_GIT'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (dirname(parent) === parent) break;
}
const data = JSON.parse(await readFile(input, 'utf8')), candidates = data.candidates;
if (data.propertyCode !== 'HRCEN' || !Array.isArray(candidates) || !candidates.length ||
    candidates.some(row => typeof row?.confirmation !== 'string' || !row.confirmation.trim() || row.confirmation !== row.confirmation.trim()) ||
    new Set(candidates.map(row => row.confirmation)).size !== candidates.length) throw new Error('INVALID_CANDIDATES');
const report = { source: input, propertyCode: data.propertyCode, startedAt: new Date().toISOString(),
  completed: 0, total: candidates.length, sessions: [], results: [] };
await writeFile(output, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
async function checkpoint() {
  const partial = output + '.partial';
  await writeFile(partial, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  await rename(partial, output);
}
async function closeReadRecord(page) {
  const popup = page.locator('.x-window:visible:not(.x-menu)').filter({ has: page.locator('iframe:visible') });
  if (await popup.count() !== 1) throw new Error('READ_RECORD_WINDOW_UNVERIFIED');
  const iframe = popup.locator('iframe:visible');
  if (await iframe.count() !== 1 || !await iframe.evaluate(element =>
    new URL(element.src, location.href).searchParams.get('initpath') === 'OSRESV')) throw new Error('READ_RECORD_WINDOW_UNVERIFIED');
  const frame = await (await iframe.elementHandle()).contentFrame();
  if (!frame) throw new Error('READ_RECORD_WINDOW_UNVERIFIED');
  const close = frame.locator('a.x-btn:visible, button.x-btn:visible').filter({ hasText: /^Close$/ });
  if (await close.count() !== 1) throw new Error('READ_RECORD_CLOSE_UNAVAILABLE');
  await close.click({ timeout: 10_000 });
  await popup.waitFor({ state: 'hidden', timeout: 15_000 });
}

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
let next = 0;
while (next < candidates.length && !controller.signal.aborted) {
  const session = { verified: false, startIndex: next, issue: null, deniedWrite: false, unexpectedDialog: false, entered: false, guardFailed: false };
  report.sessions.push(session);
  const stop = Math.min(next + 20, candidates.length);
  try {
    await withCenturionStay360Page(async page => {
      session.entered = true;
      const assertPage = () => {
        if (!isGuardedPage(page)) { session.guardFailed = true; throw new Error('READ_SESSION_GUARD_TRIPPED'); }
      };
      assertPage();
      page.on('dialog', () => { session.unexpectedDialog = true; });
      while (next < stop && !controller.signal.aborted) {
        const row = candidates[next++], startedAt = new Date().toISOString();
        try {
          const stay360 = await readShallow(page, row.confirmation, row.lookupOptions ?? {});
          const recordView = await readRecord(page, row.confirmation, { nativePropertyCode: 'HRCEN', nativeIdentityOnly: true });
          const guestDetails = await readGuest(page, row.confirmation);
          const guestForms = await readGuestForm(page, row.confirmation);
          const identities = recordView.details.fields.filter(field => field.name === 'guestid');
          if (identities.length !== 1) throw new Error('PRIMARY_GUEST_PROFILE_UNVERIFIED');
          const primaryId = identities[0].value;
          const identity = String(primaryId ?? '').trim();
          if (!/^\d+$/.test(identity) || !guestForms.guests.some(guest => guest.profileId === identity && guest.form && !guest.error)) {
            throw new Error('PRIMARY_GUEST_PROFILE_UNVERIFIED');
          }
          await closeReadRecord(page);
          assertPage();
          if (session.deniedWrite || session.unexpectedDialog) throw new Error('READ_SESSION_GUARD_TRIPPED');
          report.results.push({ ok: true, confirmation: row.confirmation, historicalProfileId: row.nativeId ?? null,
            nativeId: identity, sessionIndex: report.sessions.length - 1, startedAt, observedAt: new Date().toISOString(),
            stay360, recordView, guestDetails, guestForms });
        } catch (error) {
          const issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : error?.name === 'TimeoutError' ? 'RESERVATION_UI_TIMEOUT' : 'RESERVATION_GUEST_READ_FAILED';
          report.results.push({ ok: false, confirmation: row.confirmation, sessionIndex: report.sessions.length - 1, issue });
          // Keep the existing lookup's native choices in the private report.
          // The caller can investigate ambiguity without repeating the lookup.
          if (Array.isArray(error?.candidates)) Object.assign(report.results.at(-1), {
            candidates: error.candidates, searchedDateRange: error.searchedDateRange, searchResults: error.searchResults,
          });
          throw error; // Quarantine the session before reading another reservation.
        } finally {
          report.completed = next;
          await checkpoint();
          if (next % 5 === 0) console.log(JSON.stringify({ completed: next, total: candidates.length,
            succeeded: report.results.filter(result => result.ok).length }));
        }
      }
    }, { headless: true, blockServiceWorkers: true, prepareContext: async context => {
        await prepareGuardedContext(context);
        await installReadOnlyGuard(context);
        context.on('request', request => {
          const url = new URL(request.url());
          const cardInit = url.origin === 'https://hmsvault.hms.eu1.inforcloudsuite.com' &&
            url.pathname === '/Vault/servlets/showCardEntryHandler';
          if (!cardInit && shouldAbortReadOnlyRequest({ method: request.method(), url: request.url(), postData: request.postData() })) {
            session.deniedWrite = true;
          }
        });
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]) });
    session.verified = session.entered && !session.guardFailed && !session.deniedWrite && !session.unexpectedDialog;
  } catch (error) {
    if (error?.message === 'READ_SESSION_GUARD_TRIPPED') session.guardFailed = true;
    session.verified = session.entered && !session.guardFailed && error?.phase !== 'cleanup' && !session.deniedWrite && !session.unexpectedDialog && !controller.signal.aborted;
    session.issue = /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : 'SESSION_UNAVAILABLE';
    // A setup failure must still advance and be recorded, rather than loop forever.
    if (next === session.startIndex) {
      report.results.push({ ok: false, confirmation: candidates[next++].confirmation,
        sessionIndex: report.sessions.length - 1, issue: session.issue });
      report.terminalIssue = session.issue;
      break; // Do not repeatedly launch against a persistent setup or credential failure.
    }
  }
  report.completed = next;
  await checkpoint();
}
report.completed = next;
report.endedAt = new Date().toISOString();
report.complete = next === candidates.length && !controller.signal.aborted;
await checkpoint();
console.log(JSON.stringify({ complete: report.complete, completed: next, total: candidates.length,
  succeeded: report.results.filter(result => result.ok && report.sessions[result.sessionIndex].verified).length,
  unverifiedSessions: report.sessions.filter(session => !session.verified).length }));
if (!report.complete || report.results.some(row => !row.ok || !report.sessions[row.sessionIndex].verified)) process.exitCode = 1;

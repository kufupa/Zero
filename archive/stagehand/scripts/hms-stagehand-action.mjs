#!/usr/bin/env node
/** Reviewed, model-free commands on the guarded EC2 browser owner. */
import { chromium } from '../tooling/stagehand/node_modules/playwright/index.mjs';
import { readFile } from 'node:fs/promises';

process.umask(0o077);
const action = process.argv[2];
const controlUrl = process.env.HMS_STAGEHAND_CONTROL_URL ?? 'http://127.0.0.1:19224';
const safeCaptureReason = /^[A-Z][A-Z0-9_]{0,63}$/;
const safeActionErrors = new Set([
  'OWNER_PAGE_MISMATCH',
  'EXACT_CLOSE_NOT_UNIQUE',
  'NOTES_POPUP_REQUIRED',
  'OWNER_COMMAND_FAILED',
]);

function ownerEndpoint(pathname) {
  const base = new URL(controlUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password)
    throw Error('LOOPBACK_CONTROL_REQUIRED');
  return new URL(pathname, base);
}

function capturePersistenceStatus(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = value;
  if (
    typeof status.ok !== 'boolean' ||
    typeof status.partial !== 'boolean' ||
    !Number.isSafeInteger(status.rejectedCount) ||
    status.rejectedCount < 0
  )
    return undefined;
  return {
    ok: status.ok,
    partial: status.partial,
    rejectedCount: status.rejectedCount,
    ...(typeof status.reason === 'string' && safeCaptureReason.test(status.reason)
      ? { reason: status.reason }
      : {}),
  };
}

const reviewed = [
  'open_menu',
  'front_desk',
  'account',
  'guest_stay',
  'search_parent',
  'open_parent',
  'folio',
  'folio_all_view',
  'folio_all_run',
  'folio_all_next',
  'property_ledger',
  'advance_deposit',
  'deposit_schedule',
  'traces',
  'notes',
  'dismiss_notes_popup',
];
if (!reviewed.includes(action)) throw Error('UNREVIEWED_ACTION');
const owner = JSON.parse(
  await readFile('.private/stagehand-trial-20260917/discovery-owner.json', 'utf8'),
);
if (!/^[a-f0-9]{64}$/.test(owner.controlToken ?? '')) throw Error('OWNER_TOKEN_REQUIRED');
const headers = {
  authorization: `Bearer ${owner.controlToken}`,
  'content-type': 'application/json',
};
const stateResponse = await fetch(ownerEndpoint('/state'), { headers });
if (!stateResponse.ok) throw Error('OWNER_AUTH_FAILED');
const state = await stateResponse.json();
if (state.phase !== 'ready' || state.terminal || state.marker !== owner.marker)
  throw Error('OWNER_NOT_READY');
const timer = setTimeout(() => process.exit(70), 25000);
let failed = false;
let capturePersistence;
try {
  if (action === 'dismiss_notes_popup') {
    // Attach only; Chromium, guards, recording and final teardown remain on EC2.
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19223');
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === state.pageUrl);
    if (
      !page ||
      (await page.evaluate(() => document.documentElement.dataset.proofSession)) !== owner.marker
    )
      throw Error('OWNER_PAGE_MISMATCH');
    const popup = page.locator('.x-window.modal');
    if (
      (await popup.count()) !== 1 ||
      (await popup.locator('.x-window-header-text').innerText()).trim() !== 'Notes'
    )
      throw Error('NOTES_POPUP_REQUIRED');
    const close = popup.locator('a.x-btn').filter({ hasText: /^Close$/ });
    if ((await close.count()) !== 1) throw Error('EXACT_CLOSE_NOT_UNIQUE');
    await close.click({ timeout: 8000 });
  }
  // Owner serializes commands and awaits the correlated search/LST response
  // before granting dependent, exact-parent read permissions.
  // The default remains the reviewed loopback command endpoint:
  // http://127.0.0.1:19224/command
  const response = await fetch(ownerEndpoint('/command'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: action === 'dismiss_notes_popup' ? 'capture' : action }),
  });
  const proof = await response.json();
  capturePersistence = capturePersistenceStatus(proof.capturePersistence);
  if (!response.ok || proof.terminal || proof.violation) throw Error('OWNER_COMMAND_FAILED');
  console.log(
    JSON.stringify({
      action,
      commandSuccess: true,
      captureComplete: capturePersistence?.ok === false ? false : 'unknown',
      ...(capturePersistence ? { capturePersistence } : {}),
      sequence: proof.sequence,
      modelCalls: 0,
    }),
  );
} catch (error) {
  failed = true;
  console.log(
    JSON.stringify({
      action,
      commandSuccess: false,
      captureComplete: capturePersistence?.ok === false ? false : 'unknown',
      ...(capturePersistence ? { capturePersistence } : {}),
      error: safeActionErrors.has(error?.message) ? error.message : 'PLAYWRIGHT_ACTION_FAILED',
    }),
  );
} finally {
  clearTimeout(timer);
  // Do not close the owner browser/context; dropping this disposable client is sufficient.
  process.exit(failed ? 1 : 0);
}

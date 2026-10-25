#!/usr/bin/env node
// Read-only create preflight. One run per property/date reports every Save blocker.
// Never clicks Save. The HMS request guard stays on for the whole run.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INFORMATIONAL_NO_ROOMS_MESSAGE, waitHmsMaskCleared } from './create-lab-stay.mjs';
import { loadCreateRequest, optionalPartyAndNoteFills, parseOutDir, shopResult } from './create-request.mjs';
import { parseStayProperty, profileFor, propertySecretRefusal } from './property-profile.mjs';
import { searchGuestOnOpenGuestStay } from './stay-lookup.mjs';
import { openGuestStayScreen } from './open-guest-stay.mjs';
import { installReadOnlyGuard, shouldAbortReadOnlyRequest } from './hms-read-only-guard.mjs';
import { displayDate, login, newBorrowedContext, openHotelAvailability, playwright, readSecret, search } from './fetch-quote.mjs';
import { checkCdpEnv } from './cancel-stay-rules.mjs';

const NAV_WATCH = ['Front Desk', 'Availability', 'Hotel Availability', 'Guest Stay', 'New Record'];

export { shouldAbortReadOnlyRequest, installReadOnlyGuard };

export function formatBlocker(blocker) {
  if (blocker?.kind === 'required_field' && blocker.field) return `blocker:${blocker.kind} ${blocker.field}`;
  return `blocker:${blocker?.kind ?? 'unknown'}`;
}

export function preflightExitCode(result) {
  if ((result?.blockers?.length ?? 0) > 0) return 2;
  if (result?.captureError) return 2;
  return 0;
}

export function sanitizeDom(html) {
  return String(html ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s(value|data-qtip|data-errorqtip)="[^"]*"/gi, ' $1=""')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{6,}(?:-\d+)?\b/g, '[redacted-id]')
    .slice(0, 200_000);
}

function nightClosed(night) {
  const r = night?.restrictions ?? {};
  return night?.restricted === true || night?.rateAvailable === false || r.combClosed === true || r.combClosedToArrival === true;
}

export function availabilityBlockers(availability = {}, messages = []) {
  const text = [...(messages ?? []), availability.messageBox].filter(Boolean).join('\n');
  if (availability.error) return [{ kind: 'availability', detail: 'unread' }];
  if (text.includes(INFORMATIONAL_NO_ROOMS_MESSAGE)) return [{ kind: 'availability', detail: 'no_rooms' }];
  if (availability.restricted === true || availability.rateAvailable === false || availability.inventory === 0) {
    return [{ kind: 'availability', detail: 'restricted' }];
  }
  if ((availability.nights ?? availability.nightly ?? []).some(nightClosed)) {
    return [{ kind: 'availability', detail: 'restricted' }];
  }
  if (availability.searched && Array.isArray(availability.rows) && availability.rows.length === 0) {
    return [{ kind: 'availability', detail: 'no_rows' }];
  }
  return [];
}

export function requiredNames(_propertyCode, profile) {
  const names = new Set();
  if (Array.isArray(profile?.requiredCreateFields)) {
    for (const name of profile.requiredCreateFields) names.add(String(name).toLowerCase());
  }
  return names;
}

export function requiredFieldBlockers(fields = [], propertyCode, profile) {
  const required = requiredNames(propertyCode, profile);
  const byName = new Map((fields ?? []).map((field) => [String(field.name || '').toLowerCase(), field]));
  const blockers = [];
  const push = (name) => {
    if (!blockers.some((blocker) => blocker.field === name)) blockers.push({ kind: 'required_field', field: name });
  };
  for (const name of required) {
    const field = byName.get(name);
    if (!field || field.blank || !String(field.value ?? '').trim()) push(name);
  }
  for (const field of fields ?? []) {
    const name = String(field.name || '').toLowerCase();
    if (field.required && (field.blank || !String(field.value ?? '').trim())) push(name);
  }
  return blockers;
}

export function navBlockers(nav = []) {
  return (nav ?? [])
    .filter((node) => NAV_WATCH.includes(node.name) && node.visible && node.inViewport === false)
    .map((node) => ({ kind: 'nav', field: node.name }));
}

export function collectBlockers(snapshot) {
  return [
    ...availabilityBlockers(snapshot?.availability, snapshot?.messages),
    ...requiredFieldBlockers(snapshot?.fields, snapshot?.propertyCode, snapshot?.profile),
    ...navBlockers(snapshot?.nav),
  ];
}

export function buildPreflightResult(snapshot) {
  const blockers = collectBlockers(snapshot);
  return {
    propertyCode: snapshot.propertyCode ?? null,
    arrival: snapshot.arrival ?? null,
    departure: snapshot.departure ?? null,
    blockers,
    blockerLabels: blockers.map(formatBlocker),
    fields: snapshot.fields ?? [],
    availability: snapshot.availability ?? null,
    nav: snapshot.nav ?? [],
    messages: snapshot.messages ?? [],
    duplicateSearch: snapshot.duplicateSearch ?? null,
    clickedSave: false,
    captureError: snapshot.captureError ?? null,
    dump: snapshot.dump ?? null,
    screenshot: snapshot.screenshot ?? null,
  };
}

export function requestedAvailability(records, stay) {
  const wantRoom = String(stay?.roomType || '').toUpperCase();
  const wantRate = String(stay?.ratePlan || '').toUpperCase();
  const rows = (records ?? []).filter((row) => {
    const room = String(row.roomType || '').toUpperCase();
    const code = String(row.code || '').toUpperCase();
    if (wantRoom && room !== wantRoom) return false;
    if (wantRate && code !== wantRate) return false;
    return true;
  });
  return {
    searched: true,
    rows,
    restricted: rows.some((row) => row.restricted === true || nightClosed(row)),
    inventory: rows.reduce((sum, row) => sum + (Number(row.inventory) || 0), 0),
    nights: rows.flatMap((row) => row.nights ?? []),
  };
}

async function fillNamed(page, name, value) {
  if (value == null || String(value).trim() === '') return;
  const input = page.locator(`input[name="${name}"]:visible, textarea[name="${name}"]:visible`).first();
  await input.click();
  await input.fill(String(value));
  await input.press('Tab');
}

async function fillCreateForm(page, stay) {
  if (stay.arrival) await fillNamed(page, 'arrivaldate', displayDate(stay.arrival));
  if (stay.departure) await fillNamed(page, 'departuredate', displayDate(stay.departure));
  if (stay.adults != null) await fillNamed(page, 'adults', String(stay.adults));
  await fillNamed(page, 'firstname', stay.firstName);
  await fillNamed(page, 'lastname', stay.lastName);
  await fillNamed(page, 'sourceofbusinessdesc', stay.sourceOfBusiness);
  await fillNamed(page, 'roomtype', stay.roomType);
  await fillNamed(page, 'rateplan', stay.ratePlan);
  await fillNamed(page, 'track', stay.track);
  for (const [name, value] of Object.entries(optionalPartyAndNoteFills(stay))) {
    if (value) await fillNamed(page, name, value);
  }
}

export function inspectCreateFields(document = globalThis.document) {
  const visible = (el) => {
    const style = `${el?.getAttribute?.('style') || ''} ${el?.style?.cssText || ''}`;
    if (!el || /display\s*:\s*none/i.test(style) || el.hasAttribute?.('hidden')) return false;
    if (/\bx-hide-display\b|\bx-hidden\b/.test(String(el.className || ''))) return false;
    return !!(el.offsetParent || (el.getClientRects?.().length));
  };
  return [...document.querySelectorAll('input[name], textarea[name]')].filter(visible).map((el) => {
    const wrap = el.closest('.x-form-item, .x-field, table') || el.parentElement;
    const label = wrap?.querySelector?.('label, .x-form-item-label, .x-form-item-label-text');
    const required = /\bx-form-required\b|\bx-item-required\b/.test(`${el.className || ''} ${wrap?.className || ''}`)
      || el.getAttribute('aria-required') === 'true'
      || /\*/.test(label?.textContent || '');
    const value = String(el.value || '').trim();
    return { name: el.getAttribute('name') || '', value, required, blank: !value };
  });
}

export async function inspectNavNodes(page) {
  return page.evaluate((names) => {
    const visible = (el) => !!(el && (el.offsetParent || el.getClientRects?.().length));
    const inView = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const tree = (name) => [...document.querySelectorAll('span.x-tree-node-text')].find((n) => (n.textContent || '').trim() === name);
    return names.map((name) => {
      const el = name === 'New Record' ? document.querySelector('[data-qtip="New Record (Ctrl+N)"]') : tree(name);
      return el ? { name, visible: visible(el), inViewport: inView(el) } : { name, visible: false, inViewport: false };
    });
  }, NAV_WATCH);
}

export async function installPreflightGuard(context) {
  await installReadOnlyGuard(context);
}

export async function writePreflightArtifacts(outDir, result, { html = '', page } = {}) {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const dumpPath = join(outDir, 'dump.html');
  await writeFile(dumpPath, sanitizeDom(html));
  let screenshot = result.screenshot ?? null;
  if (!screenshot && page?.screenshot) {
    screenshot = join(outDir, 'preflight.png');
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => { screenshot = null; });
  }
  const written = { ...result, dump: dumpPath, screenshot, clickedSave: false };
  await writeFile(join(outDir, 'preflight.json'), JSON.stringify(written, null, 2));
  return written;
}

async function shopAvailability(page, stay) {
  await openHotelAvailability(page);
  await page.locator('input[name="startdate"]:visible').fill(displayDate(stay.arrival));
  await page.locator('input[name="startdate"]:visible').press('Tab');
  await search(page);
  await page.getByText('Processing request').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  const read = await page.evaluate(() => {
    const view = document.querySelector('.x-tree-view, .x-grid-view');
    const cmp = view && window.Ext?.getCmp(view.id);
    const records = (cmp?.getStore?.().getRange?.() ?? []).map((record) => {
      const data = record.data || {};
      return {
        roomType: data.roomtype || data.roomType || data.room || data.code || '',
        code: data.rateplan || data.ratecode || data.code || '',
        name: data.ratedesc || data.description || data.name || '',
        restricted: data.restricted === true,
        inventory: data.value ?? data.inventory ?? null,
      };
    });
    const lines = [...document.querySelectorAll('.x-grid-row, .x-grid-data-row, .x-grid-cell')]
      .map((row) => (row.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { records, lines };
  });
  shopResult(read.records, read.lines);
  return requestedAvailability(read.records, stay);
}

async function captureSnapshot(page, { stay, propertyCode, profile, searchGuest = searchGuestOnOpenGuestStay, dir }) {
  const errors = [];
  const nav = await inspectNavNodes(page).catch(() => []);
  let availability = { searched: false, rows: [] };
  try { availability = await shopAvailability(page, stay); } catch (error) {
    availability = { searched: false, rows: [], error: String(error?.message || error).slice(0, 300) };
    errors.push('availability');
  }
  await openGuestStayScreen(page);
  await waitHmsMaskCleared(page).catch((error) => {
    errors.push(`mask:${String(error?.message || error).slice(0, 80)}`);
  });
  try {
    await page.locator('[data-qtip="New Record (Ctrl+N)"]').click();
  } catch (error) {
    errors.push(`nav:${String(error?.message || error).slice(0, 80)}`);
  }
  await page.locator('input[name="lastname"]:visible, textarea[name="reservationnote"]:visible').first().waitFor().catch(() => {});
  await fillCreateForm(page, stay).catch(() => {});
  let fields = await page.evaluate(inspectCreateFields).catch(() => null);
  if (!fields) { errors.push('fields'); fields = []; }
  const messages = await page.evaluate(() => [...document.querySelectorAll('[data-testid="message-box"], .x-message-box')]
    .filter((el) => el.offsetParent || el.getClientRects?.().length)
    .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8)).catch(() => []);
  const html = await page.content().catch(() => '');
  let screenshot = null;
  if (dir && page?.screenshot) {
    screenshot = join(dir, 'preflight.png');
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => { screenshot = null; });
  }
  let duplicateSearch = null;
  try {
    await page.keyboard.press('Escape').catch(() => {});
    duplicateSearch = await searchGuest({
      page,
      dir,
      started: Date.now(),
      args: { mode: 'search-guest', confirmation: null, lastName: stay.lastName, arrival: stay.arrival, departure: stay.departure, debugHtml: false },
      result: { screenshots: [], timings: {}, quickStages: [] },
    });
  } catch (error) {
    duplicateSearch = { outcome: 'execution_failure', error: String(error?.message || error).slice(0, 300) };
  }
  const navAfter = await inspectNavNodes(page).catch(() => []);
  const mergedNav = [...nav, ...navAfter].filter((node, i, all) => all.findIndex((other) => other.name === node.name && other.inViewport === node.inViewport) === i);
  return {
    propertyCode, profile, arrival: stay.arrival, departure: stay.departure, fields, availability, messages,
    nav: mergedNav, duplicateSearch, dump: html, screenshot, captureError: errors.length ? errors.join(',') : null,
  };
}

export async function runCreatePreflight({ context, page, stay, propertyCode, profile, outDir, snapshot, searchGuest } = {}) {
  if (context) await installPreflightGuard(context);
  if (outDir) await mkdir(outDir, { recursive: true, mode: 0o700 });
  const resolvedProfile = profile ?? profileFor(propertyCode);
  const snap = snapshot ?? await captureSnapshot(page, { stay, propertyCode, profile: resolvedProfile, searchGuest, dir: outDir });
  if (!snap.profile) snap.profile = resolvedProfile;
  const result = buildPreflightResult(snap);
  return outDir ? writePreflightArtifacts(outDir, result, { html: snap.dump ?? '', page }) : result;
}

async function main(argv = process.argv.slice(2)) {
  const property = parseStayProperty(argv);
  const rest = property.ok ? property.rest : argv;
  const loaded = await loadCreateRequest(rest);
  const out = parseOutDir(rest);
  for (const step of [property, loaded, out]) {
    if (!step.ok) {
      process.stderr.write(`${step.error}\n`);
      process.exitCode = step.exitCode ?? 2;
      return;
    }
  }
  const propertyCode = property.propertyCode;
  const profile = profileFor(propertyCode);
  if (!profile) { process.stderr.write('PROPERTY_PROFILE_REQUIRED\n'); process.exitCode = 2; return; }
  const cdp = checkCdpEnv(process.env);
  if (!cdp.ok) { process.stderr.write(`${cdp.error}\n`); process.exitCode = 2; return; }
  const dir = out.outDir ?? join(fileURLToPath(new URL('../../../../.private/create-screen/preflight/', import.meta.url)), propertyCode);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const secret = await readSecret();
  const hotelMismatch = propertySecretRefusal(secret, propertyCode);
  if (hotelMismatch) throw new Error(hotelMismatch);
  const browser = await playwright().chromium.connectOverCDP(cdp.href, { timeout: 20000 });
  const context = await newBorrowedContext(browser, { ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
  try {
    await login(page, secret);
    const result = await runCreatePreflight({ context, page, stay: loaded.request, propertyCode, profile, outDir: dir });
    process.stdout.write(`${JSON.stringify({ blockers: result.blockerLabels, clickedSave: false })}\n`);
    process.exitCode = preflightExitCode(result);
  } catch (error) {
    const payload = {
      propertyCode,
      blockers: [{ kind: 'nav', field: 'New Record' }],
      blockerLabels: ['blocker:nav'],
      clickedSave: false,
      captureError: String(error?.message || error).slice(0, 300),
    };
    await writeFile(join(dir, 'preflight.json'), JSON.stringify(payload, null, 2)).catch(() => {});
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error?.message || error}\n`); process.exitCode = 1; });
}

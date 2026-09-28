#!/usr/bin/env node
/**
 * Hotel-safe gates for Centurion lab SPA overlays.
 * Lab and hotel share /var/www/nava-mail — a full client tar must not strip
 * hotel surfaces (Outlook setup download) or wipe /downloads/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Branches allowed to receive a lab SPA overlay on the live hotel root. */
export const LAB_OVERLAY_ALLOWED_BRANCHES = new Set([
  'main',
  'feat/outlook-setup-download-button',
]);

export const HOTEL_OUTLOOK_SOURCE = 'apps/mail/components/settings/outlook-setup-download.tsx';

/** Strings that must appear in the built SPA when overlaying the shared hotel root. */
export const HOTEL_SPA_REQUIRED_MARKERS = [
  'NavaOutlookSetup',
  'Download Outlook Setup',
  '/download/NavaOutlookSetup.exe',
];

export function assertLabOverlayBranch(branch) {
  const name = String(branch || '').trim();
  if (!LAB_OVERLAY_ALLOWED_BRANCHES.has(name)) {
    throw new Error(
      `REFUSING_CUTOVER: lab SPA overlay blocked on branch "${name}". ` +
        `Allowed: ${[...LAB_OVERLAY_ALLOWED_BRANCHES].join(', ')}`,
    );
  }
  return name;
}

export function assertHotelOutlookSourcePresent(repoRoot) {
  const path = join(repoRoot, HOTEL_OUTLOOK_SOURCE);
  if (!existsSync(path)) {
    throw new Error(
      `REFUSING_OVERLAY: missing ${HOTEL_OUTLOOK_SOURCE}. ` +
        'Lab worktree must keep Outlook setup download on the catchup page ' +
        'because overlay replaces the shared hotel SPA root.',
    );
  }
  const text = readFileSync(path, 'utf8');
  if (!text.includes('OUTLOOK_SETUP_DOWNLOAD_HREF') || !text.includes('NavaOutlookSetup.exe')) {
    throw new Error(`REFUSING_OVERLAY: ${HOTEL_OUTLOOK_SOURCE} missing download href markers`);
  }
  return path;
}

function listJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listJsFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

export function assertBuiltSpaKeepsHotelOutlook(clientDir) {
  if (!existsSync(clientDir)) {
    throw new Error(`REFUSING_OVERLAY: missing SPA build ${clientDir}`);
  }
  const files = listJsFiles(clientDir);
  if (files.length === 0) {
    throw new Error(`REFUSING_OVERLAY: no JS assets under ${clientDir}`);
  }
  const blob = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const missing = HOTEL_SPA_REQUIRED_MARKERS.filter((m) => !blob.includes(m));
  if (missing.length) {
    throw new Error(
      `REFUSING_OVERLAY: built SPA missing hotel Outlook markers: ${missing.join(', ')}. ` +
        'Wire OutlookSetupDownloadButton into catchup-upload before overlaying.',
    );
  }
  return { filesChecked: files.length, markers: HOTEL_SPA_REQUIRED_MARKERS };
}

export function assertSpaAssetsKeepHotelOutlook(webRoot) {
  return assertBuiltSpaKeepsHotelOutlook(join(webRoot, 'assets'));
}

export function assertDownloadsPreserved(webRoot, { required = false } = {}) {
  const downloads = join(webRoot, 'downloads');
  const exe = join(downloads, 'NavaOutlookSetup.exe');
  if (!existsSync(downloads)) {
    if (required) {
      throw new Error(`REFUSING_OVERLAY: missing ${downloads} (hotel Outlook installer dir)`);
    }
    return { present: false, exePresent: false };
  }
  const exePresent = existsSync(exe);
  if (required && !exePresent) {
    throw new Error(`REFUSING_OVERLAY: missing ${exe}`);
  }
  return { present: true, exePresent };
}

/** CLI: node lab-spa-overlay-guards.mjs <command> ... */
function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'preflight') {
    const [repoRoot, clientDir] = rest;
    assertHotelOutlookSourcePresent(repoRoot);
    const result = assertBuiltSpaKeepsHotelOutlook(clientDir);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (cmd === 'assert-branch') {
    console.log(assertLabOverlayBranch(rest[0]));
    return;
  }
  if (cmd === 'postflight-spa') {
    const result = assertSpaAssetsKeepHotelOutlook(rest[0]);
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (cmd === 'assert-downloads') {
    const required = rest[1] === '--required';
    console.log(JSON.stringify(assertDownloadsPreserved(rest[0], { required })));
    return;
  }
  throw new Error(
    'usage: lab-spa-overlay-guards.mjs preflight <repoRoot> <clientDir> | assert-branch <name> | postflight-spa <webRoot> | assert-downloads <webRoot> [--required]',
  );
}

const isCli =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

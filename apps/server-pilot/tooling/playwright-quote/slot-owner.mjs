#!/usr/bin/env node
/**
 * Native Playwright hotel-slot owner. Persistent Chromium, loopback CDP, no Stagehand.
 * Importing this module does not launch a browser.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function parseSlotOwnerConfig(env = process.env) {
  const debugAddress = env.HMS_SLOT_DEBUG_ADDRESS ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(debugAddress)) {
    throw new Error('SLOT_DEBUG_ADDRESS_NOT_LOOPBACK');
  }
  const profileDir = env.HMS_SLOT_PROFILE_DIR;
  const cdpPortRaw = env.HMS_SLOT_CDP_PORT;
  if (!profileDir) throw new Error('SLOT_PROFILE_DIR_REQUIRED');
  if (!cdpPortRaw) throw new Error('SLOT_CDP_PORT_REQUIRED');
  const cdpPort = Number(cdpPortRaw);
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw new Error('SLOT_CDP_PORT_INVALID');
  }
  return {
    debugAddress,
    profileDir,
    cdpPort,
    phasePath: env.HMS_SLOT_PHASE_PATH ?? join(profileDir, '..', 'phase.json'),
    headless: env.HMS_SLOT_HEADLESS !== '0',
  };
}

export function chromiumLaunchArgs(config) {
  return [
    `--remote-debugging-address=${config.debugAddress}`,
    `--remote-debugging-port=${config.cdpPort}`,
  ];
}

export async function writeSlotPhase(fsLike, phasePath, phase, extra = {}) {
  const payload = JSON.stringify(
    { phase, pid: process.pid, at: new Date().toISOString(), ...extra },
    null,
    2,
  );
  await fsLike.writeFile(phasePath, payload, { mode: 0o600 });
}

export async function resetSlotOwner({ wipeProfile, recover }) {
  await wipeProfile();
  await recover();
}

export async function attachSlotOwnerSignals(processLike, { writePhase, close }) {
  let pending = Promise.resolve();
  const shutdown = async (signal) => {
    await writePhase('down', { signal }).catch(() => {});
    await close().catch(() => {});
  };
  processLike.once('SIGTERM', () => {
    pending = shutdown('SIGTERM');
  });
  processLike.once('SIGINT', () => {
    pending = shutdown('SIGINT');
  });
  await pending;
}

async function runSlotOwner(env = process.env) {
  process.umask(0o077);
  const config = parseSlotOwnerConfig(env);
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  const fsLike = { writeFile };
  await writeSlotPhase(fsLike, config.phasePath, 'recovering');
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    ignoreHTTPSErrors: true,
    acceptDownloads: false,
    args: chromiumLaunchArgs(config),
  });
  await writeSlotPhase(fsLike, config.phasePath, 'ready');
  let closing;
  const close = async () => {
    if (closing) return closing;
    closing = context.close().catch(() => {});
    await closing;
  };
  await attachSlotOwnerSignals(process, {
    writePhase: (phase, extra) => writeSlotPhase(fsLike, config.phasePath, phase, extra),
    close,
  });
  await new Promise(() => {});
}

export async function wipeSlotProfile(profileDir) {
  await rm(profileDir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'reset') {
    const config = parseSlotOwnerConfig();
    await resetSlotOwner({
      wipeProfile: () => wipeSlotProfile(config.profileDir),
      recover: () => runSlotOwner(),
    });
  } else {
    await runSlotOwner();
  }
}

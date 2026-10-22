/**
 * Hotel IT takes Infor HMS down every Wednesday ~12:00–15:30 SAST
 * (10:00–13:30 UTC). Jobs pause only when that window is open *and* a cheap
 * TCP probe says HMS is unreachable. Outside the window, failures stay failures.
 */
import net from 'node:net';
import { CENTURION_HMS_PRODUCTION_ORIGIN } from './browser-artifacts.js';

/** Wednesday. `Date#getUTCDay` Sunday = 0. */
const HMS_MAINTENANCE_WEEKDAY_UTC = 3;
const HMS_MAINTENANCE_START_MINUTE_UTC = 10 * 60;
const HMS_MAINTENANCE_END_MINUTE_UTC = 13 * 60 + 30;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_CACHE_MS = 20_000;

export const HMS_MAINTENANCE_FAILURE_CLASS = 'HMS_MAINTENANCE' as const;
export const HMS_WEEKLY_MAINTENANCE_COPY = 'HMS weekly maintenance, back about 15:30';
export const HMS_WEEKLY_MAINTENANCE_LAST_ERROR = 'hms weekly maintenance';

export type HmsWeeklyMaintenanceHooks = {
  now: () => Date;
  /** Null means the default probe (always-up under Vitest, TCP in production). */
  reachable: (() => Promise<boolean>) | null;
};

export const hmsWeeklyMaintenanceHooks: HmsWeeklyMaintenanceHooks = {
  now: () => new Date(),
  reachable: null,
};

let probeCache: { at: number; ok: boolean } | null = null;

export function resetHmsWeeklyMaintenanceHooks(): void {
  hmsWeeklyMaintenanceHooks.now = () => new Date();
  hmsWeeklyMaintenanceHooks.reachable = null;
  probeCache = null;
}

export function isHmsWeeklyMaintenanceWindow(now: Date): boolean {
  if (now.getUTCDay() !== HMS_MAINTENANCE_WEEKDAY_UTC) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= HMS_MAINTENANCE_START_MINUTE_UTC && minutes < HMS_MAINTENANCE_END_MINUTE_UTC;
}

function hmsProbeTarget(): { host: string; port: number } {
  const url = new URL(CENTURION_HMS_PRODUCTION_ORIGIN);
  return { host: url.hostname, port: url.port ? Number(url.port) : 443 };
}

function tcpProbeHms(): Promise<boolean> {
  const { host, port } = hmsProbeTarget();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function defaultHmsReachable(): Promise<boolean> {
  // Existing HMS job tests use the real clock. Never pause them on Wednesday.
  if (process.env.VITEST) return true;
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_CACHE_MS) return probeCache.ok;
  const ok = await tcpProbeHms();
  probeCache = { at: now, ok };
  return ok;
}

/**
 * True only inside the Wednesday window when HMS does not answer the probe.
 * A probe error during the window counts as unreachable.
 */
export async function shouldPauseHmsJobsForWeeklyMaintenance(): Promise<boolean> {
  if (!isHmsWeeklyMaintenanceWindow(hmsWeeklyMaintenanceHooks.now())) return false;
  const probe = hmsWeeklyMaintenanceHooks.reachable ?? defaultHmsReachable;
  try {
    return !(await probe());
  } catch {
    return true;
  }
}

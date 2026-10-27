import {
  readInstalledStaffQuoteConfiguration,
  type StaffQuoteInstallationConfiguration,
} from './staff-quote-installation.js';
import {
  hmsReadTargetForTransport,
  type HmsReadTarget,
} from '../hms/hms-read-target.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';

export type PaneStayHmsTargetResolution =
  | { ok: true; target: HmsReadTarget }
  | { ok: false; reason: 'unknown_transport' | 'inactive_transport' | 'collector_no_hotel' };

/**
 * Mailbox transport → HMS slot/secret/lock. Callers never supply the property: a second
 * argument is ignored so a DV mailbox cannot be steered onto HRCEN.
 */
export function paneStayHmsTargetForTransport(
  transportId: string | null | undefined,
  _callerProperty?: string | null,
): PaneStayHmsTargetResolution {
  const id = typeof transportId === 'string' ? transportId.trim() : '';
  if (!id) return { ok: false, reason: 'unknown_transport' };
  const resolved = resolvePropertyTransport(id);
  if (resolved.kind === 'collector') return { ok: false, reason: 'collector_no_hotel' };
  if (resolved.kind === 'refusal') {
    return { ok: false, reason: resolved.code === 'property_inactive' ? 'inactive_transport' : 'unknown_transport' };
  }
  return { ok: true, target: hmsReadTargetForTransport(id) };
}

const PANE_WRITE_ENV_NAMES = [
  'PANE_WRITE_CREATE',
  'PANE_WRITE_AMEND_UNPAID',
  'PANE_WRITE_AMEND_PAID',
  'PANE_WRITE_CANCEL_UNPAID',
  'PANE_WRITE_CANCEL_PAID',
  'PANE_WRITE_ATTACH',
] as const;

/**
 * The only variables a pane HMS CLI inherits: process basics, CDP endpoint and ownership, credential source, the
 * slot storageState path used to skip a repeat login, the shared save gate, and the per-workflow write
 * switches including attach. Everything else is dropped, so one-off lab flags or database URLs do not reach a live HMS run.
 */
export const PANE_CLI_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'RESERVATIONIST_PANE_SAVE',
  ...PANE_WRITE_ENV_NAMES,
  'AWS_REGION',
  'HMS_READ_SECRET_ARN',
  'HMS_QUOTE_SECRET_PATH',
  'HMS_STAGEHAND_CDP_URL',
  'HMS_STAGEHAND_BROWSER_OWNERSHIP',
  'HMS_SLOT_PROFILE_DIR',
  'HMS_SLOT_STORAGE_STATE',
  'HMS_DAVINCI_CREATE',
] as const;

export const HMS_SLOT_CDP_ENV = {
  centurion: 'HMS_STAGEHAND_CDP_URL',
  davinci: 'HMS_STAGEHAND_CDP_URL_DAVINCI',
} as const;

function isolatedSlotPaneStaySpawnEnv(
  env: NodeJS.ProcessEnv,
  target: HmsReadTarget,
): NodeJS.ProcessEnv {
  const cdpEnvName = HMS_SLOT_CDP_ENV[target.browserSlot];
  const out: NodeJS.ProcessEnv = {};
  for (const name of PANE_CLI_ENV_ALLOWLIST) {
    if (
      name === 'HMS_STAGEHAND_CDP_URL' ||
      name === 'HMS_QUOTE_SECRET_PATH' ||
      name === 'HMS_READ_SECRET_ARN' ||
      name === 'HMS_SLOT_PROFILE_DIR' ||
      name === 'HMS_SLOT_STORAGE_STATE' ||
      (name === 'HMS_DAVINCI_CREATE' && target.browserSlot !== 'davinci')
    ) {
      continue;
    }
    if (env[name] !== undefined) out[name] = env[name];
  }
  out.HMS_READ_SECRET_ARN = target.secretId;
  const cdp = env[cdpEnvName];
  if (cdp) {
    out.HMS_STAGEHAND_CDP_URL = cdp;
    out.HMS_STAGEHAND_BROWSER_OWNERSHIP = 'borrowed';
  }
  return out;
}

/**
 * The environment for a pane HMS CLI (stay-lookup, cancel-stay, create-lab-stay). The http process has no
 * HMS_STAGEHAND_* variables, so the CLIs refuse with CDP_URL_REQUIRED. The installed staff quote configuration names
 * the borrowed browser and the credential file, the same way the staff quote spawner passes them to its CLIs.
 * Variables already set in the environment win, so a local run keeps its own browser.
 * A Da Vinci read target never inherits the Centurion CDP, quote secret file, or slot paths.
 * Write flags (RESERVATIONIST_PANE_SAVE, PANE_WRITE_*, HMS_DAVINCI_CREATE) come from this process env.
 */
export function paneStaySpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  readConfiguration: () => StaffQuoteInstallationConfiguration = readInstalledStaffQuoteConfiguration,
  target: HmsReadTarget,
): NodeJS.ProcessEnv {
  if (HMS_SLOT_CDP_ENV[target.browserSlot] !== 'HMS_STAGEHAND_CDP_URL') {
    return isolatedSlotPaneStaySpawnEnv(env, target);
  }
  const out: NodeJS.ProcessEnv = {};
  for (const name of PANE_CLI_ENV_ALLOWLIST) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  if (out.HMS_STAGEHAND_CDP_URL) return out;
  let configuration: StaffQuoteInstallationConfiguration;
  try {
    configuration = readConfiguration();
  } catch {
    // No installation: the CLI reports CDP_URL_REQUIRED as before.
    return out;
  }
  out.HMS_STAGEHAND_CDP_URL = configuration.owner.cdpUrl;
  out.HMS_STAGEHAND_BROWSER_OWNERSHIP = 'borrowed';
  out.HMS_QUOTE_SECRET_PATH ??= configuration.owner.secretPath;
  return out;
}

/** Logs a pane CLI failure the route otherwise reports only as execution_failure. No input or PII. */
export function warnPaneStaySpawnFailed(mode: string, error: unknown): void {
  const err = (error ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = err.code ?? err.name ?? 'unknown';
  // execFile errors start with "Command failed: node ... --last-name ...". That line carries guest input, so it goes.
  const msg = String(err.message ?? error ?? '')
    .replace(/^Command failed:[^\n]*\n?/, '')
    .replace(/\d{5,}(-\d+)?/g, '<n>')
    .trim()
    .slice(0, 120);
  console.warn('pane_stay_spawn_failed', { mode, code, msg });
}

import {
  readInstalledStaffQuoteConfiguration,
  type StaffQuoteInstallationConfiguration,
} from './staff-quote-installation.js';
import type { HmsReadTarget } from '../hms/hms-read-target.js';

/**
 * The only variables a pane HMS CLI inherits: process basics, CDP endpoint and ownership, credential source, and the
 * shared save gate used by amend-stay.mjs. Everything else is dropped, so one-off lab flags or database URLs do not
 * reach a live HMS run.
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
  'AWS_REGION',
  'HMS_READ_SECRET_ARN',
  'HMS_QUOTE_SECRET_PATH',
  'HMS_STAGEHAND_CDP_URL',
  'HMS_STAGEHAND_BROWSER_OWNERSHIP',
] as const;

let activeHmsReadTarget: HmsReadTarget | null = null;

/** Runs a pane HMS lookup under a job-carried read target. The worker sets this; HTTP writes never see it. */
export async function runWithHmsReadTarget<T>(
  target: HmsReadTarget | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const prev = activeHmsReadTarget;
  activeHmsReadTarget = target ?? null;
  try {
    return await run();
  } finally {
    activeHmsReadTarget = prev;
  }
}

function davinciPaneStaySpawnEnv(env: NodeJS.ProcessEnv, target: HmsReadTarget): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of PANE_CLI_ENV_ALLOWLIST) {
    if (
      name === 'HMS_STAGEHAND_CDP_URL' ||
      name === 'HMS_QUOTE_SECRET_PATH' ||
      name === 'HMS_READ_SECRET_ARN' ||
      name === 'RESERVATIONIST_PANE_SAVE'
    ) {
      continue;
    }
    if (env[name] !== undefined) out[name] = env[name];
  }
  out.HMS_READ_SECRET_ARN = target.secretId;
  const cdp = env.HMS_STAGEHAND_CDP_URL_DAVINCI;
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
 * A Da Vinci read target never inherits the Centurion CDP, quote secret file, or save gate.
 */
export function paneStaySpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
  readConfiguration: () => StaffQuoteInstallationConfiguration = readInstalledStaffQuoteConfiguration,
  target: HmsReadTarget | null = activeHmsReadTarget,
): NodeJS.ProcessEnv {
  if (target?.browserSlot === 'davinci') return davinciPaneStaySpawnEnv(env, target);
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

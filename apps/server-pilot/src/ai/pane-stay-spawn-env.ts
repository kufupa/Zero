import {
  hmsReadTargetForProperty,
  type HmsReadTarget,
} from '../hms/hms-read-target.js';
import { resolvePropertyTransport } from '../../tooling/hms-cloud/property-registry.mjs';
import { propertyCodeSchema, resolvePropertyScope } from '../hms/property-registry.js';

export type PaneStayHmsTargetResolution =
  | { ok: true; target: HmsReadTarget }
  | { ok: false; reason: 'unknown_transport' | 'inactive_transport' | 'collector_no_hotel' | 'property_mismatch' };

/** Resolve the selected property only within the authenticated mailbox group. */
export function paneStayHmsTargetForTransport(
  transportId: string | null | undefined,
  selectedProperty?: string | null,
): PaneStayHmsTargetResolution {
  const id = typeof transportId === 'string' ? transportId.trim() : '';
  if (!id) return { ok: false, reason: 'unknown_transport' };
  const resolved = resolvePropertyTransport(id);
  if (resolved.kind === 'collector') return { ok: false, reason: 'collector_no_hotel' };
  if (resolved.kind === 'refusal') {
    return { ok: false, reason: resolved.code === 'property_inactive' ? 'inactive_transport' : 'unknown_transport' };
  }
  const selected = selectedProperty == null ? undefined : propertyCodeSchema.safeParse(selectedProperty);
  if (selected && !selected.success) return { ok: false, reason: 'property_mismatch' };
  try {
    const code = selected?.data;
    const scope = resolvePropertyScope({ transportId: id, ...(code && code !== 'HRCEN' ? { propertySwitch: code } : {}) });
    if (code && code !== scope.propertyCode) return { ok: false, reason: 'property_mismatch' };
    return { ok: true, target: hmsReadTargetForProperty(scope.propertyCode) };
  } catch { return { ok: false, reason: 'property_mismatch' }; }
}

const PANE_WRITE_ENV_NAMES = [
  'PANE_WRITE_CREATE',
  'PANE_WRITE_AMEND_UNPAID',
  'PANE_WRITE_AMEND_PAID',
  'PANE_WRITE_CANCEL_UNPAID',
  'PANE_WRITE_CANCEL_PAID',
  'PANE_WRITE_ATTACH',
] as const;

/** Cloud subprocesses inherit only runtime credentials, lease configuration and workflow controls. */
export const PANE_CLI_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH',
  'HMS_CHROMIUM_EXECUTABLE_PATH', 'DATABASE_URL', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE',
  'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'HMS_EVIDENCE_HMAC_SECRET_ARN', 'HMS_EVIDENCE_HMAC_KEY_VERSION',
  'HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRCEN',
  'HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAV',
  'HMS_NATIVE_CATALOG_CREDENTIAL_VERSION_HMAC_SHA256_HRDAVS',
  'HMS_DAVINCI_ENABLED_PROPERTIES', 'HMS_DAVINCI_READS', 'HMS_DAVINCI_CREATE', 'HMS_DAVINCI_AMEND',
  'HMS_DAVINCI_CANCEL', 'HMS_DAVINCI_ATTACH', 'HMS_DAVINCI_ADDONS', 'HMS_DAVINCI_GUEST_PROFILE_CREATE',
  'RESERVATIONIST_PANE_SAVE', ...PANE_WRITE_ENV_NAMES,
] as const;

export function paneStaySpawnEnv(env: NodeJS.ProcessEnv, target: HmsReadTarget): NodeJS.ProcessEnv {
  const native = hmsReadTargetForProperty(propertyCodeSchema.parse(target.propertyCode));
  if (native.secretId !== target.secretId || native.origin !== target.origin || native.browserSlot !== target.browserSlot) {
    throw new Error('hms_cloud_target_mismatch');
  }
  return Object.fromEntries(PANE_CLI_ENV_ALLOWLIST.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
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

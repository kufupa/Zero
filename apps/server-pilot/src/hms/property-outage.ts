/**
 * Per-property HMS login outage: park read jobs instead of burning attempts.
 *
 * In-memory only (lost on process restart; the next login-phase failure re-marks).
 * One probe job per property may try every HMS_OUTAGE_PROBE_MS; others requeue.
 * Markers older than HMS_OUTAGE_MAX_MS fall back to today's retry/dead-letter path.
 * Unknown or empty property codes fail closed (never park, never default a hotel).
 */

export const HMS_OUTAGE_FAILURE_CLASS = 'HMS_OUTAGE' as const;
export const HMS_OUTAGE_LAST_ERROR = 'hms_outage' as const;
export const HMS_OUTAGE_PROBE_MS = 5 * 60_000;
export const HMS_OUTAGE_MAX_MS = 12 * 60 * 60_000;
export const HMS_OUTAGE_STAFF_COPY =
  "HMS is down right now (often planned maintenance). Nava will finish this automatically when it's back.";

const LOGIN_PHASES = new Set(['attach', 'login']);
const LOGIN_CODES = new Set(['AUTHENTICATED_SHELL_TIMEOUT']);

type Marker = { sinceMs: number; lastProbeMs: number };

const markers = new Map<string, Marker>();

export type PropertyOutagePark = { kind: 'park'; delayMs: number };
export type PropertyOutageNote = PropertyOutagePark | { kind: 'fallback' };
export type PropertyReadJobDecision =
  | { kind: 'proceed' }
  | PropertyOutagePark
  | { kind: 'expired' };

function propertyKey(propertyCode: string | null | undefined): string | null {
  if (typeof propertyCode !== 'string') return null;
  const code = propertyCode.trim();
  return code.length > 0 ? code : null;
}

function readString(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function isLoginOutageToken(value: string): boolean {
  return LOGIN_CODES.has(value) || /\bAUTHENTICATED_SHELL_TIMEOUT\b/.test(value);
}

function nestedOutageObject(record: object): unknown {
  if ('cause' in record) return (record as { cause: unknown }).cause;
  const nested = (record as { error?: unknown }).error;
  return nested && typeof nested === 'object' ? nested : null;
}

/** True only for login-phase HMS failures (AUTHENTICATED_SHELL_TIMEOUT / attach / login). */
export function classifyHmsLoginOutage(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'string') {
      if (isLoginOutageToken(current)) return true;
      break;
    }
    if (typeof current !== 'object') break;
    const code = readString(current, 'code');
    const phase = readString(current, 'phase');
    const message = readString(current, 'message');
    const errorMessage = readString(current, 'errorMessage');
    const nestedError = readString(current, 'error');
    const reason = readString(current, 'reason');
    if (code && isLoginOutageToken(code)) return true;
    if (phase && LOGIN_PHASES.has(phase)) return true;
    if (message && isLoginOutageToken(message)) return true;
    if (errorMessage && isLoginOutageToken(errorMessage)) return true;
    if (nestedError && isLoginOutageToken(nestedError)) return true;
    if (reason && isLoginOutageToken(reason)) return true;
    current = nestedOutageObject(current);
  }
  return false;
}

function remainingProbeDelay(marker: Marker, nowMs: number): number {
  return Math.max(1, HMS_OUTAGE_PROBE_MS - (nowMs - marker.lastProbeMs));
}

function markerExpired(marker: Marker, nowMs: number): boolean {
  return nowMs - marker.sinceMs > HMS_OUTAGE_MAX_MS;
}

/**
 * Before a read job hits HMS: park if this property is in outage and the probe
 * slot is taken; proceed if none / this job claims the ~5 min probe; expired
 * after 12 h so callers use today's retryOrFail path.
 */
export function decidePropertyReadJob(
  propertyCode: string | null | undefined,
  nowMs: number = Date.now(),
): PropertyReadJobDecision {
  const code = propertyKey(propertyCode);
  if (!code) return { kind: 'proceed' };
  const marker = markers.get(code);
  if (!marker) return { kind: 'proceed' };
  if (markerExpired(marker, nowMs)) return { kind: 'expired' };
  if (nowMs - marker.lastProbeMs >= HMS_OUTAGE_PROBE_MS) {
    marker.lastProbeMs = nowMs;
    return { kind: 'proceed' };
  }
  return { kind: 'park', delayMs: remainingProbeDelay(marker, nowMs) };
}

/** Record a login-phase outage. Unknown property codes fail closed (no marker). */
export function noteLoginOutage(
  propertyCode: string | null | undefined,
  nowMs: number = Date.now(),
): PropertyOutageNote {
  const code = propertyKey(propertyCode);
  if (!code) return { kind: 'fallback' };
  const existing = markers.get(code);
  if (existing && markerExpired(existing, nowMs)) return { kind: 'fallback' };
  if (existing) {
    existing.lastProbeMs = nowMs;
    return { kind: 'park', delayMs: HMS_OUTAGE_PROBE_MS };
  }
  markers.set(code, { sinceMs: nowMs, lastProbeMs: nowMs });
  return { kind: 'park', delayMs: HMS_OUTAGE_PROBE_MS };
}

/** First success for this property clears the outage marker. */
export function clearPropertyOutage(propertyCode: string | null | undefined): void {
  const code = propertyKey(propertyCode);
  if (code) markers.delete(code);
}

export function resetPropertyOutageMarkersForTests(): void {
  markers.clear();
}

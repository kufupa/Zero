/**
 * Server-owned, versioned configuration for prospective mail measurement.
 *
 * This module deliberately contains no mailbox access or message parsing.  A
 * missing or malformed value is represented as unavailable so ordinary mail
 * processing can continue while metrics that require a trusted T0 stay gated.
 */

export const MAIL_MEASUREMENT_CONFIG_VERSION = 1 as const;

export type MailboxMeasurementConfigVersion =
  | typeof MAIL_MEASUREMENT_CONFIG_VERSION
  | 'v1'
  | 'mail-measurement.v1';

export type ConfirmedGapInterval = {
  startAt: string;
  endAt: string;
  reason?: string;
};

export type MailboxMeasurementConfig = {
  version: MailboxMeasurementConfigVersion;
  transportId: string;
  cohortId: string;
  /** Null means the config is valid but no prospective T0 has been confirmed. */
  measurementStartAt: string | null;
  captureAssumptionBasis: string;
  confirmedGapIntervals: readonly ConfirmedGapInterval[];
};

export type MailboxMeasurementConfigUnavailableReason =
  | 'missing'
  | 'invalid_json'
  | 'invalid_shape'
  | 'unsupported_version'
  | 'invalid_timestamp'
  | 'reversed_gap_interval'
  | 'overlapping_gap_intervals';

export type MailboxMeasurementConfigParseResult = {
  status: 'available' | 'unavailable';
  config: MailboxMeasurementConfig | null;
  reason: MailboxMeasurementConfigUnavailableReason | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timestamp(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function supportedVersion(value: unknown): MailboxMeasurementConfigVersion | null {
  if (value === MAIL_MEASUREMENT_CONFIG_VERSION || value === 'v1' || value === 'mail-measurement.v1') {
    return value;
  }
  // JSON configuration commonly serializes a numeric version as a string.
  if (value === '1') return MAIL_MEASUREMENT_CONFIG_VERSION;
  return null;
}

function parseRawValue(raw: unknown): { value: unknown; reason: MailboxMeasurementConfigUnavailableReason | null } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: null, reason: 'missing' };
  }
  if (typeof raw !== 'string') return { value: raw, reason: null };
  try {
    return { value: JSON.parse(raw), reason: null };
  } catch {
    return { value: null, reason: 'invalid_json' };
  }
}

function parseConfigValue(value: unknown): MailboxMeasurementConfigParseResult {
  if (!isRecord(value)) {
    return { status: 'unavailable', config: null, reason: 'invalid_shape' };
  }

  const rawVersion = value.version ?? value.configVersion ?? value.schemaVersion;
  const version = supportedVersion(rawVersion);
  if (!version) {
    return {
      status: 'unavailable',
      config: null,
      reason: rawVersion === undefined ? 'invalid_shape' : 'unsupported_version',
    };
  }

  const transportId = nonEmptyString(value.transportId ?? value.mailboxTransportId);
  const cohortId = nonEmptyString(value.cohortId ?? value.cohort);
  const captureAssumptionBasis = nonEmptyString(
    value.captureAssumptionBasis ?? value.captureAssumption,
  );
  if (!transportId || !cohortId || !captureAssumptionBasis) {
    return { status: 'unavailable', config: null, reason: 'invalid_shape' };
  }

  const rawStart = value.measurementStartAt;
  const measurementStartAt =
    rawStart === undefined || rawStart === null ? null : timestamp(rawStart);
  if (rawStart !== undefined && rawStart !== null && !measurementStartAt) {
    return { status: 'unavailable', config: null, reason: 'invalid_timestamp' };
  }

  const rawGaps = value.confirmedGapIntervals ?? value.gapIntervals ?? value.confirmedGaps ?? [];
  if (!Array.isArray(rawGaps)) {
    return { status: 'unavailable', config: null, reason: 'invalid_shape' };
  }

  const gaps: ConfirmedGapInterval[] = [];
  for (const rawGap of rawGaps) {
    if (!isRecord(rawGap)) {
      return { status: 'unavailable', config: null, reason: 'invalid_shape' };
    }
    const startAt = timestamp(rawGap.startAt ?? rawGap.from);
    const endAt = timestamp(rawGap.endAt ?? rawGap.to);
    if (!startAt || !endAt) {
      return { status: 'unavailable', config: null, reason: 'invalid_timestamp' };
    }
    if (Date.parse(endAt) <= Date.parse(startAt)) {
      return { status: 'unavailable', config: null, reason: 'reversed_gap_interval' };
    }
    const gap: ConfirmedGapInterval = { startAt, endAt };
    const reason = nonEmptyString(rawGap.reason);
    if (reason) gap.reason = reason;
    gaps.push(gap);
  }

  const byStart = [...gaps].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  for (let index = 1; index < byStart.length; index += 1) {
    if (Date.parse(byStart[index - 1]!.endAt) > Date.parse(byStart[index]!.startAt)) {
      return { status: 'unavailable', config: null, reason: 'overlapping_gap_intervals' };
    }
  }

  return {
    status: 'available',
    reason: null,
    config: {
      version,
      transportId,
      cohortId,
      measurementStartAt,
      captureAssumptionBasis,
      confirmedGapIntervals: gaps,
    },
  };
}

/**
 * Parse the optional server-only JSON value.  Invalid and absent input both
 * return null; callers must gate only dependent metrics, not ordinary mail.
 */
export function parseMailboxMeasurementConfig(raw: unknown): MailboxMeasurementConfig | null {
  return parseMailboxMeasurementConfigResult(raw).config;
}

/** Detailed fail-closed result for diagnostics and configuration handoff. */
export function parseMailboxMeasurementConfigResult(
  raw: unknown,
): MailboxMeasurementConfigParseResult {
  const parsed = parseRawValue(raw);
  if (parsed.reason) {
    return { status: 'unavailable', config: null, reason: parsed.reason };
  }
  return parseConfigValue(parsed.value);
}

/** Alias used by callers that refer to the input as mail measurement config. */
export const parseMailMeasurementConfig = parseMailboxMeasurementConfig;

/** A valid config may still intentionally omit T0; this gates prospective metrics. */
export function hasMeasurementStart(config: MailboxMeasurementConfig | null | undefined): boolean {
  return config?.measurementStartAt !== null && config?.measurementStartAt !== undefined;
}

/** Return whether an event lies in one of the explicitly confirmed gap intervals. */
export function isWithinConfirmedGap(
  at: string,
  config: MailboxMeasurementConfig | null | undefined,
): boolean {
  const instant = Date.parse(at);
  if (!Number.isFinite(instant) || !config) return false;
  return config.confirmedGapIntervals.some(
    (gap) => instant >= Date.parse(gap.startAt) && instant < Date.parse(gap.endAt),
  );
}

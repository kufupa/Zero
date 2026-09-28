import { createHash } from 'node:crypto';

export type ConnectedSequenceCaseResult = {
  caseId: string;
  outputPath: string;
  status: string;
  runnerStatus: string;
  actualMatchedIdentitySha256: string | null;
};

export type ConnectedSequenceRuntimeStats = {
  browserLaunches: number;
  contextsCreated: number;
  contextsClosed: number;
};

export type ConnectedSequenceSummary = {
  schemaVersion: 'standalone-connected-sequence/v1';
  sequenceLength: 3;
  sharedRuntime: true;
  freshCaseState: true;
  outputPath: string;
  cases: Array<{
    index: number;
    caseIdSha256: string;
    outputPath: string;
    status: string;
    runnerStatus: string;
    actualMatchedIdentitySha256: string | null;
  }>;
  identityCheck: {
    source: 'actual_matched_search_record';
    recordIdentityChecked: boolean;
    aToBDifferent: boolean;
    aToASame: boolean;
  };
  runtimeStats: ConnectedSequenceRuntimeStats;
};

/** Identity/cleanup gate only; individual tool business completeness is separate. */
export function connectedSequenceIdentityPassed(
  summary: Pick<ConnectedSequenceSummary, 'identityCheck' | 'runtimeStats'>,
): boolean {
  const { identityCheck: check, runtimeStats: stats } = summary;
  return (
    check.recordIdentityChecked &&
    check.aToBDifferent &&
    check.aToASame &&
    stats.browserLaunches === 1 &&
    stats.contextsCreated > 0 &&
    stats.contextsCreated === stats.contextsClosed
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const normalized = String(value).trim().toLowerCase();
    return normalized || null;
  }
  return null;
}

function factValue(record: Record<string, unknown>, field: string): string | null {
  const raw = record[field];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const fact = raw as Record<string, unknown>;
    return scalar(fact.value) ?? scalar(fact.data);
  }
  return scalar(raw);
}

function detailValue(values: Record<string, unknown>, aliases: readonly string[]): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (aliases.includes(key.trim().toLowerCase())) {
      const normalized = scalar(value);
      if (normalized) return normalized;
    }
  }
  return null;
}

/** Hash matched-record identity; context-bound reservationRef is intentionally excluded. */
export function hashConnectedMatchedIdentity(input: {
  match?: unknown;
  detailValues?: Record<string, unknown> | null;
}): string | null {
  const detailValues = input.detailValues;
  if (detailValues) {
    const detailIdentity = [
      [
        'confirmation',
        detailValue(detailValues, ['confirmationnumber', 'confirmation', 'confnumber']),
      ],
      [
        'externalReference',
        detailValue(detailValues, [
          'externalreference',
          'externalreference1',
          'externalconfirmation',
          'extconfirmation',
        ]),
      ],
      ['reservationStayId', detailValue(detailValues, ['reservationstayid', 'id'])],
      ['propertyCode', detailValue(detailValues, ['propertycode', 'property'])],
      ['arrival', detailValue(detailValues, ['arrivaldate', 'arrival', 'startdate'])],
      ['departure', detailValue(detailValues, ['departuredate', 'departure', 'enddate'])],
    ] as const;
    if (detailIdentity.slice(0, 3).some(([, value]) => value !== null)) {
      return hash(JSON.stringify(detailIdentity));
    }
  }

  const match = input.match;
  if (!match || typeof match !== 'object' || Array.isArray(match)) return null;
  const record = match as Record<string, unknown>;
  const matchIdentity = [
    ['referenceKind', factValue(record, 'referenceKind')],
    ['label', factValue(record, 'label')],
    ['status', factValue(record, 'status')],
    ['arrival', factValue(record, 'arrival')],
    ['departure', factValue(record, 'departure')],
    ['roomType', factValue(record, 'roomType')],
  ] as const;
  if (!matchIdentity.some(([, value]) => value !== null)) return null;
  return hash(JSON.stringify(matchIdentity));
}

export function parseConnectedSequenceCasePaths(
  raw: string | undefined,
): [string, string, string] | null {
  if (raw === undefined || raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HMS_CONNECTED_SEQUENCE_CASE_PATHS must be a JSON array of exactly 3 paths');
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new Error('HMS_CONNECTED_SEQUENCE_CASE_PATHS must contain exactly 3 paths');
  }
  if (parsed.some((path) => typeof path !== 'string')) {
    throw new Error('HMS_CONNECTED_SEQUENCE_CASE_PATHS paths must be strings');
  }
  const paths = parsed.map((path) => path.trim());
  if (paths.some((path) => path.length === 0)) {
    throw new Error('HMS_CONNECTED_SEQUENCE_CASE_PATHS paths must be non-empty');
  }
  return paths as [string, string, string];
}

export function buildConnectedSequenceSummary(input: {
  outputPath: string;
  cases: ConnectedSequenceCaseResult[];
  runtimeStats: ConnectedSequenceRuntimeStats;
}): ConnectedSequenceSummary {
  if (input.cases.length !== 3) {
    throw new Error('connected sequence requires exactly 3 completed cases');
  }
  const actualIdentityHashes = input.cases.map((item) => item.actualMatchedIdentitySha256);
  const recordIdentityChecked = actualIdentityHashes.every(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return {
    schemaVersion: 'standalone-connected-sequence/v1',
    sequenceLength: 3,
    sharedRuntime: true,
    freshCaseState: true,
    outputPath: input.outputPath,
    cases: input.cases.map((item, index) => ({
      index: index + 1,
      caseIdSha256: hash(item.caseId),
      outputPath: item.outputPath,
      status: item.status,
      runnerStatus: item.runnerStatus,
      actualMatchedIdentitySha256: item.actualMatchedIdentitySha256,
    })),
    identityCheck: {
      source: 'actual_matched_search_record',
      recordIdentityChecked,
      aToBDifferent: recordIdentityChecked && actualIdentityHashes[0] !== actualIdentityHashes[1],
      aToASame: recordIdentityChecked && actualIdentityHashes[0] === actualIdentityHashes[2],
    },
    runtimeStats: input.runtimeStats,
  };
}

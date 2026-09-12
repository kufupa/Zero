/**
 * Wave 0 expected-vs-actual: Match-field compare for hms_find_reservation.
 * Oracle = projected OSRESS GRID row (or prior oracle.v1.json). Never invent keys.
 */
import { z } from 'zod';

const matchFieldSchema = z.enum([
  'confirmationNumber',
  'externalReference',
  'guestName',
  'arrivalDate',
  'departureDate',
  'reservationStatus',
  'roomType',
  'ratePlan',
  'matchCount',
  'claimKeys.ratePlan',
  'guestName.notSentinel',
]);

export type HmsFindMatchField = z.infer<typeof matchFieldSchema>;

export type HmsFindMatchOracle = {
  confirmationNumber: string | null;
  externalReference: string | null;
  guestName: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  reservationStatus: string | null;
  roomType: string | null;
  /** Always null on find Match DoD — owned by hms_read_reservation. */
  ratePlan: null;
  matchCount: number;
};

export type HmsFindMatchActual = {
  confirmationNumber: string | null;
  externalReference: string | null;
  guestName: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  reservationStatus: string | null;
  roomType: string | null;
  ratePlan: string | null;
  matchCount: number;
  claimKeys: string[];
};

export type HmsFindCompareRow = {
  field: HmsFindMatchField;
  expected: string | null | number | boolean;
  actual: string | null | number | boolean;
  required: boolean;
  pass: boolean;
};

export type HmsFindCompareV1 = {
  schemaVersion: 1;
  toolId: 'hms_find_reservation';
  allRequiredPass: boolean;
  rows: HmsFindCompareRow[];
};

function isSentinelGuestName(value: string | null): boolean {
  if (value == null) return false;
  return /^-?\d+$/.test(value.trim());
}

function eqNullable(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Compare Match DoD fields. ratePlan must stay unclaimed on find.
 * roomType may be null when GRID lacks roomtype (oracle.roomType null).
 */
export function compareHmsFindMatch(
  oracle: HmsFindMatchOracle,
  actual: HmsFindMatchActual,
): HmsFindCompareV1 {
  const rows: HmsFindCompareRow[] = [];

  const push = (
    field: HmsFindMatchField,
    expected: string | null | number | boolean,
    actualValue: string | null | number | boolean,
    required: boolean,
    pass: boolean,
  ) => {
    rows.push({ field, expected, actual: actualValue, required, pass });
  };

  push(
    'confirmationNumber',
    oracle.confirmationNumber,
    actual.confirmationNumber,
    true,
    eqNullable(oracle.confirmationNumber, actual.confirmationNumber),
  );
  push(
    'externalReference',
    oracle.externalReference,
    actual.externalReference,
    false,
    eqNullable(oracle.externalReference, actual.externalReference),
  );
  push(
    'guestName',
    oracle.guestName,
    actual.guestName,
    Boolean(oracle.guestName),
    eqNullable(oracle.guestName, actual.guestName),
  );
  push(
    'guestName.notSentinel',
    true,
    !isSentinelGuestName(actual.guestName),
    true,
    !isSentinelGuestName(actual.guestName),
  );
  push(
    'arrivalDate',
    oracle.arrivalDate,
    actual.arrivalDate,
    Boolean(oracle.arrivalDate),
    eqNullable(oracle.arrivalDate, actual.arrivalDate),
  );
  push(
    'departureDate',
    oracle.departureDate,
    actual.departureDate,
    Boolean(oracle.departureDate),
    eqNullable(oracle.departureDate, actual.departureDate),
  );
  push(
    'reservationStatus',
    oracle.reservationStatus,
    actual.reservationStatus,
    Boolean(oracle.reservationStatus),
    eqNullable(oracle.reservationStatus, actual.reservationStatus),
  );
  push(
    'roomType',
    oracle.roomType,
    actual.roomType,
    false,
    eqNullable(oracle.roomType, actual.roomType),
  );
  push('ratePlan', null, actual.ratePlan, true, actual.ratePlan == null);
  push(
    'claimKeys.ratePlan',
    false,
    actual.claimKeys.includes('matches.0.ratePlan'),
    true,
    !actual.claimKeys.includes('matches.0.ratePlan'),
  );
  push(
    'matchCount',
    oracle.matchCount,
    actual.matchCount,
    true,
    oracle.matchCount === actual.matchCount,
  );

  return {
    schemaVersion: 1,
    toolId: 'hms_find_reservation',
    allRequiredPass: rows.every((r) => !r.required || r.pass),
    rows,
  };
}

/** Project GRID DATA[0]-shaped row (+ composed guestName) into Match oracle. */
export function oracleFromOsressGridRow(row: {
  confirmationnumber?: unknown;
  externalconfirmation?: unknown;
  primaryguest?: unknown;
  lastname?: unknown;
  firstname?: unknown;
  arrivaldate?: unknown;
  departuredate?: unknown;
  status?: unknown;
  roomtype?: unknown;
  rateplan?: unknown;
}): HmsFindMatchOracle {
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const t = String(v).trim();
    return t.length > 0 ? t : null;
  };
  const primary = str(row.primaryguest);
  const last = str(row.lastname);
  const first = str(row.firstname);
  let guestName: string | null = null;
  if (primary && !/^-?\d+$/.test(primary)) guestName = primary;
  else if (last && first) guestName = `${last}, ${first}`;
  else guestName = last ?? first;

  return {
    confirmationNumber: str(row.confirmationnumber),
    externalReference: str(row.externalconfirmation),
    guestName,
    arrivalDate: str(row.arrivaldate),
    departureDate: str(row.departuredate),
    reservationStatus: str(row.status),
    roomType: str(row.roomtype),
    ratePlan: null,
    matchCount: 1,
  };
}

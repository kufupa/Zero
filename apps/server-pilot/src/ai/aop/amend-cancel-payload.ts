import { z } from 'zod';

/** CLI flag names only. Never import, require, spawn or call the Playwright scripts. */
export const AMEND_FIELDS = ['arrival', 'departure', 'adults', 'children', 'roomType'] as const;
export const AMEND_ROOM_TYPES = [
  'STQN',
  'STWN',
  'SKNG',
  'EXKNG',
  'LUXKNG',
  'SUITE',
  'DLXKNG',
  'DLXQN',
  'DLXTWN',
] as const;
export const CONFIRMATION_NUMBER = /^\d{6,10}-\d{1,2}$/;
export const AMEND_REQUEST_PATH = 'amend-request.json';
export const AMEND_OUT_DIR = 'amend-out';
export const CANCEL_OUT_DIR = 'cancel-out';
export const CANCEL_REASON = 'Test Reservations';
export const LAB_ARRIVAL_FLOOR = '2027-01-01';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMEND_FIELD_SET = new Set<string>(AMEND_FIELDS);
const ROOM_TYPE_SET = new Set<string>(AMEND_ROOM_TYPES);

const changeSchema = z.object({
  field: z.string(),
  to: z.union([z.string(), z.number()]),
});

export const amendCancelPayloadInputSchema = z.object({
  kind: z.enum(['amend', 'cancel']),
  confirmationNumber: z.string(),
  lastName: z.string(),
  changes: z.array(changeSchema).optional(),
});
export type AmendCancelPayloadInput = z.infer<typeof amendCancelPayloadInputSchema>;

const amendRequestBodySchema = z.object({
  confirmation: z.string(),
  expectedLastName: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type AmendRequestBody = z.infer<typeof amendRequestBodySchema>;

export const amendCancelPayloadOutputSchema = z.object({
  tool: z.enum(['hms_amend_reservation', 'hms_cancel_reservation']),
  script: z.enum(['amend-stay.mjs', 'cancel-stay.mjs']),
  args: z.array(z.string()),
  request: amendRequestBodySchema.nullable(),
  requiresApproval: z.literal(true),
  screenshotReview: z.literal(true),
  executed: z.literal(false),
  refusals: z.array(z.string()),
});
export type AmendCancelPayloadOutput = z.infer<typeof amendCancelPayloadOutputSchema>;

export const amendCancelPayloadDescription =
  'Build preview CLI argv for amend-stay.mjs or cancel-stay.mjs from a confirmation number, last name, and field changes. Call after the agent chooses workflow amend or cancel and has a confirmation number. For amend, also returns the JSON body the wrapper must write to the --request path before invoking the script. Never runs HMS. Staff must approve, then review screenshots. Refuse (empty args, request null) on a missing or invalid confirmation (NNNNNN-N, whole token) or an unsupported change field.';

export const buildAmendCancelPayloadInputSchema = amendCancelPayloadInputSchema;
export const buildAmendCancelPayloadOutputSchema = amendCancelPayloadOutputSchema;
export const buildAmendCancelPayloadDescription = amendCancelPayloadDescription;

function shell(
  kind: AmendCancelPayloadInput['kind'],
  refusals: string[],
  args: string[] = [],
  request: AmendRequestBody | null = null,
): AmendCancelPayloadOutput {
  const amend = kind === 'amend';
  const blocked = refusals.length > 0;
  return {
    tool: amend ? 'hms_amend_reservation' : 'hms_cancel_reservation',
    script: amend ? 'amend-stay.mjs' : 'cancel-stay.mjs',
    args: blocked ? [] : args,
    request: blocked ? null : request,
    requiresApproval: true,
    screenshotReview: true,
    executed: false,
    refusals,
  };
}

function realIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function occupancy(value: unknown, field: 'adults' | 'children'): boolean {
  // Number('') is 0, so a blank or non-decimal string must refuse rather than request zero guests.
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return false;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 16) return false;
  return field !== 'adults' || n >= 1;
}

function confirmationRefusals(confirmationNumber: string): string[] {
  const trimmed = confirmationNumber.trim();
  if (!trimmed) return ['confirmation_missing'];
  if (!CONFIRMATION_NUMBER.test(trimmed)) return ['confirmation_invalid'];
  return [];
}

function fieldValue(row: { field: string; to: string | number }): string | number {
  if (row.field === 'adults' || row.field === 'children') {
    return typeof row.to === 'number' ? row.to : Number(row.to);
  }
  return String(row.to);
}

function amendRequestFields(changes: NonNullable<AmendCancelPayloadInput['changes']>): AmendRequestBody['fields'] {
  const fields: AmendRequestBody['fields'] = {};
  for (const row of changes) {
    if (!AMEND_FIELD_SET.has(row.field)) continue;
    fields[row.field] = fieldValue(row);
  }
  return fields;
}

function amendRefusals(changes: AmendCancelPayloadInput['changes']): string[] {
  const rows = changes ?? [];
  if (rows.length === 0) return ['fields_required'];
  const refusals: string[] = [];
  const seen = new Set<string>();
  let arrival: string | null = null;
  let departure: string | null = null;
  for (const row of rows) {
    if (!AMEND_FIELD_SET.has(row.field)) {
      refusals.push(`unsupported_field:${row.field}`);
      continue;
    }
    if (seen.has(row.field)) {
      refusals.push(`repeated_field:${row.field}`);
      continue;
    }
    seen.add(row.field);
    const value = String(row.to);
    if (row.field === 'arrival' || row.field === 'departure') {
      if (!realIsoDate(value)) refusals.push('date_invalid');
      else if (row.field === 'arrival' && value < LAB_ARRIVAL_FLOOR) refusals.push('target_arrival_before_2027');
      else if (row.field === 'arrival') arrival = value;
      else departure = value;
    } else if (row.field === 'adults' || row.field === 'children') {
      if (!occupancy(row.to, row.field)) refusals.push('count_invalid');
    } else if (row.field === 'roomType' && !ROOM_TYPE_SET.has(value)) {
      refusals.push('room_type_invalid');
    }
  }
  if (arrival && departure && departure <= arrival) refusals.push('departure_not_after_arrival');
  return refusals;
}

function cancelRefusals(changes: AmendCancelPayloadInput['changes']): { refusals: string[]; arrival: string | null } {
  const rows = changes ?? [];
  const refusals: string[] = [];
  let arrival: string | null = null;
  let sawArrival = false;
  for (const row of rows) {
    if (row.field !== 'arrival') {
      refusals.push(`unsupported_field:${row.field}`);
      continue;
    }
    if (sawArrival) {
      refusals.push('repeated_field:arrival');
      continue;
    }
    sawArrival = true;
    const value = String(row.to);
    if (!realIsoDate(value)) refusals.push('date_invalid');
    else if (value < LAB_ARRIVAL_FLOOR) refusals.push('target_arrival_before_2027');
    else arrival = value;
  }
  if (!arrival && !refusals.includes('date_invalid') && !refusals.some((row) => row.startsWith('unsupported_field') || row.startsWith('repeated_field'))) {
    refusals.push('missing_arrival');
  }
  return { refusals, arrival };
}

export function buildAmendCancelPayload(input: AmendCancelPayloadInput): AmendCancelPayloadOutput {
  const parsed = amendCancelPayloadInputSchema.parse(input);
  const kind = parsed.kind;
  const refusals = confirmationRefusals(parsed.confirmationNumber);
  if (kind === 'amend') {
    refusals.push(...amendRefusals(parsed.changes));
    // A blank expectedLastName would let the amend wrapper skip its name check on a write path.
    if (!parsed.lastName.trim()) refusals.push('last_name_missing');
    if (refusals.length > 0) return shell(kind, refusals);
    const request: AmendRequestBody = {
      confirmation: parsed.confirmationNumber.trim(),
      expectedLastName: parsed.lastName.trim(),
      fields: amendRequestFields(parsed.changes ?? []),
    };
    return shell(kind, [], ['--request', AMEND_REQUEST_PATH, '--mode', 'preview', '--out', AMEND_OUT_DIR], request);
  }
  const cancel = cancelRefusals(parsed.changes);
  refusals.push(...cancel.refusals);
  if (refusals.length > 0 || !cancel.arrival) return shell(kind, refusals.length > 0 ? refusals : ['missing_arrival']);
  const args = [
    '--confirmation',
    parsed.confirmationNumber.trim(),
    '--arrival',
    cancel.arrival,
    '--mode',
    'preview',
    '--out',
    CANCEL_OUT_DIR,
    '--reason',
    CANCEL_REASON,
  ];
  const lastName = parsed.lastName.trim();
  if (lastName) args.push('--last-name', lastName);
  return shell(kind, [], args);
}

export const amendCancelPayload = buildAmendCancelPayload;

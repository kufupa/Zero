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

export const amendCancelPayloadOutputSchema = z.object({
  tool: z.enum(['hms_amend_reservation', 'hms_cancel_reservation']),
  script: z.enum(['amend-stay.mjs', 'cancel-stay.mjs']),
  args: z.array(z.string()),
  requiresApproval: z.literal(true),
  screenshotReview: z.literal(true),
  executed: z.literal(false),
  refusals: z.array(z.string()),
});
export type AmendCancelPayloadOutput = z.infer<typeof amendCancelPayloadOutputSchema>;

export const amendCancelPayloadDescription =
  'Build preview CLI argv for amend-stay.mjs or cancel-stay.mjs from a confirmation number, last name, and field changes. Call after the agent chooses workflow amend or cancel and has a confirmation number. Returns args only; never runs HMS. Staff must approve, then review screenshots. Refuse (empty args) on a missing or invalid confirmation (NNNNNN-N) or an unsupported change field.';

export const buildAmendCancelPayloadInputSchema = amendCancelPayloadInputSchema;
export const buildAmendCancelPayloadOutputSchema = amendCancelPayloadOutputSchema;
export const buildAmendCancelPayloadDescription = amendCancelPayloadDescription;

function shell(kind: AmendCancelPayloadInput['kind'], refusals: string[], args: string[] = []): AmendCancelPayloadOutput {
  const amend = kind === 'amend';
  return {
    tool: amend ? 'hms_amend_reservation' : 'hms_cancel_reservation',
    script: amend ? 'amend-stay.mjs' : 'cancel-stay.mjs',
    args: refusals.length > 0 ? [] : args,
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

function amendRefusals(changes: AmendCancelPayloadInput['changes']): string[] {
  const rows = changes ?? [];
  if (rows.length === 0) return ['fields_required'];
  const refusals: string[] = [];
  const seen = new Set<string>();
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
    } else if (row.field === 'adults' || row.field === 'children') {
      if (!occupancy(row.to, row.field)) refusals.push('count_invalid');
    } else if (row.field === 'roomType' && !ROOM_TYPE_SET.has(value)) {
      refusals.push('room_type_invalid');
    }
  }
  return refusals;
}

function cancelRefusals(changes: AmendCancelPayloadInput['changes']): { refusals: string[]; arrival: string | null } {
  const rows = changes ?? [];
  const refusals: string[] = [];
  let arrival: string | null = null;
  for (const row of rows) {
    if (row.field !== 'arrival') {
      refusals.push(`unsupported_field:${row.field}`);
      continue;
    }
    const value = String(row.to);
    if (!realIsoDate(value)) refusals.push('date_invalid');
    else if (value < LAB_ARRIVAL_FLOOR) refusals.push('target_arrival_before_2027');
    else arrival = value;
  }
  if (!arrival && !refusals.includes('date_invalid') && !refusals.some((row) => row.startsWith('unsupported_field'))) {
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
    if (refusals.length > 0) return shell(kind, refusals);
    return shell(kind, [], ['--request', AMEND_REQUEST_PATH, '--mode', 'preview', '--out', AMEND_OUT_DIR]);
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

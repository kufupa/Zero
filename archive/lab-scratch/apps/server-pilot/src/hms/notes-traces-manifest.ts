/**
 * Exact, read-only Guest Stay Traces request policy.
 *
 * The request shape is from the A9 OSRESV.TRC soft-open.  It is issued only
 * after the caller has correlated one OSRESS row, so confirmation and stay id
 * are fixed values here rather than caller-controlled variable fields.
 */
import { z } from 'zod';
import {
  requestPolicyManifestSchema,
  type RequestPolicyManifest,
  type RequestRule,
} from '../../../../../../apps/server-pilot/src/hms/contracts.js';
import {
  buildBoundFolioReadFields,
  type ValidatedFolioDetailValues,
} from '../../../../../../apps/server-pilot/src/hms/folio-read-facade.js';

export const NOTES_TRACES_READ_PATH = '/web/base/OSRESV.TRC';
export const LIVE_NOTES_TRACES_READ_PATH = NOTES_TRACES_READ_PATH;
export const NOTES_INQUIRY_READ_PATH = '/api/booking/HRCEN/notesInquiry';
export const LIVE_NOTES_INQUIRY_READ_PATH = NOTES_INQUIRY_READ_PATH;

const boundPmsValueSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'expected a bounded correlated PMS value');

export const notesTracesReadBindingSchema = z
  .object({
    origin: z.string().url(),
    confirmationNumber: boundPmsValueSchema,
    reservationStayId: boundPmsValueSchema,
  })
  .strict();

export type NotesTracesReadBinding = z.infer<typeof notesTracesReadBindingSchema>;

/**
 * Build exact bound OSRESV.TRC POST from the already-correlated FOL detail.
 * FOL and TRC share all reviewed detail fields; only tab changes to TRC.
 */
export function buildBoundNotesTracesReadRule(input: {
  origin: string;
  confirmationNumber: string;
  reservationStayId: string;
  detailValues: ValidatedFolioDetailValues;
}): RequestRule {
  const binding = notesTracesReadBindingSchema.parse({
    origin: input.origin,
    confirmationNumber: input.confirmationNumber,
    reservationStayId: input.reservationStayId,
  });
  if (!input.detailValues || typeof input.detailValues !== 'object') {
    throw new Error('bound OSRESV.TRC detail values are required');
  }
  const fixedBody = buildBoundFolioReadFields({
    confirmationNumber: binding.confirmationNumber,
    reservationStayId: binding.reservationStayId,
    expectedPropertyCode: 'HRCEN',
    detailValues: input.detailValues,
  });
  fixedBody.CURRENT_TAB_NAME = 'TRC';
  return {
    id: 'live-osresv-trc-read',
    origin: binding.origin,
    method: 'POST',
    path: NOTES_TRACES_READ_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    fixedBody,
    variableBody: {},
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

export const notesInquiryReadBindingSchema = z
  .object({
    origin: z.string().url(),
    confirmationNumber: boundPmsValueSchema,
  })
  .strict();

export type NotesInquiryReadBinding = z.infer<typeof notesInquiryReadBindingSchema>;

/**
 * Legacy diagnostic-only TRC shape. Live callers must use the exact detail-
 * bound builder above; this remains for old fixture/policy compatibility.
 */
export function buildNotesTracesReadRule(input: NotesTracesReadBinding): RequestRule {
  const binding = notesTracesReadBindingSchema.parse(input);
  return {
    id: 'live-osresv-trc-read',
    origin: binding.origin,
    method: 'POST',
    path: NOTES_TRACES_READ_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/x-www-form-urlencoded',
    fixedQuery: {},
    variableQuery: {},
    fixedBody: {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'TRC',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      propertycode: 'HRCEN',
      confirmationnumber: binding.confirmationNumber,
      reservationstayid: binding.reservationStayId,
      id: binding.reservationStayId,
    },
    variableBody: {},
    maxBodyBytes: 16_384,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Build exact JSON notes inquiry bound to one already-correlated confirmation. */
export function buildNotesInquiryReadRule(
  origin: string,
  confirmationNumber: string,
): RequestRule {
  const binding = notesInquiryReadBindingSchema.parse({ origin, confirmationNumber });
  return {
    id: 'live-notes-inquiry-read',
    origin: binding.origin,
    method: 'POST',
    path: NOTES_INQUIRY_READ_PATH,
    resourceTypes: ['xhr', 'fetch'],
    contentType: 'application/json',
    fixedQuery: {},
    variableQuery: {},
    fixedBody: { confirmationNumber: binding.confirmationNumber },
    variableBody: {},
    maxBodyBytes: 256,
    redirectPolicy: 'same-reviewed-chain',
  };
}

/** Exact-bound manifest for one already-correlated reservation row. */
export function buildNotesTracesReadManifest(
  input: NotesTracesReadBinding,
): RequestPolicyManifest {
  return requestPolicyManifestSchema.parse({
    rules: [buildNotesTracesReadRule(input)],
  });
}

/** Short alias for callers naming the surface rather than the tool action. */
export const buildNotesTracesManifest = buildNotesTracesReadManifest;

/** Closed lab review schemas. Human-visible Infor fields, not runtime {candidateId}. */

export type JsonSchemaLike = {
  title?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  $defs?: Record<string, JsonSchemaLike>;
};

export const LAB_FREEZE_TOOL_IDS = [
  'hms_find_reservation',
  'hms_read_reservation',
  'hms_read_notes_traces',
  'mail.send_with_attachments',
  'hms_attach_guest_stay_document',
  'hms_list_documents',
  'mail_read_artifact',
  'documents_read_existing',
  'documents_list_existing',
  'hms_send_reservation_confirmation',
  'hms_quote_stay',
  'hms_generate_confirmation_proforma',
  'hms_generate_quote_document',
  'hms_group_block_read',
  'hms_amend_reservation',
  'hms_create_reservation',
  'hms_cancel_reservation',
  'hms_read_folio',
  'hms_post_payment',
  'hms_generate_invoice',
  'hms_email_folio',
  'hms_refund',
  'hms_company_account_read',
  'hms_event_read',
  'property_read_knowledge',
  'mail_parse_channel_payload',
  'hms_sent_email_audit',
] as const;

export type LabFreezeToolId = (typeof LAB_FREEZE_TOOL_IDS)[number];

export type LabReviewSchema = {
  title: string;
  input: JsonSchemaLike;
  output: JsonSchemaLike;
};

function fields(keys: readonly string[], required: readonly string[] = []): JsonSchemaLike {
  return {
    required: [...required],
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
  };
}

const documentList: LabReviewSchema = {
  title: 'List documents',
  input: fields(['confirmationNumber', 'docType']),
  output: fields(['attachmentName', 'docType', 'confirmationNumber', 'amount', 'status']),
};

export const EMPTY_LAB_REVIEW_SCHEMA: LabReviewSchema = {
  title: 'Unknown tool',
  input: { properties: {}, required: [] },
  output: { properties: {}, required: [] },
};

export const LAB_REVIEW_SCHEMAS: Record<LabFreezeToolId, LabReviewSchema> = {
  hms_find_reservation: {
    title: 'Find reservation',
    input: fields(['confirmationNumber', 'guestName', 'arrival', 'departure']),
    output: fields(['confirmationNumber', 'status', 'roomType']),
  },
  hms_read_reservation: {
    title: 'Read reservation',
    input: fields(['confirmationNumber']),
    output: fields([
      'confirmationNumber',
      'guestName',
      'arrival',
      'departure',
      'adults',
      'children',
      'occupancy',
      'roomQty',
      'roomType',
      'rateCode',
      'status',
      'groupName',
    ]),
  },
  hms_read_notes_traces: {
    title: 'Notes and traces',
    input: fields(['confirmationNumber', 'guestName']),
    output: fields(['guestName', 'status']),
  },
  'mail.send_with_attachments': {
    title: 'Send with attachments',
    input: fields(['attachmentName', 'docType']),
    output: fields(['attachmentName', 'docType']),
  },
  hms_attach_guest_stay_document: {
    title: 'Attach guest stay document',
    input: fields(['confirmationNumber', 'attachmentName', 'docType']),
    output: fields(['confirmationNumber', 'attachmentName', 'docType', 'status']),
  },
  hms_list_documents: documentList,
  mail_read_artifact: {
    title: 'Read mail artifact',
    input: fields(['attachmentName', 'docType']),
    output: fields(['attachmentName', 'docType', 'arrival', 'departure', 'guestName', 'amount']),
  },
  documents_read_existing: {
    title: 'Read existing document',
    input: fields(['confirmationNumber', 'docType', 'attachmentName']),
    output: fields(['docType', 'amount', 'confirmationNumber', 'guestName', 'arrival', 'departure', 'status']),
  },
  documents_list_existing: documentList,
  hms_send_reservation_confirmation: {
    title: 'Send reservation confirmation',
    input: fields(['confirmationNumber', 'guestName', 'attachmentName', 'docType']),
    output: fields(['confirmationNumber', 'guestName', 'attachmentName', 'docType', 'status']),
  },
  hms_quote_stay: {
    title: 'Hotel Availability quote',
    input: fields(
      ['arrival', 'departure', 'adults', 'children', 'occupancy', 'roomQty', 'roomType', 'bedPreference', 'rateCode'],
      ['arrival', 'departure'],
    ),
    output: fields(['arrival', 'departure', 'roomType', 'rateCode', 'rateQuoted', 'amount', 'occupancy', 'status']),
  },
  hms_generate_confirmation_proforma: {
    title: 'Generate confirmation / proforma',
    input: fields(['confirmationNumber', 'docType']),
    output: fields(['confirmationNumber', 'docType', 'arrival', 'departure', 'guestName', 'amount']),
  },
  hms_generate_quote_document: {
    title: 'Generate quote document',
    input: fields(['arrival', 'departure', 'roomType', 'occupancy', 'docType']),
    output: fields(['arrival', 'departure', 'roomType', 'rateQuoted', 'amount', 'occupancy', 'docType']),
  },
  hms_group_block_read: {
    title: 'Group block read',
    input: fields(['groupName', 'arrival', 'departure']),
    output: fields([
      'groupName',
      'arrival',
      'departure',
      'roomType',
      'roomQty',
      'occupancy',
      'rateQuoted',
      'amount',
      'status',
      'guestName',
    ]),
  },
  hms_amend_reservation: {
    title: 'Amend reservation',
    input: fields([
      'confirmationNumber',
      'arrival',
      'departure',
      'adults',
      'children',
      'occupancy',
      'roomQty',
      'roomType',
      'rateCode',
    ]),
    output: fields(['confirmationNumber', 'status', 'arrival', 'departure', 'roomType']),
  },
  hms_create_reservation: {
    title: 'Create reservation',
    input: fields(
      [
        'arrival',
        'departure',
        'adults',
        'sourceOfBusiness',
        'roomType',
        'ratePlan',
        'track',
        'firstName',
        'lastName',
        'nights',
        'children',
        'guaranteeType',
        'reservationNote',
        'settlementType',
        'title',
        'phone',
        'email',
        'group',
        'reasonForStay',
      ],
      ['arrival', 'departure', 'adults', 'sourceOfBusiness', 'roomType', 'ratePlan', 'track', 'firstName', 'lastName'],
    ),
    output: fields(['confirmationNumber', 'status', 'room', 'ratePlan', 'mealPlan']),
  },
  hms_cancel_reservation: {
    title: 'Cancel reservation',
    input: fields(['confirmationNumber', 'cancelReason'], ['confirmationNumber', 'cancelReason']),
    output: fields(['confirmationNumber', 'cancelReason', 'amount', 'status']),
  },
  hms_read_folio: {
    title: 'Read folio',
    input: fields(['confirmationNumber']),
    output: fields(['amount', 'status', 'confirmationNumber', 'docType']),
  },
  hms_post_payment: {
    title: 'Post payment',
    input: fields(['confirmationNumber', 'amount', 'docType']),
    output: fields(['amount', 'confirmationNumber', 'docType', 'status']),
  },
  hms_generate_invoice: {
    title: 'Generate invoice',
    input: fields(['confirmationNumber', 'docType']),
    output: fields(['docType', 'amount', 'confirmationNumber', 'guestName']),
  },
  hms_email_folio: {
    title: 'Email folio',
    input: fields(['confirmationNumber', 'amount', 'docType']),
    output: fields(['amount', 'docType', 'confirmationNumber', 'status']),
  },
  hms_refund: {
    title: 'Refund',
    input: fields(['confirmationNumber', 'amount', 'cancelReason']),
    output: fields(['amount', 'confirmationNumber', 'cancelReason', 'status']),
  },
  hms_company_account_read: {
    title: 'Company account read',
    input: fields(['confirmationNumber', 'groupName']),
    output: fields(['groupName', 'status', 'amount']),
  },
  hms_event_read: {
    title: 'Event read',
    input: fields(['groupName', 'arrival', 'departure']),
    output: fields(['groupName', 'arrival', 'departure', 'paxTotal', 'amount', 'status', 'docType']),
  },
  property_read_knowledge: {
    title: 'Property knowledge',
    input: fields(['topic']),
    output: fields(['status']),
  },
  mail_parse_channel_payload: {
    title: 'Parse channel payload',
    input: fields(['confirmationNumber', 'guestName', 'arrival', 'departure', 'status']),
    output: fields(['confirmationNumber', 'guestName', 'arrival', 'departure', 'status']),
  },
  hms_sent_email_audit: {
    title: 'Sent email audit',
    input: fields(['confirmationNumber']),
    output: fields(['attachmentName', 'docType', 'confirmationNumber', 'status']),
  },
};

export function labReviewSchemaFor(tool: string): LabReviewSchema {
  return LAB_REVIEW_SCHEMAS[tool as LabFreezeToolId] ?? EMPTY_LAB_REVIEW_SCHEMA;
}

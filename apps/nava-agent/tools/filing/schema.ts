/** Input for the generic hms_prepare dispatcher and the filing preflight tool. */
export const filingPrepareSchema: {
  type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean;
} = {
  type: 'object',
  properties: {
    workflow: { type: 'string', enum: ['filing'] },
    booking: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        property_code: { type: 'string' },
        reservation_id: { type: ['string', 'null'] },
        current_state: { type: ['object', 'null'] },
        fields: { type: 'object' },
      },
      required: ['id', 'property_code', 'reservation_id', 'current_state', 'fields'],
      additionalProperties: false,
    },
    action: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['filing', 'attach_document', 'voucher_submission', 'payment_proof_submission'] },
        booking_ids: { type: 'array', items: { type: 'string' } },
        details: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            attachment_id: { type: 'string' },
            attachment_handle: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['message_id', 'attachment_id', 'attachment_handle'],
          additionalProperties: false,
        },
      },
      required: ['id', 'type', 'booking_ids', 'details'],
      additionalProperties: false,
    },
  },
  required: ['workflow', 'booking', 'action'],
  additionalProperties: false,
};

/** The listing has its own schema so staff can inspect a stay without PDF bytes. */
export const filingDocumentsSchema: {
  type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean;
} = {
  type: 'object',
  properties: { booking: filingPrepareSchema.properties.booking },
  required: ['booking'],
  additionalProperties: false,
};
